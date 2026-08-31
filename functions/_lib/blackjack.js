// functions/_lib/blackjack.js
// Shared blackjack game logic — imported by all casino/blackjack/* endpoints.
// All Rax amounts are integers. Math.floor() used on every payout calculation.

// ─── Card primitives ──────────────────────────────────────────────────────────

const SUITS  = ['H', 'D', 'C', 'S'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];

export function buildDeck() {
  const deck = [];
  for (const s of SUITS) for (const v of VALUES) deck.push({ s, v });
  return deck; // 52 cards
}

export function shuffleDeck(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

export function isTenValue(v) {
  return v === 'T' || v === 'J' || v === 'Q' || v === 'K';
}

// ─── Hand calculation ─────────────────────────────────────────────────────────

// Returns { total: number, soft: boolean }
// soft = true means at least one Ace is still counted as 11
export function calcHand(cards) {
  let total = 0, aces = 0;
  for (const { v } of cards) {
    if (v === 'A')        { total += 11; aces++; }
    else if (isTenValue(v)) total += 10;
    else                    total += parseInt(v, 10);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return { total, soft: aces > 0 && total <= 21 };
}

// 2-card 21 only — post-split 21 is NOT a natural blackjack
export function isNaturalBJ(cards) {
  if (cards.length !== 2) return false;
  return calcHand(cards).total === 21;
}

// Two cards have the same split-eligible value group
// Aces must match Aces; any two 10-value cards can split
export function canSplit(hand) {
  if (hand.cards.length !== 2) return false;
  const [a, b] = hand.cards;
  if (a.v === 'A' && b.v === 'A') return true;
  if (isTenValue(a.v) && isTenValue(b.v)) return true;
  return a.v === b.v;
}

// ─── Dealer logic ─────────────────────────────────────────────────────────────

// Dealer draws until hard 17+. Hits soft 17.
// Returns { hand: card[], deck: card[] }
export function dealerPlay(hand, deck) {
  const h = [...hand];
  const d = [...deck];
  while (true) {
    const { total, soft } = calcHand(h);
    if (total > 17)                  break; // 18+ always stand
    if (total === 17 && !soft)       break; // hard 17: stand
    // soft 17 or total < 17: hit
    if (!d.length) break; // safety — should never run out
    h.push(d.pop());
  }
  return { hand: h, deck: d };
}

// ─── Hand resolution ──────────────────────────────────────────────────────────

// Resolves one player hand against the fully played dealer hand.
// Returns { result: string, credit: integer }
// credit = Rax to credit back to casino_balance (0 = full loss, bet = push, bet*2 = win)
export function resolveHand(hand, dealerHand) {
  const { total: dealerTotal } = calcHand(dealerHand);
  const dealerBust = dealerTotal > 21;
  const dealerBJ   = isNaturalBJ(dealerHand);

  if (hand.status === 'bust') return { result: 'lost', credit: 0 };

  const { total: playerTotal } = calcHand(hand.cards);

  if (hand.status === 'blackjack') {
    if (dealerBJ) return { result: 'push', credit: hand.bet };
    // 6:5 payout — win 6 for every 5 bet, floored to nearest integer
    return { result: 'blackjack', credit: hand.bet + Math.floor(hand.bet * 6 / 5) };
  }

  if (dealerBust || playerTotal > dealerTotal)
    return { result: 'won', credit: hand.bet * 2 };
  if (playerTotal === dealerTotal)
    return { result: 'push', credit: hand.bet };
  return { result: 'lost', credit: 0 };
}

// Settles all hands after dealer plays, credits balance, marks game complete.
// Returns { results: [], dealerTotal, totalCredit }
export async function settleGame(game, db, userId) {
  const dealerTotal = calcHand(game.dealer_hand).total;
  const results = game.hands.map((hand, i) => {
    const { result, credit } = resolveHand(hand, game.dealer_hand);
    return { hand_idx: i, result, credit, player_total: calcHand(hand.cards).total, dealer_total: dealerTotal };
  });
  const totalCredit = results.reduce((sum, r) => sum + r.credit, 0);
  if (totalCredit > 0) {
    await db.prepare('UPDATE users SET casino_balance = casino_balance + ? WHERE id = ?')
      .bind(totalCredit, userId).run();
  }

  // Log completed game to casino_hands for analytics — never blocks or breaks game
  try {
    const betTotal    = game.hands.reduce((s, h) => s + (h.bet || 0), 0);
    const handsDetail = results.map((r, i) => ({
      result:       r.result,
      bet:          game.hands[i]?.bet   || 0,
      credit:       r.credit,
      player_total: r.player_total,
      dealer_total: r.dealer_total,
      cards:        game.hands[i]?.cards || [],
    }));
    await db.prepare(
      'INSERT INTO casino_hands (user_id, game_id, bet_total, payout_total, profit, hands_json, dealer_cards, dealer_total, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(
      userId, game.id, betTotal, totalCredit, betTotal - totalCredit,
      JSON.stringify(handsDetail), JSON.stringify(game.dealer_hand), dealerTotal,
      Math.floor(Date.now() / 1000)
    ).run();
  } catch (_) {}

  return { results, dealerTotal, totalCredit };
}

// ─── D1 helpers ───────────────────────────────────────────────────────────────

// Load, parse, and return the user's active game. Returns null if none exists.
export async function loadActiveGame(userId, db) {
  const row = await db.prepare(
    "SELECT * FROM blackjack_games WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1"
  ).bind(userId).first();
  if (!row) return null;
  return {
    ...row,
    deck:        JSON.parse(row.deck),
    hands:       JSON.parse(row.hands),
    dealer_hand: JSON.parse(row.dealer_hand),
    moves:       JSON.parse(row.moves || '[]'),
    result:      row.result ? JSON.parse(row.result) : null,
  };
}

// Save updated game state. Uses optimistic locking via the version column.
// Returns { conflict: true } if another request already incremented the version.
export async function saveGame(game, db) {
  const r = await db.prepare(
    `UPDATE blackjack_games SET
       deck = ?, hands = ?, active_hand_idx = ?, dealer_hand = ?,
       dealer_hole_visible = ?, insurance_offered = ?, insurance_resolved = ?,
       insurance_bet = ?, status = ?, result = ?, moves = ?,
       version = version + 1
     WHERE id = ? AND version = ?`
  ).bind(
    JSON.stringify(game.deck),
    JSON.stringify(game.hands),
    game.active_hand_idx,
    JSON.stringify(game.dealer_hand),
    game.dealer_hole_visible,
    game.insurance_offered,
    game.insurance_resolved,
    game.insurance_bet ?? null,
    game.status,
    game.result ? JSON.stringify(game.result) : null,
    JSON.stringify(game.moves),
    game.id,
    game.version,
  ).run();
  return { conflict: r.meta.changes === 0 };
}

// Atomic balance credit helper
export async function creditBalance(userId, amount, db) {
  if (amount <= 0) return;
  await db.prepare('UPDATE users SET casino_balance = casino_balance + ? WHERE id = ?')
    .bind(amount, userId).run();
}

// ─── State helpers ────────────────────────────────────────────────────────────

// Append one entry to the moves audit log
export function appendMove(moves, action, extra = {}) {
  return [...moves, { action, ts: Math.floor(Date.now() / 1000), ...extra }];
}

// Find the index of the next 'active' hand after currentIdx. Returns -1 if none.
export function findNextActiveHand(hands, currentIdx) {
  for (let i = currentIdx + 1; i < hands.length; i++) {
    if (hands[i].status === 'active') return i;
  }
  return -1;
}

// Build the response object safe to send to the client.
// Hides the dealer hole card until dealer_hole_visible = 1.
export function clientState(game, extra = {}) {
  const dealerCards = game.dealer_hole_visible
    ? game.dealer_hand
    : [game.dealer_hand[0], null]; // null = face-down hole card
  return {
    game_id:            game.id,
    version:            game.version + 1,
    status:             game.status,
    hands:              game.hands,
    active_hand_idx:    game.active_hand_idx,
    dealer_hand:        dealerCards,
    insurance_offered:  game.insurance_offered,
    insurance_resolved: game.insurance_resolved,
    insurance_bet:      game.insurance_bet ?? null,
    result:             game.result ?? null,
    ...extra,
  };
}

// ─── Advance or resolve ───────────────────────────────────────────────────────

// Called after any action that terminates the current hand (bust, stand, double, split-aces).
// Mutates game in place. Does NOT call saveGame — caller must do that.
// Returns { advanced: bool, resolved: bool, results?, totalCredit?, newBalance? }
export async function advanceOrResolve(game, db, userId) {
  const nextIdx = findNextActiveHand(game.hands, game.active_hand_idx);

  if (nextIdx !== -1) {
    // More hands to play
    game.active_hand_idx = nextIdx;
    return { advanced: true, resolved: false };
  }

  // All hands done — dealer plays out (only if at least one hand isn't bust)
  const anyAlive = game.hands.some(h => h.status !== 'bust');
  if (anyAlive) {
    const played = dealerPlay(game.dealer_hand, game.deck);
    game.dealer_hand = played.hand;
    game.deck        = played.deck;
  }

  game.dealer_hole_visible = 1;
  game.status = 'complete';

  const { results, dealerTotal, totalCredit } = await settleGame(game, db, userId);
  game.result = results;

  // Fetch updated balance to return to client
  const userRow = await db.prepare('SELECT casino_balance FROM users WHERE id = ?')
    .bind(userId).first();
  const newBalance = userRow?.casino_balance ?? 0;

  return { advanced: false, resolved: true, results, dealerTotal, totalCredit, newBalance };
}

// ─── Insurance check ──────────────────────────────────────────────────────────

// Returns a 409 error response if insurance is pending and the caller is not the insurance endpoint.
// Pass as: const gate = insuranceGate(game); if (gate) return gate;
export function insuranceGate(game) {
  if (game.insurance_offered && !game.insurance_resolved) {
    return new Response(
      JSON.stringify({ error: 'insurance_pending', message: 'Resolve insurance before acting.' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return null;
}
