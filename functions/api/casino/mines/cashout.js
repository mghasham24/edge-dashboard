// POST /api/casino/mines/cashout
// Cash out current winnings. Body: { game_id }

import { getSession } from '../../../_lib/session.js';
import { err }        from '../../../_lib/response.js';

async function getBalance(userId, db) {
  const row = await db.prepare('SELECT casino_balance FROM users WHERE id = ?').bind(userId).first();
  return row?.casino_balance ?? 0;
}

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);
  const userId = session.user_id;

  const user = await env.DB.prepare('SELECT is_admin, mines_access FROM users WHERE id = ?').bind(userId).first();
  if (!user?.is_admin && !user?.mines_access) return err('Forbidden', 403);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON', 400); }

  const gameId = body.game_id;
  if (!Number.isInteger(gameId)) return err('game_id required', 400);

  const game = await env.DB.prepare(
    "SELECT * FROM casino_mines_games WHERE id = ? AND user_id = ? AND status = 'active'"
  ).bind(gameId, userId).first();
  if (!game) return err('No active game found', 404);

  if (game.gems_revealed === 0) return err('Reveal at least one gem before cashing out.', 400);

  const payout = Math.min(Math.floor(game.bet_rax * game.multiplier), 100000);

  await env.DB.prepare(
    "UPDATE casino_mines_games SET status = 'won' WHERE id = ?"
  ).bind(gameId).run();
  await env.DB.prepare(
    'UPDATE users SET casino_balance = casino_balance + ? WHERE id = ?'
  ).bind(payout, userId).run();

  const mines = JSON.parse(game.mine_positions);

  return new Response(JSON.stringify({
    ok:             true,
    payout_rax:     payout,
    multiplier:     game.multiplier,
    mine_positions: mines,
    status:         'won',
    casino_balance: await getBalance(userId, env.DB),
  }), { headers: { 'Content-Type': 'application/json' } });
}
