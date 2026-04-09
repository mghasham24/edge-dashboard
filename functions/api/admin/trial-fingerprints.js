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

async function getSession(request, db) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return null;
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    'SELECT u.id as user_id, u.is_admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(m[1], now).first();
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
