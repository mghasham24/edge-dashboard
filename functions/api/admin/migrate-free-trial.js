import { getSession } from '../../_lib/session.js';
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

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
