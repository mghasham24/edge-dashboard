// functions/api/fd/wnbaalts.js
// Fetches FanDuel real-time WNBA spread, ML, and total odds via FD's native API
// Identical flow to nbaalts.js — only customPageId differs (wnba vs nba)

const FD_AK        = 'FhMFpcPWXMeyZxOx';
const FD_LIST_URL  = `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=wnba&_ak=${FD_AK}&timezone=America/New_York`;
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
  const reqUrl = new URL(request.url);
  const cronKey = reqUrl.searchParams.get('_cron_key');
  let session;
  if (cronKey && env.CRON_SECRET && cronKey === env.CRON_SECRET) {
    session = { user_id: 0, plan: 'pro', is_admin: 1 };
  } else {
    session = await getSession(request, env.DB);
    if (!session) return fail(401, 'Not authenticated');
  }

  const now = Math.floor(Date.now() / 1000);
  const cacheKey = 'fd_wnba_alts';

  try {
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
    const listRes = await fetch(FD_LIST_URL, { headers });
    if (!listRes.ok) return fail(listRes.status, 'FD WNBA list fetch failed');
    const listData = await listRes.json();

    const events = listData?.attachments?.events || {};
    const nowMs = Date.now();
    const etFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
    const todayET     = etFmt.format(new Date());
    const yesterdayET = etFmt.format(new Date(nowMs - 24 * 60 * 60 * 1000));
    const todayEvents = Object.values(events).filter(e => {
      if (!e.openDate) return false;
      const t = new Date(e.openDate).getTime();
      if (t < nowMs - 4 * 60 * 60 * 1000) return false;
      const openDateET = etFmt.format(new Date(e.openDate));
      return openDateET === todayET || openDateET === yesterdayET;
    });

    if (!todayEvents.length) {
      return new Response(JSON.stringify({ ok: true, games: {} }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const gameData = {};

    await Promise.all(todayEvents.map(async (event) => {
      const teams = parseEventName(event.name);
      if (!teams) return;
      try {
        const evRes = await fetch(FD_EVENT_URL(event.eventId), { headers });
        if (!evRes.ok) return;
        const evData = await evRes.json();

        const markets = evData?.attachments?.markets || {};
        const gameKey = teams.away + ' @ ' + teams.home;
        const entry = { eventId: event.eventId, openDate: event.openDate, away: teams.away, home: teams.home, runnerNames: {} };

        Object.entries(markets).forEach(function([marketId, mkt]) {
          const mktType = mkt.marketType || '';
          if (mktType === SPREAD_TYPE)      entry.spreadId = marketId;
          else if (mktType === ML_TYPE)     entry.mlId     = marketId;
          else if (mktType === TOTAL_TYPE)  entry.totalId  = marketId;
          else return;
          (mkt.runners || []).forEach(function(ref) {
            if (ref.selectionId != null && ref.runnerName) {
              entry.runnerNames[ref.selectionId] = ref.runnerName;
            }
          });
        });

        if (entry.spreadId || entry.mlId || entry.totalId) {
          gameData[gameKey] = entry;
        }
      } catch(e) {}
    }));

    const allMarketIds = [];
    const marketToGame = {};

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

    // Load previous cache to freeze odds for live games with suspended markets
    let prevGames = {};
    try {
      const prev = await env.DB.prepare('SELECT data FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
      if (prev) prevGames = JSON.parse(prev.data).games || {};
    } catch(e) {}

    const gamesMap = {};

    marketPricesList.forEach(function(mp) {
      const mapping = marketToGame[mp.marketId];
      if (!mapping) return;
      const { gameKey, type } = mapping;
      const entry = gameData[gameKey];

      if (mp.marketStatus === 'SUSPENDED') {
        if (!gamesMap[gameKey]) {
          const frozen = prevGames[gameKey] || prevGames[entry.away + ' @ ' + entry.home] || null;
          if (frozen && (Object.keys(frozen.ml || {}).length || Object.keys(frozen.spreads || {}).length)) {
            gamesMap[gameKey] = { ...frozen, id: entry.eventId, away: entry.away, home: entry.home, cm: entry.openDate, live: true };
          }
        }
        return;
      }
      if (mp.marketStatus !== 'OPEN') return;
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
