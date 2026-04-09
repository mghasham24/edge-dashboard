// functions/api/fd/nbaalts.js
// Fetches FanDuel real-time NBA spread, ML, and total odds via FD's native API
// Step 1: Get today's NBA event IDs from content-managed-page
// Step 2: Fetch event-page per game to collect market IDs and runner name mappings
// Step 3: Batch POST to getMarketPrices for real-time prices

const FD_AK        = 'FhMFpcPWXMeyZxOx';
const FD_LIST_URL  = `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=nba&_ak=${FD_AK}&timezone=America/New_York`;
const FD_EVENT_URL = (id) => `https://sbapi.nj.sportsbook.fanduel.com/api/event-page?_ak=${FD_AK}&eventId=${id}&tab=all&timezone=America/New_York`;
const FD_PRICES_URL = 'https://smp.nj.sportsbook.fanduel.com/api/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=0';
const CACHE_TTL = 5;

const SPREAD_TYPE = 'MATCH_HANDICAP_(2-WAY)';
const ML_TYPE     = 'MONEY_LINE';
const TOTAL_TYPE  = 'TOTAL_POINTS_(OVER/UNDER)';

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

  const urlObj = new URL(request.url);
  const debug = urlObj.searchParams.get('debug') === '1';

  const now = Math.floor(Date.now() / 1000);
  const cacheKey = 'fd_nba_alts';

  // Try cache first (skip in debug)
  if (!debug) try {
    const cached = await env.DB.prepare(
      'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
    ).bind(cacheKey).first();
    if (cached && (now - cached.fetched_at) < CACHE_TTL) {
      return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
    }
  } catch(e) {}

  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
  };

  try {
    // Step 1: Get today's NBA events
    const listRes = await fetch(FD_LIST_URL, { headers });
    if (!listRes.ok) return fail(listRes.status, 'FD NBA list fetch failed');
    const listData = await listRes.json();

    const events = listData?.attachments?.events || {};
    const nowMs = Date.now();
    const todayEvents = Object.values(events).filter(e => {
      if (!e.openDate) return false;
      const t = new Date(e.openDate).getTime();
      return t >= nowMs - 4 * 60 * 60 * 1000 && t <= nowMs + 36 * 60 * 60 * 1000;
    });

    if (!todayEvents.length) {
      if (debug) return new Response(JSON.stringify({ ok: true, debug: 'no events in window', eventCount: Object.keys(events).length, allDates: Object.values(events).slice(0,5).map(e => e.openDate) }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ ok: true, games: {} }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (debug) {
      // Return raw info without fetching event-pages
      const pricesTestRes = await fetch(FD_PRICES_URL, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketIds: [] })
      });
      return new Response(JSON.stringify({
        ok: true,
        debug: 'event list ok',
        eventCount: todayEvents.length,
        events: todayEvents.map(e => ({ id: e.eventId, name: e.name, openDate: e.openDate })),
        pricesEndpointStatus: pricesTestRes.status
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Step 2: Fetch event-pages to collect market IDs and runner name mappings
    const gameData = {}; // gameKey → { spreadId, mlId, totalId, runnerNames: {selId: name} }

    for (let i = 0; i < todayEvents.length; i++) {
      const event = todayEvents[i];
      const teams = parseEventName(event.name);
      if (!teams) continue;

      try {
        const evRes = await fetch(FD_EVENT_URL(event.eventId), { headers });
        if (!evRes.ok) continue;
        const evData = await evRes.json();

        const markets = evData?.attachments?.markets || {};
        const runners = evData?.attachments?.runners || {};
        const gameKey = teams.away + ' @ ' + teams.home;
        const entry = { eventId: event.eventId, openDate: event.openDate, away: teams.away, home: teams.home, runnerNames: {} };

        Object.entries(markets).forEach(function([marketId, mkt]) {
          const mktType = mkt.marketType || '';
          if (mktType === SPREAD_TYPE)      entry.spreadId = marketId;
          else if (mktType === ML_TYPE)     entry.mlId     = marketId;
          else if (mktType === TOTAL_TYPE)  entry.totalId  = marketId;
          else return;

          // Map selectionId → runnerName for price-to-name lookup later
          (mkt.runners || []).forEach(function(ref) {
            const sid = ref.selectionId;
            if (sid == null) return;
            const runner = runners[sid] || runners[String(sid)];
            if (runner && runner.runnerName) entry.runnerNames[sid] = runner.runnerName;
          });
        });

        if (entry.spreadId || entry.mlId || entry.totalId) {
          gameData[gameKey] = entry;
        }
      } catch(e) {}

      if (i < todayEvents.length - 1) await new Promise(r => setTimeout(r, 150));
    }

    // Step 3: Batch all market IDs into one getMarketPrices request
    const allMarketIds = [];
    const marketToGame = {}; // marketId → { gameKey, type }

    Object.entries(gameData).forEach(function([gameKey, entry]) {
      if (entry.spreadId) { allMarketIds.push(entry.spreadId); marketToGame[entry.spreadId] = { gameKey, type: 'spread' }; }
      if (entry.mlId)     { allMarketIds.push(entry.mlId);     marketToGame[entry.mlId]     = { gameKey, type: 'ml' }; }
      if (entry.totalId)  { allMarketIds.push(entry.totalId);  marketToGame[entry.totalId]  = { gameKey, type: 'total' }; }
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
    const pricesRaw = await pricesRes.json();
    const marketPricesList = Array.isArray(pricesRaw) ? pricesRaw : (pricesRaw.marketPrices || []);

    // Step 4: Map prices back to games in altOdds-compatible format
    // { spreads: { teamName: { handicap: price } }, totals: { Over: { line: price }, Under: { line: price } }, ml: { teamName: price } }
    const gamesMap = {};

    marketPricesList.forEach(function(mp) {
      const mapping = marketToGame[mp.marketId];
      if (!mapping || mp.marketStatus !== 'OPEN') return;
      const { gameKey, type } = mapping;
      const entry = gameData[gameKey];
      if (!gamesMap[gameKey]) gamesMap[gameKey] = { id: entry.eventId, away: entry.away, home: entry.home, cm: entry.openDate, spreads: {}, totals: {}, ml: {} };
      const game = gamesMap[gameKey];

      (mp.runnerDetails || []).forEach(function(rd) {
        if (rd.runnerStatus !== 'ACTIVE') return;
        const price = rd.winRunnerOdds?.americanDisplayOdds?.americanOddsInt;
        if (price == null) return;
        const name = entry.runnerNames[rd.selectionId] || entry.runnerNames[String(rd.selectionId)] || '';
        const handicap = rd.handicap;

        if (type === 'spread' && name && handicap != null) {
          if (!game.spreads[name]) game.spreads[name] = {};
          game.spreads[name][handicap] = price;
        } else if (type === 'total' && name && handicap != null) {
          const side = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
          if (side === 'Over' || side === 'Under') {
            if (!game.totals[side]) game.totals[side] = {};
            game.totals[side][handicap] = price;
          }
        } else if (type === 'ml' && name) {
          game.ml[name] = price;
        }
      });
    });

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
