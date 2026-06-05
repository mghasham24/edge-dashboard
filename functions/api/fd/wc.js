import { getSessionOrCron } from '../../_lib/auth.js';
// functions/api/fd/wc.js
// Fetches FanDuel World Cup ML odds (3-way group stage / 2-way knockout)
// Step 1: Get WC events from content-managed-page
// Step 2: Fetch event-page per game to collect market IDs and runner names
// Step 3: Batch POST to getMarketPrices for real-time prices

const FD_AK         = 'FhMFpcPWXMeyZxOx';
const FD_LIST_URLS  = [
  `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=world_cup&_ak=${FD_AK}&timezone=America/New_York`,
  `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=world-cup&_ak=${FD_AK}&timezone=America/New_York`,
  `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=fifa-world-cup&_ak=${FD_AK}&timezone=America/New_York`,
  `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=soccer&_ak=${FD_AK}&timezone=America/New_York`,
];
const FD_EVENT_URL  = (id) => `https://sbapi.nj.sportsbook.fanduel.com/api/event-page?_ak=${FD_AK}&eventId=${id}&tab=all&timezone=America/New_York`;
const FD_PRICES_URL = 'https://smp.nj.sportsbook.fanduel.com/api/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=0';
const CACHE_TTL     = 5;

const ML3_TYPE = 'MONEYLINE_(3-WAY)'; // group stage: home/draw/away
const ML2_TYPE = 'MONEY_LINE';         // knockout: team to advance (no draw)

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

function parseEventTeams(event) {
  const parts = event.participants || [];
  const homeP = parts.find(p => p.venueRole === 'Home');
  const awayP = parts.find(p => p.venueRole === 'Away');
  if (homeP && awayP) return { home: homeP.name, away: awayP.name };
  const name = event.name || '';
  const m = name.match(/^(.+?)\s+(?:@|v\.?)\s+(.+)$/i);
  if (m) return { away: m[1].trim(), home: m[2].trim() };
  return null;
}

function isWCEvent(event) {
  const comp = (event.competitionId || '') + (event.competitionName || '') + (event.eventPath || '');
  return /world.?cup|fifa|wc\b/i.test(comp) || (event.tags || []).some(t => /world.?cup|fifa/i.test(t));
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSessionOrCron(request, env);
  if (!session) return fail(401, 'Not authenticated');
  if (session.plan !== 'pro' && !session.is_admin) return fail(403, 'Pro plan required');

  const reqUrl    = new URL(request.url);
  const debugMode = reqUrl.searchParams.get('debug');
  const freshMode = reqUrl.searchParams.get('fresh');
  const now       = Math.floor(Date.now() / 1000);
  const cacheKey  = 'fd_wc';

  if (!debugMode && !freshMode) {
    try {
      const cached = await env.DB.prepare(
        'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
      ).bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < CACHE_TTL) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      }
    } catch(e) {}
  }

  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
  };

  try {
    // Step 1: Try each list URL until we find WC events
    const nowMs     = Date.now();
    const etFmt     = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
    const todayET   = etFmt.format(new Date());
    const yestET    = etFmt.format(new Date(nowMs - 24 * 60 * 60 * 1000));

    let todayEvents = [];
    let sourceUrl   = '';
    let allEventsDebug = [];

    for (const url of FD_LIST_URLS) {
      try {
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
        if (!r.ok) continue;
        const d = await r.json();
        const events = d?.attachments?.events || {};
        const vals = Object.values(events);

        if (debugMode === '1') {
          allEventsDebug.push({ url, count: vals.length, sample: vals.slice(0, 3).map(e => ({ id: e.eventId, name: e.name, comp: e.competitionId, compName: e.competitionName })) });
          continue;
        }

        const wc = vals.filter(e => {
          if (!e.openDate) return false;
          const t = new Date(e.openDate).getTime();
          if (t < nowMs - 4 * 60 * 60 * 1000) return false;
          const dt = etFmt.format(new Date(e.openDate));
          if (dt !== todayET && dt !== yestET) return false;
          return isWCEvent(e) || /world.?cup|fifa/i.test(e.name || '');
        });

        if (wc.length) { todayEvents = wc; sourceUrl = url; break; }

        // If no WC filter matched, try ALL events from this page (for soccer customPageId)
        const all = vals.filter(e => {
          if (!e.openDate) return false;
          const t = new Date(e.openDate).getTime();
          if (t < nowMs - 4 * 60 * 60 * 1000) return false;
          const dt = etFmt.format(new Date(e.openDate));
          return dt === todayET || dt === yestET;
        });
        if (all.length) { todayEvents = all; sourceUrl = url; break; }
      } catch(e) {}
    }

    if (debugMode === '1') {
      return new Response(JSON.stringify({ allEventsDebug }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (debugMode === '2') {
      return new Response(JSON.stringify({ sourceUrl, todayEventsFound: todayEvents.length, events: todayEvents.map(e => ({ id: e.eventId, name: e.name, openDate: e.openDate, comp: e.competitionId, compName: e.competitionName })) }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!todayEvents.length) {
      return new Response(JSON.stringify({ ok: true, games: {} }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Step 2: Fetch event-pages to collect market IDs and runner names
    const gameData = {};
    for (let i = 0; i < todayEvents.length; i++) {
      const event = todayEvents[i];
      const teams = parseEventTeams(event);
      if (!teams) continue;

      try {
        const evRes = await fetch(FD_EVENT_URL(event.eventId), { headers, signal: AbortSignal.timeout(6000) });
        if (!evRes.ok) continue;
        const evData = await evRes.json();

        const markets = evData?.attachments?.markets || {};
        const gameKey = teams.away + ' @ ' + teams.home;
        const entry   = { eventId: event.eventId, openDate: event.openDate, away: teams.away, home: teams.home, runnerNames: {} };

        if (debugMode === '3') {
          const mkts = Object.values(markets).map(m => ({ type: m.marketType, name: m.marketName, runners: (m.runners || []).map(r => r.runnerName) }));
          gameData[gameKey] = { ...entry, allMarkets: mkts };
          continue;
        }

        Object.entries(markets).forEach(([marketId, mkt]) => {
          const t = mkt.marketType || '';
          if (t === ML3_TYPE)      entry.ml3Id = marketId;
          else if (t === ML2_TYPE) entry.ml2Id = marketId;
          else return;
          (mkt.runners || []).forEach(r => {
            if (r.selectionId != null && r.runnerName) entry.runnerNames[r.selectionId] = r.runnerName;
          });
        });

        if (entry.ml3Id || entry.ml2Id) gameData[gameKey] = entry;
      } catch(e) {}

      if (i < todayEvents.length - 1) await new Promise(r => setTimeout(r, 150));
    }

    if (debugMode === '3') {
      return new Response(JSON.stringify({ ok: true, games: gameData }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (!Object.keys(gameData).length) {
      return new Response(JSON.stringify({ ok: true, games: {} }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Step 3: Batch all market IDs → one getMarketPrices call
    const allMarketIds  = [];
    const marketToGame  = {};
    Object.entries(gameData).forEach(([gameKey, entry]) => {
      if (entry.ml3Id) { allMarketIds.push(entry.ml3Id); marketToGame[entry.ml3Id] = { gameKey, type: 'ml3' }; }
      if (entry.ml2Id) { allMarketIds.push(entry.ml2Id); marketToGame[entry.ml2Id] = { gameKey, type: 'ml2' }; }
    });

    if (!allMarketIds.length) {
      return new Response(JSON.stringify({ ok: true, games: {} }), { headers: { 'Content-Type': 'application/json' } });
    }

    const pricesRes = await fetch(FD_PRICES_URL, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketIds: allMarketIds }),
      signal: AbortSignal.timeout(8000)
    });
    if (!pricesRes.ok) return fail(pricesRes.status, 'getMarketPrices failed');
    const pricesRaw = await pricesRes.json();
    const marketPricesList = Array.isArray(pricesRaw) ? pricesRaw : (pricesRaw.marketPrices || []);

    let prevGames = {};
    try {
      const prev = await env.DB.prepare('SELECT data FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
      if (prev) prevGames = JSON.parse(prev.data).games || {};
    } catch(e) {}

    const gamesMap = {};

    marketPricesList.forEach(mp => {
      const mapping = marketToGame[mp.marketId];
      if (!mapping) return;
      const { gameKey, type } = mapping;
      const entry = gameData[gameKey];

      if (mp.marketStatus === 'SUSPENDED') {
        if (!gamesMap[gameKey]) {
          const frozen = prevGames[gameKey] || null;
          if (frozen && Object.keys(frozen.ml || {}).length) {
            gamesMap[gameKey] = { ...frozen, id: parseInt(entry.eventId), away: entry.away, home: entry.home, cm: entry.openDate, live: true };
          }
        }
        return;
      }
      if (mp.marketStatus !== 'OPEN') return;
      if (!gamesMap[gameKey]) gamesMap[gameKey] = { id: parseInt(entry.eventId), away: entry.away, home: entry.home, cm: entry.openDate, ml: {} };

      (mp.runnerDetails || []).forEach(rd => {
        if (rd.runnerStatus !== 'ACTIVE') return;
        const price = rd.winRunnerOdds?.americanDisplayOdds?.americanOddsInt;
        if (price == null) return;
        const name = entry.runnerNames[rd.selectionId] || entry.runnerNames[String(rd.selectionId)] || '';
        if (!name) return;
        gamesMap[gameKey].ml[name] = price;
      });
    });

    // Remove games with no prices
    for (const k of Object.keys(gamesMap)) {
      if (!Object.keys(gamesMap[k].ml || {}).length) delete gamesMap[k];
    }

    const body = JSON.stringify({ ok: true, games: gamesMap });
    try {
      await env.DB.prepare(
        'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
      ).bind(cacheKey, body, now).run();
    } catch(e) {}

    return new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

  } catch(e) {
    return fail(500, e.message);
  }
}
