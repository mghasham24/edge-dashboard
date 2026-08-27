// functions/api/casino/deposit-cancel.js
// POST /api/casino/deposit-cancel
// Cancels the calling user's pending casino deposit (if any).
// Casino deposits share the deposit_cards pool with parlays but never set
// assigned_to_parlay_id — deposit.js excludes cards via the casino_deposits
// table directly. Setting status='cancelled' here is sufficient to free the card.

import { getSession } from '../../_lib/session.js';
import { ok, err }    from '../../_lib/response.js';

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);

  const result = await env.DB.prepare(
    "UPDATE casino_deposits SET status='cancelled' WHERE user_id=? AND status='pending'"
  ).bind(session.user_id).run();

  return ok({ cancelled: result.meta.changes > 0 });
}
