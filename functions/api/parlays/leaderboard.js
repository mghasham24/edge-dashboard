// GET /api/parlays/leaderboard — public, no auth required
// ?period=weekly (default) — rolling 7-day window, cached 5 min
// ?period=alltime          — all-time, cached 10 min

const CACHE_TTL = { weekly: 300, alltime: 600 };

export async function onRequestGet({ request, env }) {
  const { searchParams } = new URL(request.url);
  const period   = searchParams.get('period') === 'alltime' ? 'alltime' : 'weekly';
  const now      = Math.floor(Date.now() / 1000);
  const cacheKey = 'leaderboard:earnings:' + period;

  const cached = await env.DB.prepare(
    'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
  ).bind(cacheKey).first();

  if (cached && (now - cached.fetched_at) < CACHE_TTL[period]) {
    return new Response(cached.data, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
    });
  }

  const weekAgo  = now - 604800;
  const windowStart = period === 'weekly' ? weekAgo : 0;

  const { results } = await env.DB.prepare(`
    SELECT
      ra.rs_username,
      SUM(CASE WHEN p.status='won' THEN p.payout_rax - p.stake_rax ELSE -p.stake_rax END) AS net_profit,
      SUM(CASE WHEN p.status='won' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN p.status='lost' THEN 1 ELSE 0 END) AS losses
    FROM parlays p
    JOIN real_auth ra ON ra.user_id = p.user_id
    WHERE p.status IN ('won','lost')
      AND (p.is_free_play IS NULL OR p.is_free_play = 0)
      AND p.deposited_at >= ?
      AND p.deposited_at IS NOT NULL
      AND ra.rs_username IS NOT NULL
      AND ra.parlay_verified = 1
    GROUP BY p.user_id
    HAVING net_profit > 0
    ORDER BY net_profit DESC
    LIMIT 25
  `).bind(windowStart).all();

  const payload = JSON.stringify({ results, generatedAt: now, period, windowStart });

  await env.DB.prepare(
    'INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at'
  ).bind(cacheKey, payload, now).run().catch(() => {});

  return new Response(payload, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
  });
}
