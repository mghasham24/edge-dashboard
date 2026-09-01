// GET /api/casino/coinflip/history
import { getSession } from '../../../_lib/session.js';
import { err }        from '../../../_lib/response.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);

  const user = await env.DB.prepare(
    'SELECT id FROM users WHERE id=?'
  ).bind(session.user_id).first();
  if (!user) return err('User not found', 404);

  const { results } = await env.DB.prepare(
    `SELECT id, bet_rax, status, flips_won, current_multiplier, payout_rax, profit, flip_log, created_at,
            server_seed, server_seed_hash, client_seed
     FROM casino_coinflip_games
     WHERE user_id=? AND status != 'active'
     ORDER BY id DESC
     LIMIT 20`
  ).bind(session.user_id).all();

  return new Response(JSON.stringify({ ok: true, games: results }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
