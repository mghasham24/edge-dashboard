// functions/api/admin/migrate-free-trial.js
// One-time migration: adds had_free_trial column to users table
export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');
  if (!session.is_admin) return fail(403, 'Forbidden');

  try {
    await env.DB.prepare(
      'ALTER TABLE users ADD COLUMN had_free_trial INTEGER NOT NULL DEFAULT 0'
    ).run();
    return new Response(JSON.stringify({ ok: true, message: 'Column had_free_trial added successfully' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch(e) {
    // Column may already exist
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
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
