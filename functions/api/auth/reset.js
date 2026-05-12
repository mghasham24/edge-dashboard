import { hashPassword } from '../../_lib/password.js';
// functions/api/auth/reset.js
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return fail('Invalid request'); }

  const { token, password } = body;
  if (!token || !password) return fail('Missing fields');
  if (password.length < 8) return fail('Password must be at least 8 characters');

  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    'SELECT user_id FROM password_resets WHERE token=? AND expires_at>?'
  ).bind(token, now).first();

  if (!row) return fail('Reset link is invalid or has expired');

  const hash = await hashPassword(password);
  await env.DB.prepare('UPDATE users SET password_hash=? WHERE id=?').bind(hash, row.user_id).run();
  await env.DB.prepare('DELETE FROM password_resets WHERE user_id=?').bind(row.user_id).run();
  // Invalidate all existing sessions
  await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(row.user_id).run();

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}

function fail(msg) {
  return new Response(JSON.stringify({ error: msg }), { status: 400, headers: { 'Content-Type': 'application/json' } });
}
