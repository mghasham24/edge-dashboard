// functions/api/casino/blackjack/hit.js
// POST /api/casino/blackjack/hit

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
  if (!hand || hand.status !== 'active') {
    // Idempotent — hand already resolved, return current state
    return json({ ok: true, casino_balance: await getBalance(userId, env.DB), ...clientState(game) });
  }

  // Draw card
  const card = game.deck.pop();
  hand.cards.push(card);
  game.moves = appendMove(game.moves, 'hit', { card });

  const { total } = calcHand(hand.cards);

  let resolved = false;
  let resolveData = {};

  if (total > 21) {
    hand.status = 'bust';
    const r = await advanceOrResolve(game, env.DB, userId);
    resolved = r.resolved;
    if (resolved) resolveData = r;
  } else if (total === 21) {
    hand.status = 'standing';
    const r = await advanceOrResolve(game, env.DB, userId);
    resolved = r.resolved;
    if (resolved) resolveData = r;
  }

  const { conflict } = await saveGame(game, env.DB);
  if (conflict) return err('Game state conflict — please refresh.', 409);

  const balance = resolved ? resolveData.newBalance : await getBalance(userId, env.DB);
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
