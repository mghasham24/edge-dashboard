// functions/api/kalshi/rfi.js
// Fetches KXMLBRFI markets from Kalshi public API, returns devigged fair values per game

const KALSHI_URL = 'https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXMLBRFI&limit=100';
const CACHE_TTL = 300;
const MAX_SPREAD = 0.20; // skip markets where spread > 20 cents

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

const KALSHI_TEAM = {
  'St. Louis': 'St. Louis Cardinals', 'Detroit': 'Detroit Tigers',
  'New York M': 'New York Mets', 'San Francisco': 'San Francisco Giants',
  'Seattle': 'Seattle Mariners', 'Los Angeles A': 'Los Angeles Angels',
  'Atlanta': 'Atlanta Braves', 'Arizona': 'Arizona Diamondbacks',
  'Houston': 'Houston Astros', "A's": 'Athletics',
  'Philadelphia': 'Philadelphia Phillies', 'Colorado': 'Colorado Rockies',
  'Cincinnati': 'Cincinnati Reds', 'Texas': 'Texas Rangers',
  'Milwaukee': 'Milwaukee Brewers', 'Kansas City': 'Kansas City Royals',
  'Toronto': 'Toronto Blue Jays', 'Chicago WS': 'Chicago White Sox',
  'Tampa Bay': 'Tampa Bay Rays', 'Minnesota': 'Minnesota Twins',
  'Chicago C': 'Chicago Cubs', 'Cleveland': 'Cleveland Guardians',
  'Los Angeles D': 'Los Angeles Dodgers', 'Washington': 'Washington Nationals',
  'Miami': 'Miami Marlins', 'New York Y': 'New York Yankees',
  'Baltimore': 'Baltimore Orioles', 'Pittsburgh': 'Pittsburgh Pirates',
  'San Diego': 'San Diego Padres', 'Boston': 'Boston Red Sox',
};

function parseTitle(title) {
  const m = title.match(/^(.+?) vs (.+?) First Inning Run\??$/i);
  if (!m) return null;
  const away = KALSHI_TEAM[m[1].trim()] || m[1].trim();
  const home  = KALSHI_TEAM[m[2].trim()] || m[2].trim();
  return { away, home };
}

function toAm(p) {
  if (p >= 0.5) return Math.round(-100 * p / (1 - p));
  return Math.round(100 * (1 - p) / p);
}

// Use ask prices only to avoid zero-bid skew on illiquid markets
function devig(yesAsk, noAsk, yesBid) {
  const ya = parseFloat(yesAsk);
  const na = parseFloat(noAsk);
  const yb = parseFloat(yesBid);
  if (ya <= 0.05 || ya >= 0.95) return null;
  if (na <= 0.05 || na >= 0.95) return null;
  if (yb > 0 && (ya - yb) > MAX_SPREAD) return null;
  const total = ya + na;
  if (!total) return null;
  const yesFair = ya / total;
  const noFair  = na / total;
  return { yesFair, noFair, yesMid: Math.round(ya * 100), noMid: Math.round(na * 100), yesAm: toAm(yesFair), noAm: toAm(noFair) };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');

  const now = Math.floor(Date.now() / 1000);
  const cacheKey = 'kalshi_rfi';

  try {
    const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
    if (cached && (now - cached.fetched_at) < CACHE_TTL) {
      return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
    }
  } catch(e) {}

  try {
    const res = await fetch(KALSHI_URL, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return fail(res.status, 'Kalshi fetch failed');

    const data = await res.json();
    const rfiMap = {};

    for (const mkt of (data.markets || [])) {
      if (!mkt.title) continue;
      const teams = parseTitle(mkt.title);
      if (!teams) continue;
      const fair = devig(mkt.yes_ask_dollars, mkt.no_ask_dollars, mkt.yes_bid_dollars);
      if (!fair) continue;
      rfiMap[teams.away + ' @ ' + teams.home] = {
        yesFair: fair.yesFair, noFair: fair.noFair,
        yesMid: fair.yesMid, noMid: fair.noMid,
        yesAm: fair.yesAm, noAm: fair.noAm,
        ticker: mkt.ticker, volume: parseFloat(mkt.volume_fp) || 0
      };
    }

    const body = JSON.stringify({ ok: true, rfi: rfiMap });
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
