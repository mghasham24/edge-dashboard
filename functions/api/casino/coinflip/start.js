// POST /api/casino/coinflip/start
import { getSession }                  from '../../../_lib/session.js';
import { err }                         from '../../../_lib/response.js';
import { generateSeed, sha256Hex }     from '../../../_lib/provablyFair.js';

const MIN_BET = 100;
const MAX_BET = 10000;

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);

  const user = await env.DB.prepare(
    'SELECT id, casino_balance FROM users WHERE id=?'
  ).bind(session.user_id).first();

  if (!user) return err('User not found', 404);

  const active = await env.DB.prepare(
    "SELECT id FROM casino_coinflip_games WHERE user_id=? AND status='active' LIMIT 1"
  ).bind(user.id).first();
  if (active) return err('Active game in progress', 409);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON', 400); }

  const bet = Math.floor(Number(body.bet));
  if (!Number.isFinite(bet) || bet < MIN_BET || bet > MAX_BET)
    return err(`Bet must be between ${MIN_BET} and ${MAX_BET}`, 400);
  if ((user.casino_balance ?? 0) < bet)
    return err('Insufficient balance', 400);

  // Generate provably fair seeds before insert
  const serverSeed     = await generateSeed(32);
  const clientSeed     = await generateSeed(16);
  const serverSeedHash = await sha256Hex(serverSeed);

  const [balRow] = await env.DB.batch([
    env.DB.prepare(
      'UPDATE users SET casino_balance = casino_balance - ? WHERE id=? AND casino_balance >= ?'
    ).bind(bet, user.id, bet),
    env.DB.prepare(
      'INSERT INTO casino_coinflip_games (user_id, bet_rax, server_seed, server_seed_hash, client_seed) VALUES (?, ?, ?, ?, ?)'
    ).bind(user.id, bet, serverSeed, serverSeedHash, clientSeed),
  ]);

  if (!balRow.meta.changes) return err('Balance changed — please retry', 409);

  const [game, updated] = await Promise.all([
    env.DB.prepare(
      "SELECT * FROM casino_coinflip_games WHERE user_id=? AND status='active' ORDER BY id DESC LIMIT 1"
    ).bind(user.id).first(),
    env.DB.prepare('SELECT casino_balance FROM users WHERE id=?').bind(user.id).first(),
  ]);

  // Return game but expose only hash (not server_seed) while active
  const safeGame = Object.assign({}, game);
  delete safeGame.server_seed;

  return new Response(JSON.stringify({
    ok:          true,
    game:        safeGame,
    new_balance: updated?.casino_balance ?? 0,
  }), { headers: { 'Content-Type': 'application/json' } });
}
