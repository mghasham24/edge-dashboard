import { hashPassword } from '../../_lib/password.js';
import { genToken, err } from '../../_lib/response.js';
// functions/api/auth/reset.js
const SESSION_DAYS = 30;

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return fail('Invalid request'); }

  const { token, password } = body;
  if (!token || !password) return err('Missing fields');
  if (password.length < 8) return err('Password must be at least 8 characters');

  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    'SELECT user_id FROM password_resets WHERE token=? AND expires_at>?'
  ).bind(token, now).first();

  if (!row) return err('Reset link is invalid or has expired');

  const hash = await hashPassword(password);
  await env.DB.prepare('UPDATE users SET password_hash=? WHERE id=?').bind(hash, row.user_id).run();
  await env.DB.prepare('DELETE FROM password_resets WHERE user_id=?').bind(row.user_id).run();
  // Invalidate all existing sessions before issuing a new one
  await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(row.user_id).run();

  // Issue a new session — identity already proven by the reset token
  const sessionToken = genToken();
  const exp = now + SESSION_DAYS * 86400;
  await env.DB.prepare(
    'INSERT INTO sessions (user_id, token, expires_at) VALUES (?,?,?)'
  ).bind(row.user_id, sessionToken, exp).run();

  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=${new Date(exp * 1000).toUTCString()}`
    }
  });
}

