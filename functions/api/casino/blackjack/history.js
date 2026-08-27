// functions/api/casino/blackjack/history.js
// GET /api/casino/blackjack/history
// Returns last 20 completed hands for the authenticated user.

import { getSession } from '../../../_lib/session.js';
import { err }        from '../../../_lib/response.js';
import { calcHand }   from '../../../_lib/blackjack.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);

  const rows = await env.DB.prepare(
    `SELECT id, hands, dealer_hand, result, status, created_at
     FROM blackjack_games
     WHERE user_id = ? AND status IN ('complete', 'abandoned')
     ORDER BY created_at DESC LIMIT 20`
  ).bind(session.user_id).all();

  const history = (rows.results || []).map(row => {
    const hands      = JSON.parse(row.hands || '[]');
    const dealerHand = JSON.parse(row.dealer_hand || '[]');
    const result     = row.result ? JSON.parse(row.result) : null;
    const totalBet   = hands.reduce((s, h) => s + (h.bet || 0), 0);
    const totalPaid  = result ? result.reduce((s, r) => s + (r.credit || 0), 0) : 0;
    return {
      id:           row.id,
      status:       row.status,
      created_at:   row.created_at,
      total_bet:    totalBet,
      total_paid:   totalPaid,
      net:          totalPaid - totalBet,
      dealer_total: dealerHand.length ? calcHand(dealerHand).total : null,
      hands:        hands.map((h, i) => ({
        cards:  h.cards,
        bet:    h.bet,
        status: h.status,
        total:  calcHand(h.cards).total,
        result: result?.[i]?.result ?? null,
        credit: result?.[i]?.credit ?? null,
      })),
    };
  });

  return new Response(JSON.stringify({ ok: true, history }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
