// functions/api/casino/withdraw.js
// POST /api/casino/withdraw
// Deducts amount from casino_balance atomically, creates a casino_withdrawals record.
// Admin processes withdrawals via the Casino Withdrawals tab and sends Rax via edgebot.

import { getSession } from '../../_lib/session.js';
import { err }        from '../../_lib/response.js';

const MIN_WITHDRAWAL = 1000;
const DAILY_CAP      = 100000; // max total Rax paid out per day across all users

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);
  const userId = session.user_id;

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON', 400); }

  const amount = body.amount;
  if (!Number.isInteger(amount) || amount < MIN_WITHDRAWAL)
    return err(`Minimum withdrawal is ${MIN_WITHDRAWAL} Rax.`, 400);

  // Verify user has a linked RS username (needed for payout)
  const user = await env.DB.prepare(
    'SELECT casino_balance, rs_username FROM users WHERE id = ?'
  ).bind(userId).first();
  if (!user) return err('User not found.', 404);
  if (!user.rs_username) return err('Link your RealSports account before withdrawing.', 400);
  if (user.casino_balance < amount) return err('Insufficient casino balance.', 402);

  // Check daily withdrawal cap
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const dailyRow = await env.DB.prepare(
    "SELECT SUM(amount) AS total FROM casino_withdrawals WHERE status != 'failed' AND date(created_at,'unixepoch') = ?"
  ).bind(today).first();
  const dailyTotal = dailyRow?.total ?? 0;
  if (dailyTotal + amount > DAILY_CAP)
    return err('Daily withdrawal limit reached. Try again tomorrow.', 429);

  const now = Math.floor(Date.now() / 1000);

  // Atomic deduction — guards against race conditions
  const deduct = await env.DB.prepare(
    'UPDATE users SET casino_balance = casino_balance - ? WHERE id = ? AND casino_balance >= ?'
  ).bind(amount, userId, amount).run();
  if (deduct.meta.changes === 0)
    return err('Insufficient casino balance.', 402);

  const result = await env.DB.prepare(
    'INSERT INTO casino_withdrawals (user_id, amount, rs_username, status, created_at) VALUES (?,?,?,?,?)'
  ).bind(userId, amount, user.rs_username, 'pending', now).run();

  const balance = await env.DB.prepare('SELECT casino_balance FROM users WHERE id = ?')
    .bind(userId).first();

  return new Response(JSON.stringify({
    ok:             true,
    withdrawal_id:  result.meta.last_row_id,
    amount,
    rs_username:    user.rs_username,
    status:         'pending',
    casino_balance: balance?.casino_balance ?? 0,
    message:        'Withdrawal requested. You will receive Rax on RealSports within 24 hours.',
  }), { headers: { 'Content-Type': 'application/json' } });
}
