// functions/api/odds.js
export async function onRequest(context) {
  const { request, env } = context;
  const API_KEY = env.ODDS_API_KEY;
  if (!API_KEY) {
    return new Response(JSON.stringify({ error: 'Missing API key' }), { status: 500 });
  }

  const url        = new URL(request.url);
  const sport      = url.searchParams.get('sport')      || 'basketball_nba';
  const markets    = url.searchParams.get('markets')    || 'h2h';
  const bookmakers = url.searchParams.get('bookmakers') || 'fanduel,draftkings,betmgm,caesars';

  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');

  const TTL = 60;
  const cacheKey = 'odds_' + sport + '_' + markets;
  const now = Math.floor(Date.now() / 1000);

  // Try cache first
  try {
    const cached = await env.DB.prepare(
      'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
    ).bind(cacheKey).first();
    if (cached && (now - cached.fetched_at) < TTL) {
      return new Response(cached.data, {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch(e) {}

  // Cache miss — fetch from Odds API
  const apiUrl = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${API_KEY}&regions=us&markets=${markets}&bookmakers=${bookmakers}&oddsFormat=american`;

  try {
    const res  = await fetch(apiUrl);
    const text = await res.text();

    // Write to cache
    try {
      await env.DB.prepare(
        'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
      ).bind(cacheKey, text, now).run();
    } catch(e) {}

    return new Response(text, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'x-requests-remaining': res.headers.get('x-requests-remaining') || ''
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 502 });
  }
}

async function getSession(request, db) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return null;
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    'SELECT u.id as user_id, u.plan, u.is_admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(m[1], now).first();
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
