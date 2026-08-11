// GET /api/parlays/deposit-check-log?_cron_key=...
// Returns the last deposit-check run result stored in D1.
import { err } from '../../_lib/response.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (!env.CRON_SECRET || url.searchParams.get('_cron_key') !== env.CRON_SECRET)
    return err('Unauthorized', 401);
  const row = await env.DB.prepare(
    'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
  ).bind('deposit_check_debug').first();
  if (!row) return new Response(JSON.stringify({ error: 'no log yet' }), { headers: { 'Content-Type': 'application/json' } });
  return new Response(row.data, { headers: { 'Content-Type': 'application/json' } });
}
