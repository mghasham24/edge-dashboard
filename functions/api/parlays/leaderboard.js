// GET /api/parlays/leaderboard — public, no auth required
// ?period=weekly (default) — fixed Mon 12:00 AM → Sun 11:59 PM ET week
// ?period=alltime          — all-time, cached 10 min

const CACHE_TTL = { weekly: 300, alltime: 600 };
const BLOCKED_USERNAMES = new Set(['moe_']);

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
      ra.rs_user_id,
      ra.rs_avatar_url,
      p.user_id,
      SUM(CASE WHEN p.status='won' THEN p.payout_rax ELSE 0 END) AS total_winnings,
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
    HAVING total_winnings > 0
    ORDER BY total_winnings DESC
    LIMIT 500
  `).bind(windowStart, windowEnd).all();

  // Fetch winning slips + legs for all qualifying users in the same window
  const { results: slipRows } = await env.DB.prepare(`
    WITH qualifiers AS (
      SELECT p.user_id
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
      HAVING SUM(CASE WHEN p.status='won' THEN p.payout_rax ELSE 0 END) > 0
    )
    SELECT p.id AS parlay_id, p.user_id, p.stake_rax, p.payout_rax, p.legs_count, p.deposited_at,
           pl.player_name, pl.market_type, pl.label, pl.direction, pl.threshold, pl.american_odds
    FROM parlays p
    JOIN qualifiers q ON q.user_id = p.user_id
    JOIN parlay_legs pl ON pl.parlay_id = p.id
    WHERE p.status = 'won'
      AND (p.is_free_play IS NULL OR p.is_free_play = 0)
      AND p.deposited_at >= ?
      AND p.deposited_at < ?
    ORDER BY p.user_id, p.id, pl.id
  `).bind(windowStart, windowEnd, windowStart, windowEnd).all();

  // Group legs by user_id → parlay_id
  const slipsByUser = {};
  for (const row of (slipRows || [])) {
    if (!slipsByUser[row.user_id]) slipsByUser[row.user_id] = {};
    const pm = slipsByUser[row.user_id];
    if (!pm[row.parlay_id]) {
      pm[row.parlay_id] = {
        id: row.parlay_id,
        stake_rax: row.stake_rax,
        payout_rax: row.payout_rax,
        legs_count: row.legs_count,
        deposited_at: row.deposited_at,
        legs: [],
      };
    }
    pm[row.parlay_id].legs.push({
      player_name: row.player_name,
      market_type: row.market_type,
      label: row.label,
      direction: row.direction,
      threshold: row.threshold,
      american_odds: row.american_odds,
    });
  }

  const enriched = results.filter(r => !BLOCKED_USERNAMES.has(r.rs_username)).map(r => ({
    rs_username: r.rs_username,
    rs_user_id: r.rs_user_id || null,
    rs_avatar_url: r.rs_avatar_url || null,
    total_winnings: r.total_winnings,
    wins: r.wins,
    losses: r.losses,
    slips: slipsByUser[r.user_id]
      ? Object.values(slipsByUser[r.user_id]).sort((a, b) => (b.payout_rax - b.stake_rax) - (a.payout_rax - a.stake_rax))
      : [],
  }));

  const payload = JSON.stringify({ results: enriched, generatedAt: now, period, windowStart, windowEnd });

  await env.DB.prepare(
    'INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at'
  ).bind(cacheKey, payload, now).run().catch(() => {});

  return new Response(payload, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
  });
}
