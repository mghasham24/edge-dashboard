import { getSessionOrCron } from '../../_lib/auth.js';
// functions/api/fd/mlb.js
// Fetches FanDuel real-time MLB moneyline odds via FD's native API
// Step 1: Get today's MLB event IDs from content-managed-page
// Step 2: Fetch event-page per game to collect MONEY_LINE market IDs + runner names
// Step 3: Batch POST to getMarketPrices for real-time prices

const FD_AK         = 'FhMFpcPWXMeyZxOx';
// Primary: FD competition events endpoint (returns ALL MLB games, competition ID 91)
// Fallback: content-managed pages (curated/featured games only)
const FD_LIST_URLS  = [
  `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=COMPETITION&competitionId=91&_ak=${FD_AK}&timezone=America/New_York`,
  `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=mlb-game-lines&_ak=${FD_AK}&timezone=America/New_York`,
  `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=mlb&_ak=${FD_AK}&timezone=America/New_York`
];
const FD_EVENT_URL  = (id) => `https://sbapi.nj.sportsbook.fanduel.com/api/event-page?_ak=${FD_AK}&eventId=${id}&tab=all&timezone=America/New_York`;
const FD_PRICES_URL = 'https://smp.nj.sportsbook.fanduel.com/api/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=0';
const ML_TYPE       = 'MONEY_LINE';
const CACHE_TTL     = 5;

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

function parseEventName(name) {
  // Strip all parentheticals (pitchers, labels) — game numbers are assigned by time ordering
  const cleaned = name.replace(/\s*\([^)]*\)/g, '').trim();
  const m = cleaned.match(/^(.+?)\s*@\s*(.+?)\s*$/);
  if (!m) return null;
  return { away: m[1].trim(), home: m[2].trim() };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSessionOrCron(request, env);
  if (!session) return fail(401, 'Not authenticated');

  const reqUrl = new URL(request.url);
  const debugMode = reqUrl.searchParams.get('debug');

  const now = Math.floor(Date.now() / 1000);
  const cacheKey = 'fd_mlb';

  if (!debugMode) {
    try {
      const cached = await env.DB.prepare(
        'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
      ).bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < CACHE_TTL) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
      }
    } catch(e) {}
  }

  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
  };

  try {
    // Fetch event lists from all URLs in parallel with 8s timeout each, then merge (dedup by eventId)
    const nowMs = Date.now();
    const allEvents = {};
    const urlDebug = [];
    const listResults = await Promise.all(FD_LIST_URLS.map(async (url) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const listRes = await fetch(url, { headers, signal: ctrl.signal });
        clearTimeout(timer);
        if (!listRes.ok) return { url, status: listRes.status, evts: {} };
        const listData = await listRes.json();
        return { url, status: listRes.status, evts: listData?.attachments?.events || {} };
      } catch(e) {
        clearTimeout(timer);
        return { url, err: e.message, evts: {} };
      }
    }));
    listResults.forEach(({ url, status, evts, err }) => {
      const before = Object.keys(allEvents).length;
      Object.entries(evts).forEach(([id, e]) => { if (!allEvents[id]) allEvents[id] = e; });
      urlDebug.push(err ? { url, err } : { url, status, count: Object.keys(evts).length, added: Object.keys(allEvents).length - before });
    });

    if (debugMode === '1') {
      const nowMs2 = Date.now();
      const all = Object.values(allEvents).map(e => ({ name: e.name, openDate: e.openDate, msSinceOpen: nowMs2 - new Date(e.openDate).getTime() }));
      return new Response(JSON.stringify({ urlDebug, total: all.length, events: all }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (!Object.keys(allEvents).length) return fail(502, 'FD MLB list fetch failed');

    const etFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
    const todayET     = etFmt.format(new Date());
    const yesterdayET = etFmt.format(new Date(nowMs - 24 * 60 * 60 * 1000));
    const todayEvents = Object.values(allEvents).filter(e => {
      if (!e.openDate) return false;
      const t = new Date(e.openDate).getTime();
      if (t < nowMs - 5 * 60 * 60 * 1000) return false; // skip games started >5h ago
      // Include yesterday's ET games — late west-coast games cross the midnight ET boundary
      const openDateET = etFmt.format(new Date(e.openDate));
      return openDateET === todayET || openDateET === yesterdayET;
    });

    if (!todayEvents.length) {
      return new Response(JSON.stringify({ ok: true, games: {} }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Parse clean team names for all events
    const parsedAll = todayEvents.map(e => {
      const t = parseEventName(e.name);
      return t ? { event: e, away: t.away, home: t.home } : null;
    }).filter(Boolean);

    // Deduplicate same-matchup events from different FD list URLs.
    // FD sometimes returns the same physical game under two eventIds (competition
    // feed vs custom page) with different/stale odds — keep only the newest event
    // per (away, home, ET-date). For true doubleheaders, both games are on the
    // same date but have openDates hours apart so both survive dedup.
    const matchupBest = {};
    parsedAll.forEach(p => {
      const dateET = etFmt.format(new Date(p.event.openDate));
      const key = p.away + '|' + p.home + '|' + dateET;
      const existing = matchupBest[key];
      if (!existing || new Date(p.event.openDate) > new Date(existing.event.openDate)) {
        matchupBest[key] = p;
      }
    });
    const parsedToday = Object.values(matchupBest);

    const matchupGroups = {};
    parsedToday.forEach(p => {
      const base = p.away + ' @ ' + p.home;
      if (!matchupGroups[base]) matchupGroups[base] = [];
      matchupGroups[base].push(p);
    });
    // Only the second game in a true doubleheader gets a suffix.
    // Assigning (Game 1) to every first-listed game causes phantom DH labels
    // when FD has a stale duplicate event for the same matchup.
    const eventSuffix = {};
    Object.values(matchupGroups).forEach(group => {
      if (group.length < 2) return;
      group.sort((a, b) => new Date(a.event.openDate) - new Date(b.event.openDate));
      group.forEach((p, i) => { if (i > 0) eventSuffix[p.event.eventId] = '(Game 2)'; });
    });

    // Load previous cache so we can freeze odds for live games with suspended markets
    let prevGames = {};
    try {
      const prev = await env.DB.prepare('SELECT data FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
      if (prev) prevGames = JSON.parse(prev.data).games || {};
    } catch(e) {}

    // Fetch event-pages in parallel with a 5s per-request timeout
    const gameData = {};
    const eventPageDebug = [];

    await Promise.all(parsedToday.map(async ({ event, away, home }) => {
      const suffix  = eventSuffix[event.eventId] || '';
      const gameKey = away + ' @ ' + home + (suffix ? ' ' + suffix : '');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const evRes = await fetch(FD_EVENT_URL(event.eventId), { headers, signal: ctrl.signal });
        clearTimeout(timer);
        if (!evRes.ok) { eventPageDebug.push({ name: event.name, evStatus: evRes.status }); return; }
        const evData = await evRes.json();

        const markets = evData?.attachments?.markets || {};
        const entry = { eventId: event.eventId, openDate: event.openDate, away, home, runnerNames: {} };
        const marketTypes = Object.values(markets).map(m => m.marketType);

        Object.entries(markets).forEach(function([marketId, mkt]) {
          if (mkt.marketType !== ML_TYPE) return;
          entry.mlId = marketId;
          (mkt.runners || []).forEach(function(ref) {
            if (ref.selectionId != null && ref.runnerName) {
              entry.runnerNames[ref.selectionId] = ref.runnerName;
            }
          });
        });

        eventPageDebug.push({ name: event.name, evStatus: evRes.status, marketCount: Object.keys(markets).length, marketTypes: marketTypes.slice(0, 6), mlId: entry.mlId || null });
        if (entry.mlId) gameData[gameKey] = entry;
      } catch(e) {
        clearTimeout(timer);
        eventPageDebug.push({ name: event.name, err: e.message });
      }
    }));

    if (debugMode === '2') {
      return new Response(JSON.stringify({ todayCount: todayEvents.length, gameDataCount: Object.keys(gameData).length, eventPageDebug }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Batch all ML market IDs into one getMarketPrices request
    const allMarketIds = [];
    const marketToGame = {};

    Object.entries(gameData).forEach(function([gameKey, entry]) {
      allMarketIds.push(entry.mlId);
      marketToGame[entry.mlId] = gameKey;
    });

    if (!allMarketIds.length) {
      return new Response(JSON.stringify({ ok: true, games: {} }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const pricesRes = await fetch(FD_PRICES_URL, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketIds: allMarketIds })
    });

    if (!pricesRes.ok) return fail(pricesRes.status, 'getMarketPrices failed');
    const marketPricesList = await pricesRes.json();

    const gamesMap = {};
    const pricesDebug = [];

    (Array.isArray(marketPricesList) ? marketPricesList : []).forEach(function(mp) {
      const gameKey = marketToGame[mp.marketId];
      pricesDebug.push({ marketId: mp.marketId, gameKey: gameKey || '?', marketStatus: mp.marketStatus });
      const entry = gameData[gameKey];
      if (!gameKey || !entry) return;

      if (mp.marketStatus === 'OPEN') {
        if (!gamesMap[gameKey]) gamesMap[gameKey] = { id: entry.eventId, away: entry.away, home: entry.home, cm: entry.openDate, ml: {} };
        (mp.runnerDetails || []).forEach(function(rd) {
          if (rd.runnerStatus !== 'ACTIVE') return;
          const price = rd.winRunnerOdds?.americanDisplayOdds?.americanOddsInt;
          if (price == null) return;
          const name = entry.runnerNames[rd.selectionId] || entry.runnerNames[String(rd.selectionId)] || '';
          if (name) gamesMap[gameKey].ml[name] = price;
        });
      } else if (mp.marketStatus === 'SUSPENDED') {
        // Game in progress — freeze last known pre-game odds so the row stays visible
        const frozen = prevGames[gameKey] || prevGames[entry.away + ' @ ' + entry.home] || null;
        if (frozen && frozen.ml && Object.keys(frozen.ml).length) {
          gamesMap[gameKey] = { ...frozen, id: entry.eventId, away: entry.away, home: entry.home, cm: entry.openDate, live: true };
        }
        // Any other status (RESULTED, SETTLED, CLOSED) = game over, let it drop off naturally
      }
    });

    // Safety net: rescue live games whose FD ML market is suspended mid-game.
    // Only rescue events still present in FD's event list — if FD dropped the event
    // entirely (game over), don't resurface it from stale cache.
    const activeEventIds = new Set(parsedToday.map(p => p.event.eventId));
    const nowMsSafe = Date.now();
    for (const [gameKey, prev] of Object.entries(prevGames)) {
      if (gamesMap[gameKey] || !prev.cm) continue;
      if (!activeEventIds.has(prev.id)) continue;
      const cmMs = new Date(prev.cm).getTime();
      if (cmMs > nowMsSafe || cmMs < nowMsSafe - 5 * 60 * 60 * 1000) continue;
      if (Object.keys(prev.ml || {}).length) {
        gamesMap[gameKey] = { ...prev, live: true };
      }
    }

    if (debugMode === '3') {
      return new Response(JSON.stringify({ gamesMapCount: Object.keys(gamesMap).length, pricesDebug }), { headers: { 'Content-Type': 'application/json' } });
    }

    const body = JSON.stringify({ ok: true, games: gamesMap });
    try {
      await env.DB.prepare(
        'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
      ).bind(cacheKey, body, now).run();
    } catch(e) {}

    return new Response(body, { headers: { 'Content-Type': 'application/json' } });

  } catch(e) {
    return fail(500, e.message);
  }
}
