// functions/api/casino/blackjack/insurance.js
// POST /api/casino/blackjack/insurance
// Body: { take: boolean, amount?: integer }
// Only valid when dealer shows Ace and insurance has not yet been resolved.
// If dealer has BJ: settles insurance + main hands immediately.
// If dealer no BJ: insurance bet is lost, game continues.

import { getSession } from '../../../_lib/session.js';
import { err }        from '../../../_lib/response.js';
import {
  isNaturalBJ, calcHand, loadActiveGame, saveGame, appendMove,
  clientState, creditBalance, settleGame,
} from '../../../_lib/blackjack.js';

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);
  const userId = session.user_id;

  const game = await loadActiveGame(userId, env.DB);
  if (!game)                    return err('No active game.', 404);
  if (!game.insurance_offered)  return err('Insurance is not available this hand.', 400);
  if (game.insurance_resolved)  return err('Insurance already resolved.', 400);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON', 400); }

  game.insurance_resolved = 1;
  const hand       = game.hands[0];
  const playerBJ   = hand.status === 'blackjack';
  const dealerBJ   = isNaturalBJ(game.dealer_hand);
  const { total: dealerTotal } = calcHand(game.dealer_hand);

  // ── Decline insurance ─────────────────────────────────────────────────────────
  if (!body.take) {
    game.moves = appendMove(game.moves, 'insurance_decline');

    if (dealerBJ) {
      // Dealer has BJ — settle immediately without insurance benefit
      game.dealer_hole_visible = 1;
      game.status = 'complete';
      const results = playerBJ
        ? [{ hand_idx: 0, result: 'push',   credit: hand.bet, player_total: 21, dealer_total: 21 }]
        : [{ hand_idx: 0, result: 'lost',   credit: 0,        player_total: calcHand(hand.cards).total, dealer_total: 21 }];
      if (playerBJ) await creditBalance(userId, hand.bet, env.DB);
      game.result = results;
      const { conflict } = await saveGame(game, env.DB);
      if (conflict) return err('Game state conflict — please refresh.', 409);
      return json({ ok: true, casino_balance: await getBalance(userId, env.DB), ...clientState(game) });
    }

    if (playerBJ) {
      // Player has BJ, dealer no BJ → pay 6:5 immediately
      const payout = hand.bet + Math.floor(hand.bet * 6 / 5);
      await creditBalance(userId, payout, env.DB);
      game.dealer_hole_visible = 1;
      game.status = 'complete';
      game.result = [{ hand_idx: 0, result: 'blackjack', credit: payout,
        player_total: 21, dealer_total: dealerTotal }];
      const { conflict } = await saveGame(game, env.DB);
      if (conflict) return err('Game state conflict — please refresh.', 409);
      return json({ ok: true, casino_balance: await getBalance(userId, env.DB), ...clientState(game) });
    }

    // No BJ either side — game continues normally
    const { conflict } = await saveGame(game, env.DB);
    if (conflict) return err('Game state conflict — please refresh.', 409);
    return json({ ok: true, casino_balance: await getBalance(userId, env.DB), ...clientState(game) });
  }

  // ── Take insurance ────────────────────────────────────────────────────────────
  const maxInsurance = Math.floor(hand.bet / 2);
  const amount = body.amount;
  if (!Number.isInteger(amount) || amount < 1 || amount > maxInsurance)
    return err(`Insurance amount must be 1–${maxInsurance} Rax.`, 400);

  // Atomic deduction
  const deduct = await env.DB.prepare(
    'UPDATE users SET casino_balance = casino_balance - ? WHERE id = ? AND casino_balance >= ?'
  ).bind(amount, userId, amount).run();
  if (deduct.meta.changes === 0)
    return err('Insufficient casino balance for insurance.', 402);

  game.insurance_bet = amount;
  game.moves = appendMove(game.moves, 'insurance_take', { amount });

  if (dealerBJ) {
    // Insurance wins 2:1 — credit stake + 2× profit = 3× bet
    await creditBalance(userId, amount * 3, env.DB);
    game.dealer_hole_visible = 1;
    game.status = 'complete';

    if (playerBJ) {
      // Player BJ + dealer BJ + insurance win → push main + insurance win
      await creditBalance(userId, hand.bet, env.DB);
      game.result = [{ hand_idx: 0, result: 'push', credit: hand.bet,
        player_total: 21, dealer_total: 21, insurance_won: amount * 2 }];
    } else {
      // Player loses main hand, wins insurance
      game.result = [{ hand_idx: 0, result: 'lost', credit: 0,
        player_total: calcHand(hand.cards).total, dealer_total: 21, insurance_won: amount * 2 }];
    }

    const { conflict } = await saveGame(game, env.DB);
    if (conflict) return err('Game state conflict — please refresh.', 409);
    return json({ ok: true, casino_balance: await getBalance(userId, env.DB), ...clientState(game) });
  }

  // Dealer no BJ — insurance bet lost, game continues
  // (amount already deducted and not refunded)
  if (playerBJ) {
    // Player BJ, dealer no BJ → pay 6:5 immediately
    const payout = hand.bet + Math.floor(hand.bet * 6 / 5);
    await creditBalance(userId, payout, env.DB);
    game.dealer_hole_visible = 1;
    game.status = 'complete';
    game.result = [{ hand_idx: 0, result: 'blackjack', credit: payout,
      player_total: 21, dealer_total: dealerTotal, insurance_lost: amount }];
    const { conflict } = await saveGame(game, env.DB);
    if (conflict) return err('Game state conflict — please refresh.', 409);
    return json({ ok: true, casino_balance: await getBalance(userId, env.DB), ...clientState(game) });
  }

  // No BJ either side — game continues, player acts next
  const { conflict } = await saveGame(game, env.DB);
  if (conflict) return err('Game state conflict — please refresh.', 409);
  return json({ ok: true, casino_balance: await getBalance(userId, env.DB), ...clientState(game) });
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
