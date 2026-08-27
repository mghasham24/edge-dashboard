// functions/api/casino/blackjack/double.js
// POST /api/casino/blackjack/double
// Double down: deduct extra bet, deal exactly one card, auto-stand.

import { getSession } from '../../../_lib/session.js';
import { err }        from '../../../_lib/response.js';
import {
  calcHand, loadActiveGame, saveGame, appendMove, clientState,
  advanceOrResolve, insuranceGate,
} from '../../../_lib/blackjack.js';

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);
  const userId = session.user_id;

  const game = await loadActiveGame(userId, env.DB);
  if (!game) return err('No active game.', 404);

  const gate = insuranceGate(game);
  if (gate) return gate;

  const hand = game.hands[game.active_hand_idx];
  if (!hand || hand.status !== 'active')
    return err('Cannot double on this hand.', 400);
  if (hand.cards.length !== 2)
    return err('Can only double on the first two cards.', 400);

  // Atomic extra bet deduction
  const deduct = await env.DB.prepare(
    'UPDATE users SET casino_balance = casino_balance - ? WHERE id = ? AND casino_balance >= ?'
  ).bind(hand.bet, userId, hand.bet).run();
  if (deduct.meta.changes === 0)
    return err('Insufficient casino balance to double.', 402);

  hand.bet    *= 2;
  hand.doubled = true;

  const card = game.deck.pop();
  hand.cards.push(card);
  game.moves = appendMove(game.moves, 'double', { card });

  const { total } = calcHand(hand.cards);
  hand.status = total > 21 ? 'bust' : 'doubled-standing';

  const r = await advanceOrResolve(game, env.DB, userId);

  const { conflict } = await saveGame(game, env.DB);
  if (conflict) return err('Game state conflict — please refresh.', 409);

  const balance = r.resolved ? r.newBalance : await getBalance(userId, env.DB);
  return json({ ok: true, casino_balance: balance, ...clientState(game) });
}

async function getBalance(userId, db) {
  const row = await db.prepare('SELECT casino_balance FROM users WHERE id = ?').bind(userId).first();
  return row?.casino_balance ?? 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
