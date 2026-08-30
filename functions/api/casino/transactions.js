// functions/api/casino/transactions.js
// GET /api/casino/transactions        — current user's last 50 transactions
// GET /api/casino/transactions?admin=1 — admin: all users, last 200 each type

import { getSession }  from '../../_lib/session.js';
import { ok, err }     from '../../_lib/response.js';
import { rsUrlEncode } from '../../_lib/hashids.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);

  const url     = new URL(request.url);
  const isAdmin = url.searchParams.get('admin') === '1';

  if (isAdmin) {
    const user = await env.DB.prepare('SELECT is_admin FROM users WHERE id=?')
      .bind(session.user_id).first();
    if (!user?.is_admin) return err('Forbidden', 403);

    const [deps, wds] = await Promise.all([
      env.DB.prepare(
        `SELECT cd.id, cd.user_id, u.email, 'deposit' AS type,
                cd.rax_requested AS amount, cd.rax_credited, cd.status, cd.created_at
         FROM casino_deposits cd
         JOIN users u ON u.id = cd.user_id
         ORDER BY cd.created_at DESC LIMIT 200`
      ).all(),
      env.DB.prepare(
        `SELECT cw.id, cw.user_id, u.email, 'withdrawal' AS type,
                cw.amount, NULL AS rax_credited, cw.status, cw.created_at
         FROM casino_withdrawals cw
         JOIN users u ON u.id = cw.user_id
         ORDER BY cw.created_at DESC LIMIT 200`
      ).all(),
    ]);

    const rows = [...(deps.results || []), ...(wds.results || [])]
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 300);

    return ok({ transactions: rows });
  }

  const userId = session.user_id;
  const [deps, wds] = await Promise.all([
    env.DB.prepare(
      `SELECT id, 'deposit' AS type, rax_requested AS amount, rax_credited, card_id, status, created_at
       FROM casino_deposits WHERE user_id=? ORDER BY created_at DESC LIMIT 50`
    ).bind(userId).all(),
    env.DB.prepare(
      `SELECT id, 'withdrawal' AS type, amount, NULL AS rax_credited, NULL AS card_id, status, created_at
       FROM casino_withdrawals WHERE user_id=? ORDER BY created_at DESC LIMIT 50`
    ).bind(userId).all(),
  ]);

  const depRows = (deps.results || []).map(d => ({
    ...d,
    card_url: d.card_id ? 'https://www.realapp.com/' + rsUrlEncode(20, 0, 0, d.card_id) : null,
  }));

  const rows = [...depRows, ...(wds.results || [])]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 50);

  return ok({ transactions: rows });
}
