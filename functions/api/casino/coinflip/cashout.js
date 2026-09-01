// POST /api/casino/coinflip/cashout
import { getSession } from '../../../_lib/session.js';
import { err }        from '../../../_lib/response.js';

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);

  const user = await env.DB.prepare(
    'SELECT id FROM users WHERE id=?'
  ).bind(session.user_id).first();
  if (!user) return err('User not found', 404);

  const game = await env.DB.prepare(
    "SELECT * FROM casino_coinflip_games WHERE user_id=? AND status='active' LIMIT 1"
  ).bind(user.id).first();
  if (!game)           return err('No active game', 404);
  if (!game.flips_won) return err('Must win at least one flip before cashing out', 400);

  const payout = game.payout_rax;
  const profit = game.bet_rax - payout; // negative = house lost

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE casino_coinflip_games SET status='cashed_out', profit=? WHERE id=?"
    ).bind(profit, game.id),
    env.DB.prepare(
      'UPDATE users SET casino_balance = casino_balance + ? WHERE id=?'
    ).bind(payout, user.id),
  ]);

  const updated = await env.DB.prepare(
    'SELECT casino_balance FROM users WHERE id=?'
  ).bind(user.id).first();

  return new Response(JSON.stringify({
    ok:              true,
    payout_rax:      payout,
    new_balance:     updated?.casino_balance ?? 0,
    server_seed:     game.server_seed ?? null,
    server_seed_hash: game.server_seed_hash ?? null,
    client_seed:     game.client_seed ?? null,
  }), { headers: { 'Content-Type': 'application/json' } });
}
