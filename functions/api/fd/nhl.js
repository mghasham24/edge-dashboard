// functions/api/fd/nhl.js
// Fetches FanDuel real-time NHL moneyline, spread, and total odds via FD's native API
// Step 1: Get today's NHL event IDs from content-managed-page
// Step 2: Fetch event-page per game to collect ML, spread, and total market IDs + runner names
// Step 3: Batch POST to getMarketPrices for real-time prices

const FD_AK         = 'FhMFpcPWXMeyZxOx';
const FD_LIST_URL   = `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=nhl&_ak=${FD_AK}&timezone=America/New_York`;

// Known NHL team name fragments — used to filter out college hockey on the same page
const NHL_TEAMS = new Set([
  'Ducks','Coyotes','Bruins','Sabres','Flames','Hurricanes','Blackhawks','Avalanche',
  'Blue Jackets','Stars','Red Wings','Oilers','Panthers','Kings','Wild','Canadiens',
  'Predators','Devils','Islanders','Rangers','Senators','Flyers','Penguins','Sharks',
  'Kraken','Blues','Lightning','Maple Leafs','Canucks','Golden Knights','Capitals',
  'Jets','Utah Hockey Club'
]);
function isNHLTeam(name) {
  return [...NHL_TEAMS].some(t => name.includes(t));
}
const FD_EVENT_URL  = (id) => `https://sbapi.nj.sportsbook.fanduel.com/api/event-page?_ak=${FD_AK}&eventId=${id}&tab=all&timezone=America/New_York`;
const FD_PRICES_URL = 'https://smp.nj.sportsbook.fanduel.com/api/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=0';
const SPREAD_TYPE   = 'MATCH_HANDICAP_(2-WAY)';
const ML_TYPE       = 'MONEY_LINE';
const TOTAL_TYPE    = 'TOTAL_POINTS_(OVER/UNDER)';
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
  const cacheKey = 'fd_nhl';

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
    const listRes = await fetch(FD_LIST_URL, { headers });
    if (!listRes.ok) return fail(listRes.status, 'FD NHL list fetch failed');
    const listData = await listRes.json();

    const events = listData?.attachments?.events || {};
    const nowMs = Date.now();
    const etFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
    const todayET     = etFmt.format(new Date());
    const yesterdayET = etFmt.format(new Date(nowMs - 24 * 60 * 60 * 1000));
    const todayEvents = Object.values(events).filter(e => {
      if (!e.openDate) return false;
      const t = new Date(e.openDate).getTime();
      if (t < nowMs - 4 * 60 * 60 * 1000) return false; // skip games started >4h ago
      // Include yesterday's ET games — late games cross the midnight ET boundary
      const openDateET = etFmt.format(new Date(e.openDate));
      if (openDateET !== todayET && openDateET !== yesterdayET) return false;
      // Filter out non-NHL hockey (college, etc.) by checking team names
      const teams = parseEventName(e.name);
      if (!teams) return false;
      return isNHLTeam(teams.away) || isNHLTeam(teams.home);
    });

    if (!todayEvents.length) {
      return new Response(JSON.stringify({ ok: true, games: {} }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Fetch event-pages to collect ML, spread, and total market IDs + runner names
    const gameData = {}; // gameKey → { spreadId, mlId, totalId, runnerNames }

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
        const entry = { eventId: event.eventId, openDate: event.openDate, away: teams.away, home: teams.home, spreadRunners: {}, mlRunners: {}, totalRunners: {}, allMarketTypes: [] };

        Object.entries(markets).forEach(function([marketId, mkt]) {
          const mktType = mkt.marketType || '';
          if (!entry.allMarketTypes.includes(mktType)) entry.allMarketTypes.push(mktType);
          if (mktType === SPREAD_TYPE) {
            if (!entry.spreadId) entry.spreadId = marketId;
            (mkt.runners || []).forEach(function(ref) {
              if (ref.selectionId != null && ref.runnerName) entry.spreadRunners[ref.selectionId] = ref.runnerName;
            });
          } else if (mktType === ML_TYPE) {
            if (!entry.mlId) entry.mlId = marketId;
            (mkt.runners || []).forEach(function(ref) {
              if (ref.selectionId != null && ref.runnerName) entry.mlRunners[ref.selectionId] = ref.runnerName;
            });
          } else if (mktType === TOTAL_TYPE) {
            // Among multiple total markets (e.g. game total vs period total), prefer the one
            // whose runners are named "Over"/"Under" — period totals sometimes use team names.
            const runners = {};
            (mkt.runners || []).forEach(function(ref) {
              if (ref.selectionId != null && ref.runnerName) runners[ref.selectionId] = ref.runnerName;
            });
            const hasOverUnder = Object.values(runners).some(function(n) {
              const nl = n.toLowerCase();
              return nl === 'over' || nl === 'under';
            });
            // Always keep the latest Over/Under total market (highest market ID).
            // For live games, FD adds a new in-play total market with a higher ID —
            // that's what FD's website shows. The original game-total market goes stale.
            if (hasOverUnder) {
              entry.totalId = marketId;
              entry.totalRunners = runners;
            }
          }
        });

        if (entry.spreadId || entry.mlId || entry.totalId) {
          gameData[gameKey] = entry;
        }
      } catch(e) {}

      if (i < todayEvents.length - 1) await new Promise(r => setTimeout(r, 150));
    }

    if (debugMode === '2') {
      const dbgGames = Object.entries(gameData).map(([gameKey, entry]) => ({
        game: gameKey,
        spreadId: entry.spreadId || null,
        mlId: entry.mlId || null,
        totalId: entry.totalId || null,
        allMarketTypes: entry.allMarketTypes || [],
        spreadRunners: entry.spreadRunners,
        totalRunners: entry.totalRunners,
      }));
      return new Response(JSON.stringify({ count: dbgGames.length, games: dbgGames }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Batch all market IDs into one getMarketPrices request
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

    const gamesMap = {};

    marketPricesList.forEach(function(mp) {
      const mapping = marketToGame[mp.marketId];
      if (!mapping || mp.marketStatus !== 'OPEN') return;
      const { gameKey, type } = mapping;
      const entry = gameData[gameKey];
      if (!gamesMap[gameKey]) gamesMap[gameKey] = { id: entry.eventId, away: entry.away, home: entry.home, cm: entry.openDate, spreads: {}, totals: {}, ml: {} };
      const game = gamesMap[gameKey];

      const runnerMap = type === 'spread' ? entry.spreadRunners : type === 'ml' ? entry.mlRunners : entry.totalRunners;
      (mp.runnerDetails || []).forEach(function(rd) {
        if (rd.runnerStatus !== 'ACTIVE') return;
        const price = rd.winRunnerOdds?.americanDisplayOdds?.americanOddsInt;
        if (price == null) return;
        const name = (runnerMap[rd.selectionId] || runnerMap[String(rd.selectionId)] || '');
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
