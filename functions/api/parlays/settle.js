// functions/api/parlays/settle.js
// POST /api/parlays/settle (admin only)
// Marks a parlay won or lost with optional per-leg results.
// Push legs are scratched — payout recalculates from remaining legs (like scratch players).
// 2-leg with 1 push → 'voided' + full stake refund (can't have a 1-leg parlay).
// All-legs-push → 'voided' + full stake refund.
// Body: { parlayId: N, result: 'won' | 'lost', legs?: [{ id, result, resultValue }] }

import { getSession } from '../../_lib/session.js';
import { ok, err }    from '../../_lib/response.js';

// Mirrors roundOfferAmount in auto-settle.js
function roundOfferAmount(amount) {
  const ones = amount % 10;
  return ones >= 8 ? Math.ceil(amount / 10) * 10 : Math.floor(amount / 10) * 10;
}

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
    'SELECT id, user_id, stake_rax, payout_rax, rs_username, status FROM parlays WHERE id=?'
  ).bind(parlayId).first();

  if (!parlay)                    return err('Parlay not found', 404);
  if (parlay.status !== 'active') return err('Parlay status is "' + parlay.status + '" — only active parlays can be settled', 400);

  const now = Math.floor(Date.now() / 1000);

  // Update per-leg results if provided
  const legResults = {}; // id → 'won' | 'lost' | 'push'
  if (Array.isArray(legs) && legs.length) {
    for (const leg of legs) {
      if (!Number.isInteger(leg.id) || !['won', 'lost', 'push'].includes(leg.result)) continue;
      await env.DB.prepare(
        "UPDATE parlay_legs SET status=?, result_value=?, settled_at=? WHERE id=? AND parlay_id=?"
      ).bind(leg.result, leg.resultValue ?? null, now, leg.id, parlayId).run();
      legResults[leg.id] = leg.result;
    }
  }

  if (result === 'lost') {
    await env.DB.batch([
      env.DB.prepare("UPDATE parlays SET status='lost', settled_at=? WHERE id=?").bind(now, parlayId),
      env.DB.prepare(
        "UPDATE deposit_cards SET assigned_to_parlay_id=NULL, assigned_at=NULL WHERE assigned_to_parlay_id=?"
      ).bind(parlayId),
    ]);
    return ok({ parlayId, result: 'lost' });
  }

  // Won — recalculate payout if any legs pushed (scratch those legs, matching auto-settle logic).
  const { results: allLegs } = await env.DB.prepare(
    'SELECT id, implied_prob FROM parlay_legs WHERE parlay_id=?'
  ).bind(parlayId).all();

  const pushedLegs  = allLegs.filter(l => legResults[l.id] === 'push');
  const activeLegs  = allLegs.filter(l => legResults[l.id] !== 'push');
  const anyPush     = pushedLegs.length > 0;

  let finalPayout  = parlay.payout_rax;
  let parlayStatus = 'won';

  if (anyPush) {
    if (activeLegs.length < 2) {
      // 2-leg with 1 push, or all legs pushed → voided, full stake refund
      parlayStatus = 'voided';
      finalPayout  = parlay.stake_rax;
    } else {
      // Recalculate payout from surviving legs only (no leg caps, matches auto-settle)
      const newTrueProb = activeLegs.reduce((acc, l) => acc * l.implied_prob, 1);
      finalPayout = Math.min(Math.floor(parlay.stake_rax * 0.70 / newTrueProb), 10000);
    }
  }

  if (parlayStatus === 'voided') {
    await env.DB.batch([
      env.DB.prepare("UPDATE parlays SET status='voided', settled_at=? WHERE id=?").bind(now, parlayId),
      env.DB.prepare(
        'INSERT OR IGNORE INTO payout_queue (parlay_id, user_id, rs_username, payout_rax, offer_amount, created_at) VALUES (?,?,?,?,?,?)'
      ).bind(parlayId, parlay.user_id, parlay.rs_username, finalPayout, roundOfferAmount(finalPayout), now),
      env.DB.prepare(
        "UPDATE deposit_cards SET assigned_to_parlay_id=NULL, assigned_at=NULL WHERE assigned_to_parlay_id=?"
      ).bind(parlayId),
    ]);
    return ok({ parlayId, result: 'voided', payoutRax: finalPayout, pushedLegs: pushedLegs.length });
  }

  // Won — update payout_rax in case it was recalculated after a push
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE parlays SET status='won', payout_rax=?, settled_at=? WHERE id=?"
    ).bind(finalPayout, now, parlayId),
    env.DB.prepare(
      'INSERT OR IGNORE INTO payout_queue ' +
      '(parlay_id, user_id, rs_username, payout_rax, offer_amount, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(parlayId, parlay.user_id, parlay.rs_username, finalPayout, roundOfferAmount(finalPayout), now),
    env.DB.prepare(
      "UPDATE deposit_cards SET assigned_to_parlay_id=NULL, assigned_at=NULL WHERE assigned_to_parlay_id=?"
    ).bind(parlayId),
  ]);

  return ok({ parlayId, result: 'won', payoutRax: finalPayout, pushedLegs: pushedLegs.length });
}
