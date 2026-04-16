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

async function getSession(request, db) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return null;
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    'SELECT u.id as user_id, u.plan FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(m[1], now).first();
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

function parseEventName(name) {
  const m = name.match(/^(.+?)\s*(?:\([^)]*\))?\s*@\s*(.+?)\s*(?:\([^)]*\))?\s*$/);
  if (!m) return null;
  return { away: m[1].trim(), home: m[2].trim() };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSession(request, env.DB);
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
    // Fetch event lists from all URLs and merge (dedup by eventId)
    const nowMs = Date.now();
    const allEvents = {};
    const urlDebug = [];
    for (const url of FD_LIST_URLS) {
      try {
        const listRes = await fetch(url, { headers });
        if (!listRes.ok) { urlDebug.push({ url, status: listRes.status, count: 0 }); continue; }
        const listData = await listRes.json();
        const evts = listData?.attachments?.events || {};
        const before = Object.keys(allEvents).length;
        Object.entries(evts).forEach(([id, e]) => { if (!allEvents[id]) allEvents[id] = e; });
        urlDebug.push({ url, status: listRes.status, count: Object.keys(evts).length, added: Object.keys(allEvents).length - before });
      } catch(e) { urlDebug.push({ url, err: e.message }); }
    }

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

    // Fetch event-pages to collect ML market IDs + runner names
    const gameData = {};
    const eventPageDebug = [];

    for (let i = 0; i < todayEvents.length; i++) {
      const event = todayEvents[i];
      const teams = parseEventName(event.name);
      if (!teams) { eventPageDebug.push({ name: event.name, err: 'parse failed' }); continue; }

      try {
        const evRes = await fetch(FD_EVENT_URL(event.eventId), { headers });
        if (!evRes.ok) { eventPageDebug.push({ name: event.name, evStatus: evRes.status }); continue; }
        const evData = await evRes.json();

        const markets = evData?.attachments?.markets || {};
        const gameKey = teams.away + ' @ ' + teams.home;
        const entry = { eventId: event.eventId, openDate: event.openDate, away: teams.away, home: teams.home, runnerNames: {} };
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
      } catch(e) { eventPageDebug.push({ name: event.name, err: e.message }); }

      if (i < todayEvents.length - 1) await new Promise(r => setTimeout(r, 150));
    }

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
      if (!gameKey || mp.marketStatus !== 'OPEN') return;
      const entry = gameData[gameKey];
      if (!gamesMap[gameKey]) gamesMap[gameKey] = { id: entry.eventId, away: entry.away, home: entry.home, cm: entry.openDate, ml: {} };

      (mp.runnerDetails || []).forEach(function(rd) {
        if (rd.runnerStatus !== 'ACTIVE') return;
        const price = rd.winRunnerOdds?.americanDisplayOdds?.americanOddsInt;
        if (price == null) return;
        const name = entry.runnerNames[rd.selectionId] || entry.runnerNames[String(rd.selectionId)] || '';
        if (name) gamesMap[gameKey].ml[name] = price;
      });
    });

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
