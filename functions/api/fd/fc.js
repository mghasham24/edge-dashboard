// functions/api/fd/fc.js
// Fetches FanDuel real-time soccer ML odds for top 6 European leagues
// EPL (10932509), UCL (228), La Liga (117), Bundesliga (59), Serie A (81), Ligue 1 (55)
// Step 1: Fetch all 6 competition event lists in parallel
// Step 2: Fetch event-page per game to collect ML market ID + runner names
// Step 3: Batch POST to getMarketPrices for real-time prices

const FD_AK = 'FhMFpcPWXMeyZxOx';
const FD_COMP_URL = (id) => `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=COMPETITION&competitionId=${id}&_ak=${FD_AK}&timezone=America/New_York`;
const FD_EVENT_URL = (id) => `https://sbapi.nj.sportsbook.fanduel.com/api/event-page?_ak=${FD_AK}&eventId=${id}&tab=all&timezone=America/New_York`;
const FD_PRICES_URL = 'https://smp.nj.sportsbook.fanduel.com/api/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=0';
const ML_TYPE = 'MONEY_LINE';
const CACHE_TTL = 30; // soccer odds update slowly

const COMPETITIONS = [
  { id: '10932509', label: 'EPL' },
  { id: '228',      label: 'UCL' },
  { id: '117',      label: 'La Liga' },
  { id: '59',       label: 'Bundesliga' },
  { id: '81',       label: 'Serie A' },
  { id: '55',       label: 'Ligue 1' },
];

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
  const cacheKey = 'fd_fc';

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
    // Step 1: Fetch all competition event lists in parallel, dedup by eventId
    const nowMs = Date.now();
    const allEvents = {};
    const compDebug = [];

    await Promise.all(COMPETITIONS.map(async (comp) => {
      try {
        const res = await fetch(FD_COMP_URL(comp.id), { headers });
        const status = res.status;
        if (!res.ok) { compDebug.push({ comp: comp.label, id: comp.id, status, err: 'not ok' }); return; }
        const data = await res.json();
        const evts = data?.attachments?.events || {};
        const count = Object.keys(evts).length;
        compDebug.push({ comp: comp.label, id: comp.id, status, eventCount: count });
        Object.entries(evts).forEach(([id, e]) => {
          if (!allEvents[id]) allEvents[id] = { ...e, _league: comp.label };
        });
      } catch(e) { compDebug.push({ comp: comp.label, id: comp.id, err: e.message }); }
    }));

    const nowMs2 = Date.now();
    const todayEvents = Object.values(allEvents).filter(e => {
      if (!e.openDate) return false;
      const t = new Date(e.openDate).getTime();
      return t >= nowMs2 - 4 * 60 * 60 * 1000 && t <= nowMs2 + 36 * 60 * 60 * 1000;
    });

    if (debugMode === '1') {
      return new Response(JSON.stringify({
        compDebug,
        totalEvents: Object.keys(allEvents).length,
        filteredEvents: todayEvents.length,
        sample: Object.values(allEvents).slice(0, 5).map(e => ({ name: e.name, openDate: e.openDate, league: e._league }))
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (!todayEvents.length) {
      return new Response(JSON.stringify({ ok: true, games: {}, _debug: { compDebug, totalRaw: Object.keys(allEvents).length } }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Step 2: Fetch event-pages to collect ML market ID + runner name mappings
    const gameData = {};

    for (let i = 0; i < todayEvents.length; i++) {
      const event = todayEvents[i];
      const teams = parseEventName(event.name);
      if (!teams) continue;

      try {
        const evRes = await fetch(FD_EVENT_URL(event.eventId), { headers });
        if (!evRes.ok) continue;
        const evData = await evRes.json();

        const markets = evData?.attachments?.markets || {};
        const gameKey = teams.away + ' @ ' + teams.home;
        const entry = {
          eventId: event.eventId,
          openDate: event.openDate,
          away: teams.away,
          home: teams.home,
          league: event._league,
          runnerNames: {}
        };

        Object.entries(markets).forEach(function([marketId, mkt]) {
          if (mkt.marketType !== ML_TYPE) return;
          entry.mlId = marketId;
          (mkt.runners || []).forEach(function(ref) {
            if (ref.selectionId != null && ref.runnerName) {
              entry.runnerNames[ref.selectionId] = ref.runnerName;
            }
          });
        });

        if (entry.mlId) gameData[gameKey] = entry;
      } catch(e) {}

      if (i < todayEvents.length - 1) await new Promise(r => setTimeout(r, 120));
    }

    if (!Object.keys(gameData).length) {
      return new Response(JSON.stringify({ ok: true, games: {} }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Step 3: Batch all ML market IDs into one getMarketPrices request
    const allMarketIds = [];
    const marketToGame = {};

    Object.entries(gameData).forEach(function([gameKey, entry]) {
      allMarketIds.push(entry.mlId);
      marketToGame[entry.mlId] = gameKey;
    });

    const pricesRes = await fetch(FD_PRICES_URL, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketIds: allMarketIds })
    });

    if (!pricesRes.ok) return fail(pricesRes.status, 'getMarketPrices failed');
    const marketPricesList = await pricesRes.json();

    const gamesMap = {};

    (Array.isArray(marketPricesList) ? marketPricesList : []).forEach(function(mp) {
      const gameKey = marketToGame[mp.marketId];
      if (!gameKey || mp.marketStatus !== 'OPEN') return;
      const entry = gameData[gameKey];
      if (!gamesMap[gameKey]) {
        gamesMap[gameKey] = {
          id: entry.eventId,
          away: entry.away,
          home: entry.home,
          cm: entry.openDate,
          league: entry.league,
          ml: {}
        };
      }

      (mp.runnerDetails || []).forEach(function(rd) {
        if (rd.runnerStatus !== 'ACTIVE') return;
        const price = rd.winRunnerOdds?.americanDisplayOdds?.americanOddsInt;
        if (price == null) return;
        const name = entry.runnerNames[rd.selectionId] || entry.runnerNames[String(rd.selectionId)] || '';
        if (name) gamesMap[gameKey].ml[name] = price;
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
