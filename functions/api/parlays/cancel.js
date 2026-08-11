// functions/api/parlays/cancel.js
// POST /api/parlays/cancel  body: { parlay_id }
// Lets a user void their own pending_deposit parlay and release the card back to the pool.

import { getSession }     from '../../_lib/session.js';
import { ok, err }        from '../../_lib/response.js';
import { checkRateLimit } from '../../_lib/rateLimit.js';

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);

  const allowed = await checkRateLimit(env.DB, request, 'parlay_cancel', 10, 60, String(session.user_id));
  if (!allowed) return err('Too many requests.', 429);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON', 400); }

  const parlayId = parseInt(body.parlay_id);
  if (!parlayId) return err('parlay_id required', 400);

  const parlay = await env.DB.prepare(
    'SELECT id, user_id, status, deposit_card_id FROM parlays WHERE id=?'
  ).bind(parlayId).first();

  if (!parlay)                        return err('Not found', 404);
  if (parlay.user_id !== session.user_id) return err('Forbidden', 403);
  if (parlay.status !== 'pending_deposit') return err('Only pending_deposit parlays can be cancelled', 400);

  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare("UPDATE parlays SET status='void' WHERE id=?").bind(parlayId).run();

  if (parlay.deposit_card_id) {
    await env.DB.prepare(
      'UPDATE deposit_cards SET assigned_to_parlay_id=NULL, assigned_at=NULL, freed_at=? WHERE card_id=?'
    ).bind(now, parlay.deposit_card_id).run();
  }

  return ok({ cancelled: true, parlayId });
}
