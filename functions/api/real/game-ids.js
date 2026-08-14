// functions/api/real/game-ids.js
// GET /api/real/game-ids?sport=baseball_mlb
// Returns RS game IDs from the D1 RS sync cache — no new RS API call.
// Used by My Slips to populate rsGameIds so all slip legs can show the RS icon.

import { getSessionOrCron } from '../../_lib/auth.js';

const CACHE_VERSION = 'v12';
const SUPPORTED = new Set(['baseball_mlb', 'basketball_wnba', 'football_nfl', 'icehockey_nhl', 'basketball_nba']);

export async function onRequestGet(ctx) {
  const { request, env } = ctx;
  const { searchParams } = new URL(request.url);
  const sport = searchParams.get('sport') || 'baseball_mlb';

  const auth = await getSessionOrCron(request, env);
  if (!auth.ok) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!SUPPORTED.has(sport)) {
    return new Response(JSON.stringify({ ok: true, gameIds: {} }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const cacheKey = `real_sync_${sport}_${CACHE_VERSION}`;
  const row = await env.DB.prepare('SELECT data FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
  if (!row) {
    return new Response(JSON.stringify({ ok: true, gameIds: {} }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let marketMap;
  try { marketMap = JSON.parse(row.data); } catch { marketMap = {}; }

  const gameIds = {};
  for (const key of Object.keys(marketMap)) {
    if (key.endsWith('__gid')) {
      const gameKey = key.slice(0, -5); // strip "__gid"
      gameIds[gameKey] = marketMap[key];
    }
  }

  return new Response(JSON.stringify({ ok: true, gameIds }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
