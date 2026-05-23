// functions/api/ev/current.js
// Returns the latest +EV bets written by alert-cron each minute.
// Used by the Mac ev-group-poster script to know what to post.
// Protected by cron key (same as alert-cron).

import { getSessionOrCron } from '../../../_lib/auth.js';

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
