// POST /api/parlays/backfill-headshots
// Called automatically when a user loads the Build tab and DK player data is fetched.
// Updates headshot_url for any parlay_legs rows that still have null headshot_url.
// Fire-and-forget from the client — response is not awaited.

import { getSession } from '../../_lib/session.js';
import { ok, err }    from '../../_lib/response.js';

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);

  let body;
  try { body = await request.json(); } catch { return err('Invalid body', 400); }

  const players = body.players;
  if (!Array.isArray(players) || !players.length) return ok({ updated: 0 });

  // Only accept valid {name, headshotUrl} pairs with our own proxy URL
  const valid = players.filter(function(p) {
    return p && typeof p.name === 'string' && p.name.length <= 100 &&
           typeof p.headshotUrl === 'string' &&
           p.headshotUrl.startsWith('/api/dk/player-image?id=');
  });
  if (!valid.length) return ok({ updated: 0 });

  await env.DB.batch(valid.map(p =>
    env.DB.prepare(
      'UPDATE parlay_legs SET headshot_url = ? WHERE player_name = ? AND headshot_url IS NULL'
    ).bind(p.headshotUrl, p.name)
  ));

  return ok({ updated: valid.length });
}
