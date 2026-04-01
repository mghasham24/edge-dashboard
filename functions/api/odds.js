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

  const now = Math.floor(Date.now() / 1000);

  // Dynamic TTL based on game state:
  // - No games today: 3600s (1 hour) — don't waste credits on empty sports
  // - All pregame: 300s (5 min)
  // - Any live game: 30s
  function getTTL(responseText) {
    try {
      const games = JSON.parse(responseText);
      if (!Array.isArray(games) || games.length === 0) return 3600;
      // If games exist but no bookmaker data yet (e.g. API reset), use short TTL
      const hasOdds = games.some(function(g) {
        return g.bookmakers && g.bookmakers.length > 0;
      });
      if (!hasOdds) return 30;
      const hasLive = games.some(function(g) {
        return g.commence_time && new Date(g.commence_time).getTime() / 1000 <= now;
      });
      return hasLive ? 30 : 300;
    } catch(e) {
      return 30;
    }
  }

  const cacheKey = 'odds_' + sport + '_' + markets;

  // Try cache first
  try {
    const cached = await env.DB.prepare(
      'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
    ).bind(cacheKey).first();
    if (cached) {
      const ttl = getTTL(cached.data);
      if ((now - cached.fetched_at) < ttl) {
        return new Response(cached.data, {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
  } catch(e) {}

  // Cache miss — fetch from Odds API, with DraftKings fallback if FanDuel is empty
  async function fetchOdds(bookmakerList) {
    const apiUrl = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${API_KEY}&regions=us&markets=${markets}&bookmakers=${bookmakerList}&oddsFormat=american`;
    const res = await fetch(apiUrl);
    const text = await res.text();
    return { res, text };
  }

  function hasBookmakerOdds(text) {
    try {
      const games = JSON.parse(text);
      return Array.isArray(games) && games.some(g => g.bookmakers && g.bookmakers.length > 0);
    } catch(e) { return false; }
  }

  try {
    // First try FanDuel
    let { res, text } = await fetchOdds('fanduel');

    // If FanDuel has no odds, fall back to DraftKings
    if (!hasBookmakerOdds(text)) {
      const fallback = await fetchOdds('draftkings');
      if (hasBookmakerOdds(fallback.text)) {
        res = fallback.res;
        text = fallback.text;
        // Normalize DraftKings key to fanduel so frontend works unchanged
        text = text.replace(/"key":"draftkings"/g, '"key":"fanduel"').replace(/"title":"DraftKings"/g, '"title":"FanDuel (DK)"');
      }
    }

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
