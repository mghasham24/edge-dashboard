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

  // JOIN against real_auth to avoid IN(...) with hundreds of params
  const [depsRows, wdsRows] = await Promise.all([
    env.DB.prepare(
      `SELECT cd.id, cd.user_id, cd.rax_requested, cd.rax_credited, cd.card_id, cd.status, cd.created_at
       FROM casino_deposits cd
       JOIN real_auth ra ON ra.user_id = cd.user_id AND ra.parlay_verified = 1
       WHERE cd.status IN ('confirmed','pending')
       ORDER BY cd.created_at DESC`
    ).all(),
    env.DB.prepare(
      `SELECT cw.id, cw.user_id, cw.amount, cw.rs_username, cw.target_card_id, cw.status, cw.created_at
       FROM casino_withdrawals cw
       JOIN real_auth ra ON ra.user_id = cw.user_id AND ra.parlay_verified = 1
       ORDER BY cw.created_at DESC`
    ).all(),
  ]);

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
