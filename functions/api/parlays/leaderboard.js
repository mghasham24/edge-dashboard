// GET /api/parlays/leaderboard — public, no auth required
// ?period=weekly (default) — fixed Mon 12:00 AM → Sun 11:59 PM ET week
// ?period=alltime          — all-time, cached 10 min

const CACHE_TTL = { weekly: 300, alltime: 600 };

// Returns the start (Monday midnight ET) and end (next Monday midnight ET)
// of the current ET calendar week as Unix seconds.
function currentEtWeekWindow() {
  const now = Date.now();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(now));
  const day = parts.find(p => p.type === 'weekday').value; // 'Sun'–'Sat'
  const h   = parseInt(parts.find(p => p.type === 'hour').value);
  const m   = parseInt(parts.find(p => p.type === 'minute').value);
  const s   = parseInt(parts.find(p => p.type === 'second').value);

  const nowSec     = Math.floor(now / 1000);
  const etMidnight = nowSec - (h * 3600 + m * 60 + s);

  const DAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dayIdx         = DAY.indexOf(day);
  const daysSinceMon   = dayIdx === 0 ? 6 : dayIdx - 1; // Mon=0 … Sun=6

  const weekStart = etMidnight - daysSinceMon * 86400; // this Monday 00:00 ET
  const weekEnd   = weekStart  + 7 * 86400;            // next Monday 00:00 ET

  return { weekStart, weekEnd };
}

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

  let windowStart, windowEnd;
  if (period === 'weekly') {
    ({ weekStart: windowStart, weekEnd: windowEnd } = currentEtWeekWindow());
  } else {
    windowStart = 0;
    windowEnd   = now + 86400; // effectively no upper bound
  }

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
      AND p.deposited_at < ?
      AND p.deposited_at IS NOT NULL
      AND ra.rs_username IS NOT NULL
      AND ra.parlay_verified = 1
    GROUP BY p.user_id
    HAVING net_profit > 0
    ORDER BY net_profit DESC
    LIMIT 25
  `).bind(windowStart, windowEnd).all();

  const payload = JSON.stringify({ results, generatedAt: now, period, windowStart, windowEnd });

  await env.DB.prepare(
    'INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at'
  ).bind(cacheKey, payload, now).run().catch(() => {});

  return new Response(payload, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
  });
}
