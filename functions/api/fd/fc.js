// functions/api/fd/fc.js
// Fetches FanDuel real-time soccer ML odds for top 6 European leagues
// Step 1: Single SPORT endpoint (eventTypeId=1) returns attachments.markets with all game markets
// Step 2: Filter markets by WIN-DRAW-WIN type, time window, and target competition
// Step 3: Batch POST to getMarketPrices for real-time prices
// Note: No per-event-page fetches needed — runner names are embedded in attachments.markets

const FD_AK = 'FhMFpcPWXMeyZxOx';
const FD_SPORT_URL = `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=SPORT&eventTypeId=1&_ak=${FD_AK}&timezone=America/New_York`;
const FD_PRICES_URL = 'https://smp.nj.sportsbook.fanduel.com/api/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=0';
const ML_TYPE = 'WIN-DRAW-WIN';
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
    const allMarkets = sportData?.attachments?.markets || {};
    const competitions = sportData?.attachments?.competitions || {};

    // Build competitionId → league label map for target leagues
    const compLeagueMap = {};
    Object.values(competitions).forEach(function(c) {
      const label = getLeagueLabel(c.name);
      if (label) compLeagueMap[c.competitionId] = label;
    });

    if (debugMode === '1') {
      // Show target competition matches and sample of WIN-DRAW-WIN markets
      const targetComps = Object.entries(compLeagueMap).map(([id, label]) => ({
        competitionId: id,
        label,
        name: competitions[id]?.name
      }));
      const wdwMarkets = Object.values(allMarkets).filter(m => m.marketType === ML_TYPE).slice(0, 10).map(m => ({
        marketId: m.marketId,
        competitionId: m.competitionId,
        league: compLeagueMap[m.competitionId],
        marketTime: m.marketTime,
        marketStatus: m.marketStatus,
        runners: (m.runners || []).map(r => ({ id: r.selectionId, name: r.runnerName }))
      }));
      return new Response(JSON.stringify({
        totalMarkets: Object.keys(allMarkets).length,
        targetCompetitions: targetComps,
        wdwMarketSample: wdwMarkets
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Step 2: Filter markets — WIN-DRAW-WIN, target league, within time window
    // Runner order: [0]=Home, [1]=Draw, [2]=Away
    const gameMarkets = {};

    Object.values(allMarkets).forEach(function(mkt) {
      if (mkt.marketType !== ML_TYPE) return;
      const league = compLeagueMap[mkt.competitionId];
      if (!league) return;
      if (mkt.marketStatus && mkt.marketStatus !== 'OPEN') return;

      // Time window filter using marketTime
      if (!mkt.marketTime) return;
      const t = new Date(mkt.marketTime).getTime();
      if (t < nowMs - 4 * 60 * 60 * 1000 || t > nowMs + 36 * 60 * 60 * 1000) return;

      const runners = mkt.runners || [];
      if (runners.length < 2) return;

      // Identify home, draw, away by runner order / Draw selectionId
      const nonDraw = runners.filter(r => r.runnerName !== 'Draw' && r.selectionId !== 58805);
      if (nonDraw.length < 2) return;
      const home = runners[0].runnerName !== 'Draw' ? runners[0] : nonDraw[0];
      const away = runners[runners.length - 1].runnerName !== 'Draw' ? runners[runners.length - 1] : nonDraw[nonDraw.length - 1];
      if (!home || !away || home === away) return;

      const gameKey = away.runnerName + ' @ ' + home.runnerName;

      // One market per game (first WIN-DRAW-WIN wins)
      if (gameMarkets[gameKey]) return;

      const runnerNames = {};
      runners.forEach(function(r) {
        if (r.selectionId != null && r.runnerName) runnerNames[r.selectionId] = r.runnerName;
      });

      gameMarkets[gameKey] = {
        marketId: mkt.marketId,
        eventId: mkt.eventId,
        marketTime: mkt.marketTime,
        away: away.runnerName,
        home: home.runnerName,
        league,
        runnerNames
      };
    });

    if (debugMode === '2') {
      return new Response(JSON.stringify({
        filteredCount: Object.keys(gameMarkets).length,
        games: Object.entries(gameMarkets).map(([k, v]) => ({
          gameKey: k,
          league: v.league,
          marketTime: v.marketTime,
          marketId: v.marketId
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
          ml: {}
        };
      }

      (mp.runnerDetails || []).forEach(function(rd) {
        if (rd.runnerStatus !== 'ACTIVE') return;
        const price = rd.winRunnerOdds?.americanDisplayOdds?.americanOddsInt;
        if (price == null) return;
        const name = entry.runnerNames[rd.selectionId] || entry.runnerNames[String(rd.selectionId)] || '';
        // Skip Draw — we only show home/away ML
        if (!name || name === 'Draw') return;
        gamesMap[gameKey].ml[name] = price;
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
