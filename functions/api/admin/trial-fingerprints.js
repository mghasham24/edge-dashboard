import { getSession } from '../../_lib/session.js';
// functions/api/admin/trial-fingerprints.js
// Admin endpoint to inspect stored trial fingerprints
export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');
  if (!session.is_admin) return fail(403, 'Forbidden');

  const rows = await env.DB.prepare(
    'SELECT tf.fingerprint, tf.user_id, tf.created_at, u.email FROM trial_fingerprints tf LEFT JOIN users u ON u.id=tf.user_id ORDER BY tf.created_at DESC'
  ).all();

  return new Response(JSON.stringify({ ok: true, fingerprints: rows.results || [] }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
