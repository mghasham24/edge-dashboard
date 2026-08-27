// functions/api/casino/blackjack/deal.js
// POST /api/casino/blackjack/deal
// Start a new blackjack hand. Deducts bet, deals 4 cards, handles BJ/peek scenarios.

import { getSession } from '../../../_lib/session.js';
import { err }        from '../../../_lib/response.js';
import {
  buildDeck, shuffleDeck, isTenValue, isNaturalBJ, calcHand,
  loadActiveGame, saveGame, appendMove, clientState,
  dealerPlay, settleGame, creditBalance,
} from '../../../_lib/blackjack.js';

const MIN_BET = 100;
const MAX_BET = 10000;
const ABANDON_AGE = 30 * 60; // 30 minutes in seconds

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);
  const userId = session.user_id;

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON', 400); }

  const bet = body.bet;
  if (!Number.isInteger(bet) || bet < MIN_BET || bet > MAX_BET)
    return err(`Bet must be an integer between ${MIN_BET} and ${MAX_BET} Rax.`, 400);

  const now = Math.floor(Date.now() / 1000);

  // ── Check for existing active game ───────────────────────────────────────────
  const existing = await loadActiveGame(userId, env.DB);
  if (existing) {
    const age = now - existing.created_at;
    if (age < ABANDON_AGE) {
      // Under 30 min — return existing state so frontend can resume
      return new Response(JSON.stringify({
        ok: true,
        resumed: true,
        casino_balance: await getBalance(userId, env.DB),
        ...clientState(existing),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    // Over 30 min — auto-abandon as loss (player forfeits bet, no dealer draw)
    await env.DB.prepare(
      "UPDATE blackjack_games SET status = 'abandoned' WHERE id = ? AND status = 'active'"
    ).bind(existing.id).run();
  }

  // ── Atomic bet deduction ──────────────────────────────────────────────────────
  const deduct = await env.DB.prepare(
    'UPDATE users SET casino_balance = casino_balance - ? WHERE id = ? AND casino_balance >= ?'
  ).bind(bet, userId, bet).run();
  if (deduct.meta.changes === 0)
    return err('Insufficient casino balance.', 402);

  const balanceAfterBet = await getBalance(userId, env.DB);

  // ── Deal cards ────────────────────────────────────────────────────────────────
  // Order: player[0], dealer_up, player[1], dealer_hole
  const deck = shuffleDeck(buildDeck());
  const p0   = deck.pop();
  const d0   = deck.pop(); // dealer face-up
  const p1   = deck.pop();
  const d1   = deck.pop(); // dealer hole

  const playerCards  = [p0, p1];
  const dealerHand   = [d0, d1];
  const playerBJ     = isNaturalBJ(playerCards);
  const dealerUpAce  = d0.v === 'A';
  const dealerUpTen  = isTenValue(d0.v);
  const dealerBJ     = isNaturalBJ(dealerHand);

  let moves = appendMove([], 'deal', { cards: playerCards, dealer_up: d0 });

  // ── Dealer shows Ace — offer insurance ───────────────────────────────────────
  if (dealerUpAce) {
    const hand = makeHand(playerCards, bet, playerBJ ? 'blackjack' : 'active');
    const gameId = await insertGame(env.DB, userId, deck, [hand], dealerHand, {
      insurance_offered: 1,
      moves,
    });
    const balance = await getBalance(userId, env.DB);
    return json({
      ok: true,
      casino_balance: balance,
      insurance_available: true,
      insurance_max: Math.floor(bet / 2),
      player_bj: playerBJ,
      ...clientState({ id: gameId, version: 0, status: 'active', hands: [hand],
        active_hand_idx: 0, dealer_hand: dealerHand, dealer_hole_visible: 0,
        insurance_offered: 1, insurance_resolved: 0, insurance_bet: null, result: null, moves }),
    });
  }

  // ── Dealer shows 10-value — peek for BJ ──────────────────────────────────────
  if (dealerUpTen) {
    if (dealerBJ) {
      moves = appendMove(moves, 'dealer_peek', { dealer_bj: true });
      if (playerBJ) {
        // Both BJ → push — refund bet
        await creditBalance(userId, bet, env.DB);
        const result = [{ hand_idx: 0, result: 'push', credit: bet,
          player_total: 21, dealer_total: 21 }];
        await insertGame(env.DB, userId, deck, [makeHand(playerCards, bet, 'blackjack')], dealerHand, {
          dealer_hole_visible: 1, status: 'complete', result, moves,
        });
        return json({ ok: true, casino_balance: await getBalance(userId, env.DB),
          ...completeState(playerCards, bet, 'blackjack', dealerHand, result) });
      }
      // Dealer BJ, player no BJ → loss (bet already deducted)
      const result = [{ hand_idx: 0, result: 'lost', credit: 0,
        player_total: calcHand(playerCards).total, dealer_total: 21 }];
      await insertGame(env.DB, userId, deck, [makeHand(playerCards, bet, 'active')], dealerHand, {
        dealer_hole_visible: 1, status: 'complete', result, moves,
      });
      return json({ ok: true, casino_balance: await getBalance(userId, env.DB),
        ...completeState(playerCards, bet, 'active', dealerHand, result) });
    }

    // No dealer BJ
    moves = appendMove(moves, 'dealer_peek', { dealer_bj: false });
    if (playerBJ) {
      // Player BJ, dealer no BJ → pay 6:5
      const payout = bet + Math.floor(bet * 6 / 5);
      await creditBalance(userId, payout, env.DB);
      const result = [{ hand_idx: 0, result: 'blackjack', credit: payout,
        player_total: 21, dealer_total: calcHand(dealerHand).total }];
      await insertGame(env.DB, userId, deck, [makeHand(playerCards, bet, 'blackjack')], dealerHand, {
        dealer_hole_visible: 1, status: 'complete', result, moves,
      });
      return json({ ok: true, casino_balance: await getBalance(userId, env.DB),
        ...completeState(playerCards, bet, 'blackjack', dealerHand, result) });
    }
    // Player no BJ, dealer no BJ → active hand
  }

  // ── Dealer shows 2–9 ──────────────────────────────────────────────────────────
  if (!dealerUpAce && !dealerUpTen && playerBJ) {
    const payout = bet + Math.floor(bet * 6 / 5);
    await creditBalance(userId, payout, env.DB);
    const result = [{ hand_idx: 0, result: 'blackjack', credit: payout,
      player_total: 21, dealer_total: calcHand(dealerHand).total }];
    await insertGame(env.DB, userId, deck, [makeHand(playerCards, bet, 'blackjack')], dealerHand, {
      dealer_hole_visible: 1, status: 'complete', result, moves,
    });
    return json({ ok: true, casino_balance: await getBalance(userId, env.DB),
      ...completeState(playerCards, bet, 'blackjack', dealerHand, result) });
  }

  // ── Normal active game ────────────────────────────────────────────────────────
  const hand   = makeHand(playerCards, bet, 'active');
  const gameId = await insertGame(env.DB, userId, deck, [hand], dealerHand, { moves });
  return json({
    ok: true,
    casino_balance: balanceAfterBet,
    ...clientState({ id: gameId, version: 0, status: 'active', hands: [hand],
      active_hand_idx: 0, dealer_hand: dealerHand, dealer_hole_visible: 0,
      insurance_offered: 0, insurance_resolved: 0, insurance_bet: null, result: null, moves }),
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeHand(cards, bet, status) {
  return { cards, bet, status, doubled: false };
}

async function insertGame(db, userId, deck, hands, dealerHand, opts = {}) {
  const {
    insurance_offered   = 0,
    insurance_resolved  = 0,
    insurance_bet       = null,
    dealer_hole_visible = 0,
    status              = 'active',
    result              = null,
    moves               = [],
  } = opts;
  const r = await db.prepare(
    `INSERT INTO blackjack_games
       (user_id, deck, hands, active_hand_idx, dealer_hand,
        dealer_hole_visible, insurance_offered, insurance_resolved,
        insurance_bet, status, result, moves)
     VALUES (?,?,?,0,?,?,?,?,?,?,?,?)`
  ).bind(
    userId,
    JSON.stringify(deck),
    JSON.stringify(hands),
    JSON.stringify(dealerHand),
    dealer_hole_visible,
    insurance_offered,
    insurance_resolved,
    insurance_bet,
    status,
    result ? JSON.stringify(result) : null,
    JSON.stringify(moves),
  ).run();
  return r.meta.last_row_id;
}

function completeState(playerCards, bet, handStatus, dealerHand, result) {
  const hand = makeHand(playerCards, bet, handStatus);
  return {
    status: 'complete',
    hands: [hand],
    active_hand_idx: 0,
    dealer_hand: dealerHand,
    dealer_hole_visible: 1,
    insurance_offered: 0,
    insurance_resolved: 0,
    result,
  };
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
