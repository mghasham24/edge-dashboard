// POST /api/parlays/leaderboard-reward?_cron_key=...
// Called by alert-cron every Monday at 8 AM ET.
// Queries last week's top 3 (Mon–Sun), inserts payout_queue entries,
// logs to leaderboard_reward_log, and DMs each winner on Telegram.

import { getSessionOrCron } from '../../../_lib/auth.js';

const REWARDS = [
  { rank: 1, amount: 5000 },
  { rank: 2, amount: 2500 },
  { rank: 3, amount: 1000 },
];

function etParts(nowMs) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(nowMs));
  return {
    day: parts.find(p => p.type === 'weekday').value,
    h:   parseInt(parts.find(p => p.type === 'hour').value),
    m:   parseInt(parts.find(p => p.type === 'minute').value),
    s:   parseInt(parts.find(p => p.type === 'second').value),
  };
}

async function sendTg(botToken, chatId, text) {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
}

export async function onRequestPost({ request, env }) {
  const auth = await getSessionOrCron(request, env);
  if (!auth.ok || !auth.isCron) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const et  = etParts(now * 1000);

  // Only run on Monday 8 AM ET — cron guard
  if (et.day !== 'Mon' || et.h !== 8) {
    return new Response(JSON.stringify({ ok: false, reason: 'not Monday 8 AM ET', day: et.day, hour: et.h }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Compute last week's window: Sun midnight ET (= Mon midnight ET) back 7 days
  const mondayMidnightET = now - (et.h * 3600 + et.m * 60 + et.s);
  const windowEnd   = mondayMidnightET;
  const windowStart = windowEnd - 604800;

  // Week key = ISO date of last Monday (start of the rewarded week)
  const weekKey = new Date(windowStart * 1000).toISOString().slice(0, 10);

  // Idempotency — if rank 1 already logged for this week, we already ran
  const already = await env.DB.prepare(
    'SELECT id FROM leaderboard_reward_log WHERE week_key=? AND rank=1'
  ).bind(weekKey).first();
  if (already) {
    return new Response(JSON.stringify({ ok: true, skipped: true, weekKey }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Query last week's top 3
  const { results: winners } = await env.DB.prepare(`
    SELECT p.user_id, ra.rs_username,
      SUM(CASE WHEN p.status='won' THEN p.payout_rax - p.stake_rax ELSE -p.stake_rax END) AS net_profit
    FROM parlays p
    JOIN real_auth ra ON ra.user_id = p.user_id
    WHERE p.status IN ('won','lost')
      AND (p.is_free_play IS NULL OR p.is_free_play = 0)
      AND p.deposited_at >= ? AND p.deposited_at < ?
      AND p.deposited_at IS NOT NULL
      AND ra.rs_username IS NOT NULL
      AND ra.parlay_verified = 1
    GROUP BY p.user_id
    HAVING net_profit > 0
    ORDER BY net_profit DESC
    LIMIT 3
  `).bind(windowStart, windowEnd).all();

  const rewarded = [];

  for (let i = 0; i < winners.length; i++) {
    const w      = winners[i];
    const reward = REWARDS[i];
    const offerAmount = Math.ceil(reward.amount / 0.9);

    // Insert into payout_queue (parlay_id=NULL — reward, not a parlay win)
    await env.DB.prepare(`
      INSERT INTO payout_queue
        (parlay_id, user_id, rs_username, payout_rax, offer_amount, status, notes, created_at)
      VALUES (NULL, ?, ?, ?, ?, 'pending', ?, unixepoch())
    `).bind(
      w.user_id, w.rs_username, reward.amount, offerAmount,
      'leaderboard_reward:' + weekKey + ':rank' + reward.rank,
    ).run();

    // Log for idempotency
    await env.DB.prepare(`
      INSERT OR IGNORE INTO leaderboard_reward_log
        (week_key, rank, user_id, rs_username, amount_rax, rewarded_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(weekKey, reward.rank, w.user_id, w.rs_username, reward.amount, now).run();

    // Telegram DM if connected
    if (env.TELEGRAM_BOT_TOKEN) {
      const user = await env.DB.prepare(
        'SELECT telegram_chat_id FROM users WHERE id=?'
      ).bind(w.user_id).first();
      if (user && user.telegram_chat_id) {
        const medals = ['🥇', '🥈', '🥉'];
        const msg =
          `${medals[i]} *Leaderboard Reward!*\n\n` +
          `You finished *#${reward.rank}* on the RaxEdge parlay leaderboard last week!\n\n` +
          `*+${reward.amount.toLocaleString()} Rax* is on its way to your RS account.\n\n` +
          `Keep it up! 🔥`;
        await sendTg(env.TELEGRAM_BOT_TOKEN, user.telegram_chat_id, msg);
      }
    }

    rewarded.push({ rank: reward.rank, rs_username: w.rs_username, amount: reward.amount });
  }

  return new Response(JSON.stringify({ ok: true, weekKey, rewarded }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
