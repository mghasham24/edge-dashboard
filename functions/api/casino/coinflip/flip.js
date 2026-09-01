// POST /api/casino/coinflip/flip
import { getSession }        from '../../../_lib/session.js';
import { err }               from '../../../_lib/response.js';
import { deriveFlipResult }  from '../../../_lib/provablyFair.js';

const PAYOUT_MULT = 1.9;
const MAX_PAYOUT  = 100000;

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
  if (!game) return err('No active game', 404);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON', 400); }

  const side = body.side;
  if (side !== 'heads' && side !== 'tails') return err('Side must be heads or tails', 400);

  // Derive result from server_seed + client_seed + nonce (flips_won = number of successful flips so far)
  const nonce  = game.flips_won; // 0 for first flip, 1 for second, etc.
  const result = game.server_seed
    ? await deriveFlipResult(game.server_seed, game.client_seed, nonce)
    : (Math.random() < 0.5 ? 'heads' : 'tails'); // fallback for legacy games without seeds

  const won = result === side;

  const log = JSON.parse(game.flip_log || '[]');
  log.push({ side, result, won });

  if (won) {
    const newFlipsWon = game.flips_won + 1;
    const newMult     = Math.round(game.current_multiplier * PAYOUT_MULT * 10000) / 10000;
    const newPayout   = Math.min(Math.floor(game.bet_rax * newMult), MAX_PAYOUT);

    await env.DB.prepare(
      `UPDATE casino_coinflip_games
       SET flips_won=?, current_multiplier=?, payout_rax=?, flip_log=?
       WHERE id=?`
    ).bind(newFlipsWon, newMult, newPayout, JSON.stringify(log), game.id).run();

    return new Response(JSON.stringify({
      ok:                 true,
      won:                true,
      result,
      flips_won:          newFlipsWon,
      current_multiplier: newMult,
      payout_rax:         newPayout,
      maxed:              newPayout >= MAX_PAYOUT,
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  // Lost — game over, bet already deducted at start
  const profit = game.bet_rax;
  await env.DB.prepare(
    `UPDATE casino_coinflip_games
     SET status='lost', payout_rax=0, profit=?, flip_log=?
     WHERE id=?`
  ).bind(profit, JSON.stringify(log), game.id).run();

  return new Response(JSON.stringify({
    ok:              true,
    won:             false,
    result,
    status:          'lost',
    flips_won:       game.flips_won,
    server_seed:     game.server_seed ?? null,
    server_seed_hash: game.server_seed_hash ?? null,
    client_seed:     game.client_seed ?? null,
  }), { headers: { 'Content-Type': 'application/json' } });
}
