// POST /api/casino/mines/start
// Start a new mines game. Deducts bet, places mines server-side.

import { getSession } from '../../../_lib/session.js';
import { err }        from '../../../_lib/response.js';

const MIN_BET     = 100;
const MAX_BET     = 10000;
const HOUSE_EDGE  = 0.05;
const TILES       = 25;
const ABANDON_AGE = 30 * 60; // 30 minutes

function calcMultiplier(minesCount, gemsRevealed) {
  if (gemsRevealed === 0) return 1;
  let mult = 1;
  for (let k = 0; k < gemsRevealed; k++) {
    mult *= (TILES - k) / (TILES - minesCount - k);
  }
  return mult * (1 - HOUSE_EDGE);
}

function placeMines(minesCount) {
  const indices = Array.from({ length: TILES }, (_, i) => i);
  for (let i = TILES - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, minesCount);
}

async function getBalance(userId, db) {
  const row = await db.prepare('SELECT casino_balance FROM users WHERE id = ?').bind(userId).first();
  return row?.casino_balance ?? 0;
}

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);
  const userId = session.user_id;

  const user = await env.DB.prepare('SELECT is_admin FROM users WHERE id = ?').bind(userId).first();
  if (!user?.is_admin) return err('Forbidden', 403);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON', 400); }

  const bet   = body.bet;
  const mines = body.mines_count;

  if (!Number.isInteger(bet) || bet < MIN_BET || bet > MAX_BET)
    return err(`Bet must be ${MIN_BET}–${MAX_BET} Rax.`, 400);
  if (!Number.isInteger(mines) || mines < 1 || mines > 15)
    return err('Mines must be 1–24.', 400);

  const now = Math.floor(Date.now() / 1000);

  // Resume existing active game within 30 min
  const existing = await env.DB.prepare(
    "SELECT * FROM casino_mines_games WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1"
  ).bind(userId).first();

  if (existing) {
    const age = now - existing.created_at;
    if (age < ABANDON_AGE) {
      return new Response(JSON.stringify({
        ok: true,
        resumed: true,
        casino_balance: await getBalance(userId, env.DB),
        game_id:        existing.id,
        bet_rax:        existing.bet_rax,
        mines_count:    existing.mines_count,
        revealed:       JSON.parse(existing.revealed),
        gems_revealed:  existing.gems_revealed,
        multiplier:     existing.multiplier,
        status:         existing.status,
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    // Abandon stale game as loss (bet already deducted)
    await env.DB.prepare(
      "UPDATE casino_mines_games SET status = 'lost' WHERE id = ? AND status = 'active'"
    ).bind(existing.id).run();
  }

  // Deduct bet atomically
  const deduct = await env.DB.prepare(
    'UPDATE users SET casino_balance = casino_balance - ? WHERE id = ? AND casino_balance >= ?'
  ).bind(bet, userId, bet).run();
  if (deduct.meta.changes === 0) return err('Insufficient casino balance.', 402);

  const minePositions = placeMines(mines);
  const r = await env.DB.prepare(
    'INSERT INTO casino_mines_games (user_id, bet_rax, mines_count, mine_positions) VALUES (?,?,?,?)'
  ).bind(userId, bet, mines, JSON.stringify(minePositions)).run();

  const gameId = r.meta.last_row_id;
  const mult   = calcMultiplier(mines, 1); // next-gem multiplier (shown before any click)

  return new Response(JSON.stringify({
    ok:            true,
    casino_balance: await getBalance(userId, env.DB),
    game_id:       gameId,
    bet_rax:       bet,
    mines_count:   mines,
    revealed:      [],
    gems_revealed: 0,
    multiplier:    1,
    next_mult:     parseFloat(mult.toFixed(4)),
    status:        'active',
  }), { headers: { 'Content-Type': 'application/json' } });
}
