// functions/api/fd/fc.js
// Fetches FanDuel real-time soccer spread (Asian handicap) odds for top 6 European leagues
// Step 1: Single SPORT endpoint (eventTypeId=1) returns attachments.markets with all game markets
// Step 2: Filter markets by spread type, today's games in ET, and target competition
// Step 3: Batch POST to getMarketPrices for real-time prices
// Note: No per-event-page fetches needed — runner names are embedded in attachments.markets

const FD_AK = 'FhMFpcPWXMeyZxOx';
const FD_SPORT_URL = `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=SPORT&eventTypeId=1&_ak=${FD_AK}&timezone=America/New_York`;
const FD_PRICES_URL = 'https://smp.nj.sportsbook.fanduel.com/api/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=0';
const SPREAD_TYPE = 'ASIAN_HANDICAP';
const CACHE_TTL = 30;

// Exact competition names → league label (prevents substring false matches like Bundesliga 2, Brazilian Serie A, Slovenian Premier League)
const EXACT_COMP_NAMES = {
  'premier league':          'EPL',
  'english premier league':  'EPL',
  'la liga':                 'La Liga',
  'spanish la liga':         'La Liga',
  'bundesliga':              'Bundesliga',
  'german bundesliga':       'Bundesliga',
  'serie a':                 'Serie A',
  'italian serie a':         'Serie A',
  'ligue 1':                 'Ligue 1',
  'french ligue 1':          'Ligue 1',
};

function getLeagueLabel(competitionName) {
  if (!competitionName) return null;
  const lower = competitionName.toLowerCase();
  if (EXACT_COMP_NAMES[lower]) return EXACT_COMP_NAMES[lower];
  // UCL substring match is safe — no other major competition shares this substring
  if (lower.includes('champions league')) return 'UCL';
  return null;
}

// Returns true if the market's game date matches today in ET (America/New_York)
function isToday_ET(marketTime) {
  if (!marketTime) return false;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  const gameDate = fmt.format(new Date(marketTime));
  const todayDate = fmt.format(new Date());
  return gameDate === todayDate;
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
    // Step 1: Single SPORT fetch for all soccer markets
    const sportRes = await fetch(FD_SPORT_URL, { headers });
    if (!sportRes.ok) return fail(sportRes.status, 'FD soccer sport fetch failed: ' + sportRes.status);
    const sportData = await sportRes.json();

    const nowMs = Date.now();
    const allMarkets = sportData?.attachments?.markets || {};
    const competitions = sportData?.attachments?.competitions || {};

    // Build competitionId → league label map for target leagues
    const compLeagueMap = {};
    Object.values(competitions).forEach(function(c) {
      const label = getLeagueLabel(c.name);
      if (label) compLeagueMap[c.competitionId] = label;
    });

    // debug=1: show all unique market types and target competitions
    if (debugMode === '1') {
      const uniqueTypes = [...new Set(Object.values(allMarkets).map(m => m.marketType))].sort();
      const targetComps = Object.entries(compLeagueMap).map(([id, label]) => ({
        competitionId: id, label, name: competitions[id]?.name
      }));
      // Sample of SPREAD_TYPE markets
      const spreadMarkets = Object.values(allMarkets)
        .filter(m => m.marketType === SPREAD_TYPE)
        .slice(0, 5)
        .map(m => ({
          marketId: m.marketId,
          competitionId: m.competitionId,
          league: compLeagueMap[m.competitionId],
          marketTime: m.marketTime,
          marketStatus: m.marketStatus,
          runners: (m.runners || []).map(r => ({ id: r.selectionId, name: r.runnerName, handicap: r.handicap }))
        }));
      // Sample of non-WDW, non-outright market types
      const otherSample = Object.values(allMarkets)
        .filter(m => m.marketType !== 'WIN-DRAW-WIN' && m.marketType !== 'OUTRIGHT_BETTING' && compLeagueMap[m.competitionId])
        .slice(0, 5)
        .map(m => ({ marketType: m.marketType, marketId: m.marketId, marketName: m.marketName, league: compLeagueMap[m.competitionId], runners: (m.runners || []).slice(0,2).map(r => ({ name: r.runnerName, handicap: r.handicap })) }));
      return new Response(JSON.stringify({
        totalMarkets: Object.keys(allMarkets).length,
        allMarketTypes: uniqueTypes,
        targetCompetitions: targetComps,
        spreadTypeSample: spreadMarkets,
        otherLeagueMarketsSample: otherSample
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Step 2: Filter markets — target spread type, target league, today's games in ET
    // For Asian handicap: runner order is [Home, Away] or flagged by handicap sign
    const gameMarkets = {};

    Object.values(allMarkets).forEach(function(mkt) {
      if (mkt.marketType !== SPREAD_TYPE) return;
      const league = compLeagueMap[mkt.competitionId];
      if (!league) return;
      if (mkt.marketStatus && mkt.marketStatus !== 'OPEN') return;
      if (!mkt.marketTime) return;
      // Today-only filter in ET timezone
      if (!isToday_ET(mkt.marketTime)) return;
      // Also skip games that started more than 4h ago
      const t = new Date(mkt.marketTime).getTime();
      if (t < nowMs - 4 * 60 * 60 * 1000) return;

      const runners = mkt.runners || [];
      if (runners.length < 2) return;

      // For Asian handicap runners: identify home/away by handicap sign
      // Home team runner typically has negative handicap (favorite) or positive (underdog)
      // Runner order: [0]=Home, [1]=Away in FD soccer
      const homeRunner = runners[0];
      const awayRunner = runners[1];
      if (!homeRunner || !awayRunner) return;

      const gameKey = awayRunner.runnerName + ' @ ' + homeRunner.runnerName;

      // One market per game — prefer the -0.5/+0.5 line if multiple exist
      const existingEntry = gameMarkets[gameKey];
      const currentHandicap = Math.abs(parseFloat(homeRunner.handicap) || 0);
      if (existingEntry) {
        const existingHandicap = Math.abs(parseFloat(existingEntry.homeHandicap) || 0);
        // Keep the -0.5/+0.5 line; if tie, keep first
        if (Math.abs(currentHandicap - 0.5) > Math.abs(existingHandicap - 0.5)) return;
      }

      const runnerNames = {};
      runners.forEach(function(r) {
        if (r.selectionId != null && r.runnerName) runnerNames[r.selectionId] = r.runnerName;
      });

      gameMarkets[gameKey] = {
        marketId: mkt.marketId,
        eventId: mkt.eventId,
        marketTime: mkt.marketTime,
        away: awayRunner.runnerName,
        home: homeRunner.runnerName,
        homeHandicap: homeRunner.handicap,
        awayHandicap: awayRunner.handicap,
        league,
        runnerNames
      };
    });

    if (debugMode === '2') {
      return new Response(JSON.stringify({
        filteredCount: Object.keys(gameMarkets).length,
        games: Object.entries(gameMarkets).map(([k, v]) => ({
          gameKey: k, league: v.league, marketTime: v.marketTime,
          homeHandicap: v.homeHandicap, awayHandicap: v.awayHandicap, marketId: v.marketId
        }))
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (!Object.keys(gameMarkets).length) {
      return new Response(JSON.stringify({ ok: true, games: {} }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Step 3: Batch all market IDs into one getMarketPrices request
    const allMarketIds = [];
    const marketToGame = {};

    Object.entries(gameMarkets).forEach(function([gameKey, entry]) {
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
      const entry = gameMarkets[gameKey];
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
        // handicap from the market entry
        const handicap = rd.handicap ?? (name === entry.home ? entry.homeHandicap : entry.awayHandicap);
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
