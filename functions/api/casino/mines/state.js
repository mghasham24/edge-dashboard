// GET /api/casino/mines/state
// Returns the current active mines game state (for page resume).

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

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);
  const userId = session.user_id;

  const user = await env.DB.prepare('SELECT is_admin, mines_access FROM users WHERE id = ?').bind(userId).first();
  if (!user?.is_admin && !user?.mines_access) return err('Forbidden', 403);

  const game = await env.DB.prepare(
    "SELECT * FROM casino_mines_games WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1"
  ).bind(userId).first();

  if (!game) return new Response(JSON.stringify({ ok: true, game: null }), {
    headers: { 'Content-Type': 'application/json' },
  });

  const safeRemaining = TILES - game.mines_count - game.gems_revealed;
  const nextMult = safeRemaining > 0
    ? calcMultiplier(game.mines_count, game.gems_revealed + 1)
    : null;

  return new Response(JSON.stringify({
    ok: true,
    game: {
      game_id:       game.id,
      bet_rax:       game.bet_rax,
      mines_count:   game.mines_count,
      revealed:      JSON.parse(game.revealed),
      gems_revealed: game.gems_revealed,
      multiplier:    game.multiplier,
      next_mult:     nextMult ? parseFloat(nextMult.toFixed(4)) : null,
      payout_rax:    game.gems_revealed > 0 ? Math.floor(game.bet_rax * game.multiplier) : 0,
      status:        game.status,
    },
  }), { headers: { 'Content-Type': 'application/json' } });
}
