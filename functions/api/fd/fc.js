// functions/api/fd/fc.js
// Fetches FanDuel real-time soccer spread odds for top 6 European leagues
// Step 1: Fetch COMPETITION page for each league — these return individual game events + markets
// Step 2: Filter to today's games in ET, collect spread market IDs + runner names
// Step 3: Batch POST to getMarketPrices for real-time prices

const FD_AK = 'FhMFpcPWXMeyZxOx';
const FD_COMP_URL = (compId) =>
  `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=COMPETITION&competitionId=${compId}&_ak=${FD_AK}&timezone=America/New_York`;
const FD_PRICES_URL = 'https://smp.nj.sportsbook.fanduel.com/api/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=0';
const CACHE_TTL = 30;

// Known FD competition IDs + league labels
const TARGET_COMPS = [
  { id: 10932509, label: 'EPL' },
  { id: 228,      label: 'UCL' },
  { id: 117,      label: 'La Liga' },
  { id: 59,       label: 'Bundesliga' },
  { id: 81,       label: 'Serie A' },
  { id: 55,       label: 'Ligue 1' },
];

// Soccer spread market types to look for (in priority order)
const SPREAD_TYPES = ['ASIAN_HANDICAP', 'HANDICAP', 'ASIAN_LINE'];

// Returns true if date matches today in ET
function isToday_ET(dateStr) {
  if (!dateStr) return false;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  return fmt.format(new Date(dateStr)) === fmt.format(new Date());
}

function parseEventName(name) {
  // FD soccer: "Home v Away"
  let m = name.match(/^(.+?)\s+v\s+(.+?)\s*$/i);
  if (m) return { home: m[1].trim(), away: m[2].trim() };
  // US format: "Away @ Home"
  m = name.match(/^(.+?)\s*@\s*(.+?)\s*$/);
  if (m) return { away: m[1].trim(), home: m[2].trim() };
  return null;
}

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

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');

  const reqUrl = new URL(request.url);
  const debugMode = reqUrl.searchParams.get('debug');
  // debug=1 can target a specific comp: ?debug=1&comp=59
  const debugComp = reqUrl.searchParams.get('comp');

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
    const nowMs = Date.now();

    // debug=3: probe candidate custom page IDs to find working soccer pages
    if (debugMode === '3') {
      const candidates = [
        'soccer','epl','premier-league','english-premier-league',
        'bundesliga','german-bundesliga','serie-a','italian-serie-a',
        'la-liga','spanish-la-liga','ligue-1','french-ligue-1',
        'champions-league','ucl','uefa-champions-league',
      ];
      const results = [];
      for (const pageId of candidates) {
        const url = `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=${pageId}&_ak=${FD_AK}&timezone=America/New_York`;
        try {
          const r = await fetch(url, { headers });
          if (r.ok) {
            const d = await r.json();
            const evCount = Object.keys(d?.attachments?.events || {}).length;
            const mktCount = Object.keys(d?.attachments?.markets || {}).length;
            const mktTypes = [...new Set(Object.values(d?.attachments?.markets || {}).map(m => m.marketType))].sort();
            results.push({ pageId, status: 200, evCount, mktCount, mktTypes });
          } else {
            results.push({ pageId, status: r.status });
          }
        } catch(e) {
          results.push({ pageId, error: e.message });
        }
        await new Promise(r => setTimeout(r, 80));
      }
      return new Response(JSON.stringify({ results }), { headers: { 'Content-Type': 'application/json' } });
    }

    // debug=4: test event-page for competition containers + COMPETITION page variations
    if (debugMode === '4') {
      // Known competition container event IDs from SPORT page
      const containerEventIds = [78601, 241361, 259241, 268416, 605621];
      const results = [];

      // Test event-page for each container
      for (const eid of containerEventIds.slice(0, 3)) {
        const url = `https://sbapi.nj.sportsbook.fanduel.com/api/event-page?_ak=${FD_AK}&eventId=${eid}&tab=all&timezone=America/New_York`;
        try {
          const r = await fetch(url, { headers });
          if (r.ok) {
            const d = await r.json();
            const evCount = Object.keys(d?.attachments?.events || {}).length;
            const mktCount = Object.keys(d?.attachments?.markets || {}).length;
            const mktTypes = [...new Set(Object.values(d?.attachments?.markets || {}).map(m => m.marketType))].sort();
            const evSample = Object.values(d?.attachments?.events || {}).slice(0,3).map(e => ({ eventId: e.eventId, name: e.name, openDate: e.openDate }));
            results.push({ type: 'event-page', eventId: eid, status: 200, evCount, mktCount, mktTypes, evSample });
          } else {
            results.push({ type: 'event-page', eventId: eid, status: r.status });
          }
        } catch(e) { results.push({ type: 'event-page', eventId: eid, error: e.message }); }
        await new Promise(r => setTimeout(r, 100));
      }

      // Test COMPETITION page with extra params
      const compVariants = [
        `page=COMPETITION&competitionId=59&eventTypeId=1`,
        `page=COMPETITION&competitionId=59&tab=MATCHES`,
        `page=COMPETITION&competitionId=59&tab=matches`,
        `page=COMPETITION&id=59`,
        `page=LEAGUE&competitionId=59`,
      ];
      for (const params of compVariants) {
        const url = `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?${params}&_ak=${FD_AK}&timezone=America/New_York`;
        try {
          const r = await fetch(url, { headers });
          results.push({ type: 'comp-variant', params, status: r.status });
        } catch(e) { results.push({ type: 'comp-variant', params, error: e.message }); }
        await new Promise(r => setTimeout(r, 80));
      }

      return new Response(JSON.stringify({ results }), { headers: { 'Content-Type': 'application/json' } });
    }

    // debug=1: inspect one competition page structure
    if (debugMode === '1') {
      const compId = debugComp || TARGET_COMPS[0].id;
      const res = await fetch(FD_COMP_URL(compId), { headers });
      const status = res.status;
      if (!res.ok) {
        return new Response(JSON.stringify({ compId, status, error: 'fetch failed' }), { headers: { 'Content-Type': 'application/json' } });
      }
      const data = await res.json();
      const attachmentKeys = Object.keys(data?.attachments || {});
      const events = data?.attachments?.events || {};
      const markets = data?.attachments?.markets || {};
      const eventSample = Object.values(events).slice(0, 5);
      const uniqueMarketTypes = [...new Set(Object.values(markets).map(m => m.marketType))].sort();
      const spreadSample = Object.values(markets)
        .filter(m => SPREAD_TYPES.some(t => t === m.marketType))
        .slice(0, 5)
        .map(m => ({ marketId: m.marketId, marketType: m.marketType, eventId: m.eventId, marketName: m.marketName, runners: (m.runners || []).slice(0,3).map(r => ({ name: r.runnerName, handicap: r.handicap, selectionId: r.selectionId })) }));
      return new Response(JSON.stringify({
        compId, status,
        attachmentKeys,
        totalEvents: Object.keys(events).length,
        totalMarkets: Object.keys(markets).length,
        uniqueMarketTypes,
        eventSample: eventSample.map(e => ({ eventId: e.eventId, name: e.name, openDate: e.openDate })),
        spreadSample
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Step 1: Fetch all competition pages sequentially, collect today's game data
    const gameData = {}; // gameKey → { marketId, eventId, marketTime, away, home, league, runnerNames }

    for (const comp of TARGET_COMPS) {
      try {
        const res = await fetch(FD_COMP_URL(comp.id), { headers });
        if (!res.ok) continue;
        const data = await res.json();

        const events = data?.attachments?.events || {};
        const markets = data?.attachments?.markets || {};

        // Find today's events
        const todayEventIds = new Set();
        Object.values(events).forEach(function(e) {
          if (!e.openDate) return;
          if (!isToday_ET(e.openDate)) return;
          const t = new Date(e.openDate).getTime();
          if (t < nowMs - 4 * 60 * 60 * 1000) return; // skip if started 4h+ ago
          todayEventIds.add(e.eventId);
        });

        if (!todayEventIds.size) continue;

        // For each today event, find spread market
        Object.values(markets).forEach(function(mkt) {
          if (!todayEventIds.has(mkt.eventId)) return;
          if (!SPREAD_TYPES.includes(mkt.marketType)) return;
          if (mkt.marketStatus && mkt.marketStatus !== 'OPEN') return;

          // Find the event to get game name + time
          const event = events[mkt.eventId];
          if (!event) return;

          const teams = parseEventName(event.name);
          if (!teams) return;
          const gameKey = teams.away + ' @ ' + teams.home;

          if (gameData[gameKey]) return; // already have this game

          const runnerNames = {};
          (mkt.runners || []).forEach(function(r) {
            if (r.selectionId != null && r.runnerName) runnerNames[r.selectionId] = r.runnerName;
          });

          gameData[gameKey] = {
            marketId: mkt.marketId,
            eventId: mkt.eventId,
            marketTime: event.openDate,
            marketType: mkt.marketType,
            away: teams.away,
            home: teams.home,
            league: comp.label,
            runnerNames,
            runners: mkt.runners || []
          };
        });
      } catch(e) {}

      // Small delay between competition fetches
      await new Promise(r => setTimeout(r, 100));
    }

    if (debugMode === '2') {
      return new Response(JSON.stringify({
        filteredCount: Object.keys(gameData).length,
        games: Object.entries(gameData).map(([k, v]) => ({
          gameKey: k, league: v.league, marketTime: v.marketTime,
          marketType: v.marketType, marketId: v.marketId,
          runners: v.runners.map(r => ({ name: r.runnerName, handicap: r.handicap }))
        }))
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (!Object.keys(gameData).length) {
      return new Response(JSON.stringify({ ok: true, games: {} }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Step 2: Batch all market IDs into one getMarketPrices request
    const allMarketIds = [];
    const marketToGame = {};

    Object.entries(gameData).forEach(function([gameKey, entry]) {
      allMarketIds.push(entry.marketId);
      marketToGame[entry.marketId] = gameKey;
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
          cm: entry.marketTime,
          league: entry.league,
          spread: {}
        };
      }

      (mp.runnerDetails || []).forEach(function(rd) {
        if (rd.runnerStatus !== 'ACTIVE') return;
        const price = rd.winRunnerOdds?.americanDisplayOdds?.americanOddsInt;
        if (price == null) return;
        const name = entry.runnerNames[rd.selectionId] || entry.runnerNames[String(rd.selectionId)] || '';
        if (!name) return;
        const handicap = rd.handicap ?? (entry.runners.find(r => r.selectionId == rd.selectionId)?.handicap);
        gamesMap[gameKey].spread[name] = { pt: handicap, am: price };
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
