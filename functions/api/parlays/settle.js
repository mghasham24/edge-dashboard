// functions/api/parlays/settle.js
// POST /api/parlays/settle (admin only)
// Marks a parlay won or lost with optional per-leg results.
// Won parlays get a payout_queue entry picked up by payout.js.
// Body: { parlayId: N, result: 'won' | 'lost', legs?: [{ id, result, resultValue }] }

import { getSession } from '../../_lib/session.js';
import { ok, err }    from '../../_lib/response.js';

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Authentication required', 401);

  const user = await env.DB.prepare('SELECT is_admin FROM users WHERE id=?').bind(session.user_id).first();
  if (!user || !user.is_admin) return err('Admin required', 403);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON', 400); }

  const { parlayId, result, legs } = body;
  if (!Number.isInteger(parlayId) || !['won', 'lost'].includes(result))
    return err('parlayId (integer) and result ("won" | "lost") required', 400);

  const parlay = await env.DB.prepare(
    'SELECT id, user_id, payout_rax, rs_username, status FROM parlays WHERE id=?'
  ).bind(parlayId).first();

  if (!parlay)                    return err('Parlay not found', 404);
  if (parlay.status !== 'active') return err('Parlay status is "' + parlay.status + '" — only active parlays can be settled', 400);

  const now = Math.floor(Date.now() / 1000);

  // Update per-leg results if provided
  if (Array.isArray(legs) && legs.length) {
    for (const leg of legs) {
      if (!Number.isInteger(leg.id) || !['won', 'lost', 'push'].includes(leg.result)) continue;
      await env.DB.prepare(
        "UPDATE parlay_legs SET status=?, result_value=?, settled_at=? WHERE id=? AND parlay_id=?"
      ).bind(leg.result, leg.resultValue ?? null, now, leg.id, parlayId).run();
    }
  }

  if (result === 'lost') {
    await env.DB.prepare(
      "UPDATE parlays SET status='lost', settled_at=? WHERE id=?"
    ).bind(now, parlayId).run();
    return ok({ parlayId, result: 'lost' });
  }

  // Won — update parlay + enqueue payout atomically
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE parlays SET status='won', settled_at=? WHERE id=?"
    ).bind(now, parlayId),
    env.DB.prepare(
      'INSERT OR IGNORE INTO payout_queue ' +
      '(parlay_id, user_id, rs_username, payout_rax, offer_amount, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(parlayId, parlay.user_id, parlay.rs_username, parlay.payout_rax, parlay.payout_rax, now),
  ]);

  return ok({ parlayId, result: 'won', payoutRax: parlay.payout_rax });
}
