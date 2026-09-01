// GET /api/casino/coinflip/state — returns active game if one exists
import { getSession } from '../../../_lib/session.js';
import { err }        from '../../../_lib/response.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);

  const user = await env.DB.prepare(
    'SELECT id FROM users WHERE id=?'
  ).bind(session.user_id).first();
  if (!user) return err('User not found', 404);

  const game = await env.DB.prepare(
    "SELECT * FROM casino_coinflip_games WHERE user_id=? AND status='active' LIMIT 1"
  ).bind(session.user_id).first();

  if (!game) {
    return new Response(JSON.stringify({ ok: true, game: null }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Never expose server_seed while game is still active
  const safeGame = Object.assign({}, game);
  delete safeGame.server_seed;

  return new Response(JSON.stringify({ ok: true, game: safeGame }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
