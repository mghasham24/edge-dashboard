// POST /api/casino/mines/reveal
// Reveal a tile. Body: { game_id, tile_index } or { game_id, random: true }

import { getSession } from '../../../_lib/session.js';
import { err }        from '../../../_lib/response.js';

const HOUSE_EDGE = 0.05;
const TILES      = 25;

function calcMultiplier(minesCount, gemsRevealed) {
  if (gemsRevealed === 0) return 1;
  let mult = 1;
  for (let k = 0; k < gemsRevealed; k++) {
    mult *= (TILES - k) / (TILES - minesCount - k);
  }
  return mult * (1 - HOUSE_EDGE);
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

  const gameId = body.game_id;
  if (!Number.isInteger(gameId)) return err('game_id required', 400);

  const game = await env.DB.prepare(
    "SELECT * FROM casino_mines_games WHERE id = ? AND user_id = ? AND status = 'active'"
  ).bind(gameId, userId).first();
  if (!game) return err('No active game found', 404);

  const mines    = JSON.parse(game.mine_positions); // array of mine indices
  const revealed = JSON.parse(game.revealed);       // array of revealed gem indices
  const revSet   = new Set(revealed);

  let tileIndex;
  if (body.random) {
    // Pick a random unrevealed tile (may be a mine — same odds as manual)
    const unrevealed = [];
    for (let i = 0; i < TILES; i++) {
      if (!revSet.has(i)) unrevealed.push(i);
    }
    if (!unrevealed.length) return err('No tiles remaining', 400);
    tileIndex = unrevealed[Math.floor(Math.random() * unrevealed.length)];
  } else {
    tileIndex = body.tile_index;
    if (!Number.isInteger(tileIndex) || tileIndex < 0 || tileIndex >= TILES)
      return err('tile_index must be 0–24', 400);
    if (revSet.has(tileIndex)) return err('Tile already revealed', 400);
  }

  const isMine = mines.includes(tileIndex);

  if (isMine) {
    await env.DB.prepare(
      "UPDATE casino_mines_games SET status = 'lost' WHERE id = ?"
    ).bind(gameId).run();

    return new Response(JSON.stringify({
      ok:            true,
      hit_mine:      true,
      tile_index:    tileIndex,
      mine_positions: mines,
      gems_revealed: game.gems_revealed,
      multiplier:    game.multiplier,
      status:        'lost',
      casino_balance: await getBalance(userId, env.DB),
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  // Safe gem
  const newRevealed     = [...revealed, tileIndex];
  const newGemsRevealed = game.gems_revealed + 1;
  const newMult         = calcMultiplier(game.mines_count, newGemsRevealed);
  const safeRemaining   = TILES - game.mines_count - newGemsRevealed;
  // next-tile multiplier shown on hover (0 if no safe tiles left)
  const nextMult = safeRemaining > 0
    ? calcMultiplier(game.mines_count, newGemsRevealed + 1)
    : null;

  await env.DB.prepare(
    'UPDATE casino_mines_games SET revealed = ?, gems_revealed = ?, multiplier = ? WHERE id = ?'
  ).bind(JSON.stringify(newRevealed), newGemsRevealed, newMult, gameId).run();

  // Auto-cashout if all safe tiles revealed (can't lose from here)
  if (safeRemaining === 0) {
    const payout = Math.floor(game.bet_rax * newMult);
    await env.DB.prepare(
      "UPDATE casino_mines_games SET status = 'won' WHERE id = ?"
    ).bind(gameId).run();
    await env.DB.prepare(
      'UPDATE users SET casino_balance = casino_balance + ? WHERE id = ?'
    ).bind(payout, userId).run();

    return new Response(JSON.stringify({
      ok:             true,
      hit_mine:       false,
      tile_index:     tileIndex,
      gems_revealed:  newGemsRevealed,
      multiplier:     parseFloat(newMult.toFixed(4)),
      next_mult:      null,
      payout_rax:     payout,
      auto_cashout:   true,
      mine_positions: mines,
      status:         'won',
      casino_balance: await getBalance(userId, env.DB),
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({
    ok:            true,
    hit_mine:      false,
    tile_index:    tileIndex,
    gems_revealed: newGemsRevealed,
    multiplier:    parseFloat(newMult.toFixed(4)),
    next_mult:     nextMult ? parseFloat(nextMult.toFixed(4)) : null,
    payout_rax:    Math.floor(game.bet_rax * newMult),
    status:        'active',
    casino_balance: await getBalance(userId, env.DB),
  }), { headers: { 'Content-Type': 'application/json' } });
}
