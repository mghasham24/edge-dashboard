import { getSession } from '../../_lib/session.js';
// functions/api/alerts/cronlog.js
// Admin-only: read the latest cron_debug snapshot from D1
export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session || !session.is_admin) return new Response(JSON.stringify({ error: 'Admin only' }), { status: 403, headers: { 'Content-Type': 'application/json' } });

  const now = Math.floor(Date.now() / 1000);
  try {
    const row = await env.DB.prepare(
      'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
    ).bind('cron_debug').first();
    if (!row) return new Response(JSON.stringify({ error: 'No cron_debug row found — cron may not have run yet' }), { headers: { 'Content-Type': 'application/json' } });
    const age = now - row.fetched_at;
    return new Response(JSON.stringify({ ageSeconds: age, data: JSON.parse(row.data) }), { headers: { 'Content-Type': 'application/json' } });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
