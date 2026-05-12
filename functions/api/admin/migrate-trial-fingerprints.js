import { getSession } from '../../_lib/session.js';
// functions/api/admin/migrate-trial-fingerprints.js
// One-time migration: creates trial_fingerprints table for card abuse prevention
export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');
  if (!session.is_admin) return fail(403, 'Forbidden');

  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS trial_fingerprints (
        fingerprint TEXT PRIMARY KEY,
        user_id     INTEGER NOT NULL,
        created_at  INTEGER NOT NULL
      )
    `).run();
    return new Response(JSON.stringify({ ok: true, message: 'trial_fingerprints table created' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch(e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
