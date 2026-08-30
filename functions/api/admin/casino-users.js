// functions/api/admin/casino-users.js
// GET /api/admin/casino-users — admin-only
// Returns all RS-verified users with casino balances and full deposit/withdrawal history.

import { getSession } from '../../_lib/session.js';
import { ok, err }    from '../../_lib/response.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);

  const admin = await env.DB.prepare('SELECT is_admin FROM users WHERE id=?')
    .bind(session.user_id).first();
  if (!admin?.is_admin) return err('Forbidden', 403);

  // All RS-verified users with casino balance
  const usersRows = await env.DB.prepare(
    `SELECT u.id, u.email, u.casino_balance,
            ra.rs_username
     FROM users u
     JOIN real_auth ra ON ra.user_id = u.id
     WHERE ra.parlay_verified = 1
     ORDER BY u.casino_balance DESC, u.id DESC`
  ).all();

  const users = usersRows.results || [];
  if (!users.length) return ok({ users: [] });

  const userIds = users.map(u => u.id);
  const ph      = userIds.map(() => '?').join(',');

  // All confirmed/pending deposits for these users
  const depsRows = await env.DB.prepare(
    `SELECT id, user_id, rax_requested, rax_credited, card_id, status, created_at
     FROM casino_deposits
     WHERE user_id IN (${ph}) AND status IN ('confirmed','pending')
     ORDER BY created_at DESC`
  ).bind(...userIds).all();

  // All withdrawals for these users
  const wdsRows = await env.DB.prepare(
    `SELECT id, user_id, amount, rs_username, target_card_id, status, created_at
     FROM casino_withdrawals
     WHERE user_id IN (${ph})
     ORDER BY created_at DESC`
  ).bind(...userIds).all();

  const deps = depsRows.results || [];
  const wds  = wdsRows.results  || [];

  // Group by user_id
  const depsByUser = {};
  const wdsByUser  = {};
  for (const d of deps) {
    if (!depsByUser[d.user_id]) depsByUser[d.user_id] = [];
    depsByUser[d.user_id].push(d);
  }
  for (const w of wds) {
    if (!wdsByUser[w.user_id]) wdsByUser[w.user_id] = [];
    wdsByUser[w.user_id].push(w);
  }

  const result = users.map(u => ({
    id:            u.id,
    email:         u.email,
    rs_username:   u.rs_username,
    casino_balance: u.casino_balance || 0,
    deposits:      depsByUser[u.id]  || [],
    withdrawals:   wdsByUser[u.id]   || [],
  }));

  return ok({ users: result });
}
