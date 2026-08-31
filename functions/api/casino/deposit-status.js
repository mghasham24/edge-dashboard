// functions/api/casino/deposit-status.js
// GET /api/casino/deposit-status
// Lightweight DB-only check — no RS API calls.
// Client polls this every 10s while deposit modal is open.
// All RS work (countering, accepting, Phase 0/0b) is cron-only via deposit-check.js.

import { getSession } from '../../_lib/session.js';
import { err }        from '../../_lib/response.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);

  const row = await env.DB.prepare(
    "SELECT id, status, rax_credited FROM casino_deposits WHERE user_id=? ORDER BY id DESC LIMIT 1"
  ).bind(session.user_id).first();

  if (!row) {
    return new Response(JSON.stringify({ pending: false, confirmed: false }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (row.status === 'confirmed') {
    return new Response(JSON.stringify({ pending: false, confirmed: true, credited: row.rax_credited }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (row.status === 'pending') {
    return new Response(JSON.stringify({ pending: true, confirmed: false }), { headers: { 'Content-Type': 'application/json' } });
  }

  // expired / cancelled
  return new Response(JSON.stringify({ pending: false, confirmed: false, status: row.status }), { headers: { 'Content-Type': 'application/json' } });
}
