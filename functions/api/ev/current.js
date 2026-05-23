// functions/api/ev/current.js
// Returns the latest +EV bets written by alert-cron each minute.
// Used by the Mac ev-group-poster script to know what to post.
// Protected by cron key (same as alert-cron).

import { getSessionOrCron } from '../../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  // Accept cron key, admin session, or dedicated poster key
  const url       = new URL(request.url);
  const posterKey = url.searchParams.get('_poster_key');
  if (!posterKey || posterKey !== env.EV_POSTER_KEY) {
    const auth = await getSessionOrCron(request, env);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // Debug: show raw RS market object fields from D1 cache
  if (url.searchParams.get('debug') === 'market_keys') {
    try {
      const rsRow = await env.DB.prepare(
        "SELECT cache_key, data FROM odds_cache WHERE cache_key LIKE 'real_sync_%' ORDER BY fetched_at DESC LIMIT 3"
      ).all();
      const result = {};
      for (const row of (rsRow.results || [])) {
        const d = JSON.parse(row.data);
        const gameKey = Object.keys(d).find(k => !k.endsWith('__gid') && !k.endsWith('__sport') && !k.endsWith('__lines') && !k.endsWith('__startMs'));
        if (gameKey) {
          const markets = d[gameKey];
          const firstMktLabel = Object.keys(markets)[0];
          const firstMkt = markets[firstMktLabel];
          result[row.cache_key] = { gameKey, firstMktLabel, marketKeys: firstMkt ? Object.keys(firstMkt) : [], firstMkt };
        }
      }
      return new Response(JSON.stringify({ ok: true, result }), { headers: { 'Content-Type': 'application/json' } });
    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), { headers: { 'Content-Type': 'application/json' } });
    }
  }

  try {
    const row = await env.DB.prepare(
      "SELECT data, fetched_at FROM odds_cache WHERE cache_key='ev_bets_latest'"
    ).first();

    if (!row) {
      return new Response(JSON.stringify({ ok: false, bets: [], reason: 'no_data' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const payload = JSON.parse(row.data);
    return new Response(JSON.stringify({ ok: true, fetched_at: row.fetched_at, ...payload }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
