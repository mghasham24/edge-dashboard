// functions/api/casino/balance.js
// GET /api/casino/balance
// Returns casino_balance and any active game state (for resume on page load).

import { getSession } from '../../_lib/session.js';
import { err }        from '../../_lib/response.js';
import { loadActiveGame, clientState } from '../../_lib/blackjack.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);
  const userId = session.user_id;

  const [userRow, activeGame] = await Promise.all([
    env.DB.prepare('SELECT casino_balance FROM users WHERE id = ?').bind(userId).first(),
    loadActiveGame(userId, env.DB),
  ]);

  return new Response(JSON.stringify({
    ok:              true,
    casino_balance:  userRow?.casino_balance ?? 0,
    active_game:     activeGame ? clientState(activeGame) : null,
  }), { headers: { 'Content-Type': 'application/json' } });
}
