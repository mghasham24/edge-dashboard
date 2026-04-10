// functions/api/fd/fc.js
// Fetches FanDuel real-time soccer ML odds for top 6 European leagues
// Step 1: Single SPORT endpoint (eventTypeId=1) returns all soccer events with competition info
// Step 2: Filter by competition name to EPL, UCL, La Liga, Bundesliga, Serie A, Ligue 1
// Step 3: Fetch event-page per game to collect ML market ID + runner names
// Step 4: Batch POST to getMarketPrices for real-time prices

const FD_AK = 'FhMFpcPWXMeyZxOx';
const FD_SPORT_URL = `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=SPORT&eventTypeId=1&_ak=${FD_AK}&timezone=America/New_York`;
const FD_EVENT_URL = (id) => `https://sbapi.nj.sportsbook.fanduel.com/api/event-page?_ak=${FD_AK}&eventId=${id}&tab=all&timezone=America/New_York`;
const FD_PRICES_URL = 'https://smp.nj.sportsbook.fanduel.com/api/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=0';
const ML_TYPE = 'MONEY_LINE';
const CACHE_TTL = 30;

// Competition name fragments to match (case-insensitive) → league label
const LEAGUE_FILTERS = [
  { match: 'premier league',   label: 'EPL' },
  { match: 'champions league', label: 'UCL' },
  { match: 'la liga',          label: 'La Liga' },
  { match: 'bundesliga',       label: 'Bundesliga' },
  { match: 'serie a',          label: 'Serie A' },
  { match: 'ligue 1',          label: 'Ligue 1' },
];

function getLeagueLabel(competitionName) {
  if (!competitionName) return null;
  const lower = competitionName.toLowerCase();
  const match = LEAGUE_FILTERS.find(f => lower.includes(f.match));
  return match ? match.label : null;
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

function parseEventName(name) {
  // Try FD US format: "Away @ Home"
  let m = name.match(/^(.+?)\s*(?:\([^)]*\))?\s*@\s*(.+?)\s*(?:\([^)]*\))?\s*$/);
  if (m) return { away: m[1].trim(), home: m[2].trim() };
  // Try FD soccer format: "Home v Away" (home team first in soccer)
  m = name.match(/^(.+?)\s+v\s+(.+?)\s*$/);
  if (m) return { away: m[2].trim(), home: m[1].trim() };
  return null;
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
    // Step 1: Single SPORT fetch for all soccer events
    const sportRes = await fetch(FD_SPORT_URL, { headers });
    if (!sportRes.ok) return fail(sportRes.status, 'FD soccer sport fetch failed: ' + sportRes.status);
    const sportData = await sportRes.json();

    const nowMs = Date.now();
    const allEvents = sportData?.attachments?.events || {};
    const competitions = sportData?.attachments?.competitions || {};

    // debug=1: show raw competition names and event sample
    if (debugMode === '1') {
      const compNames = Object.values(competitions).map(c => ({ id: c.competitionId, name: c.name })).slice(0, 30);
      const eventSample = Object.values(allEvents).slice(0, 10).map(e => ({
        name: e.name,
        openDate: e.openDate,
        competitionId: e.competitionId,
        compName: competitions[e.competitionId]?.name
      }));
      return new Response(JSON.stringify({
        totalEvents: Object.keys(allEvents).length,
        totalComps: Object.keys(competitions).length,
        competitions: compNames,
        eventSample
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Step 2: Filter to target leagues within time window
    const todayEvents = Object.values(allEvents).filter(e => {
      if (!e.openDate) return false;
      const t = new Date(e.openDate).getTime();
      if (t < nowMs - 4 * 60 * 60 * 1000 || t > nowMs + 36 * 60 * 60 * 1000) return false;
      const compName = competitions[e.competitionId]?.name || '';
      const league = getLeagueLabel(compName);
      if (!league) return false;
      e._league = league;
      return true;
    });

    if (debugMode === '2') {
      return new Response(JSON.stringify({
        filteredCount: todayEvents.length,
        events: todayEvents.map(e => ({
          name: e.name,
          openDate: e.openDate,
          league: e._league,
          parsed: parseEventName(e.name)
        }))
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (!todayEvents.length) {
      return new Response(JSON.stringify({ ok: true, games: {} }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Step 3: Fetch event-pages to collect ML market ID + runner name mappings
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

    // Step 4: Batch all ML market IDs into one getMarketPrices request
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
