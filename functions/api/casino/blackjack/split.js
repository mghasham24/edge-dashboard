// functions/api/casino/blackjack/split.js
// POST /api/casino/blackjack/split
// Split current hand into two. Deducts extra bet, deals one card to each new hand.
// Split Aces: one card each, both auto-stand (no further action).
// Cap: max 4 total hands.

import { getSession } from '../../../_lib/session.js';
import { err }        from '../../../_lib/response.js';
import {
  canSplit, loadActiveGame, saveGame, appendMove, clientState,
  advanceOrResolve, insuranceGate,
} from '../../../_lib/blackjack.js';

const MAX_HANDS = 4;

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
    return err('Cannot split this hand.', 400);
  if (!canSplit(hand))
    return err('Cards must be the same value to split.', 400);
  if (game.hands.length >= MAX_HANDS)
    return err('Maximum splits reached.', 400);

  // Atomic extra bet deduction
  const deduct = await env.DB.prepare(
    'UPDATE users SET casino_balance = casino_balance - ? WHERE id = ? AND casino_balance >= ?'
  ).bind(hand.bet, userId, hand.bet).run();
  if (deduct.meta.changes === 0)
    return err('Insufficient casino balance to split.', 402);

  const [cardA, cardB] = hand.cards;
  const newCardA = game.deck.pop();
  const newCardB = game.deck.pop();
  const splittingAces = cardA.v === 'A';

  const handA = {
    cards:   [cardA, newCardA],
    bet:     hand.bet,
    status:  splittingAces ? 'standing' : 'active',
    doubled: false,
  };
  const handB = {
    cards:   [cardB, newCardB],
    bet:     hand.bet,
    status:  splittingAces ? 'standing' : 'active',
    doubled: false,
  };

  // Replace current hand with the two split hands
  const idx = game.active_hand_idx;
  game.hands.splice(idx, 1, handA, handB);
  game.moves = appendMove(game.moves, 'split', {
    card_a: newCardA, card_b: newCardB, splitting_aces: splittingAces,
  });

  let resolveData = {};
  if (splittingAces) {
    // Both hands auto-stand — move to dealer play immediately
    const r = await advanceOrResolve(game, env.DB, userId);
    if (r.resolved) resolveData = r;
  }
  // Non-ace split: active_hand_idx stays at idx (pointing to handA); handB played after

  const { conflict } = await saveGame(game, env.DB);
  if (conflict) return err('Game state conflict — please refresh.', 409);

  const balance = resolveData.resolved ? resolveData.newBalance : await getBalance(userId, env.DB);
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
