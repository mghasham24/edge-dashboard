// functions/api/auth/login.js
import { checkRateLimit } from '../../_lib/rateLimit.js';
import { hashPassword, verifyPassword } from '../../_lib/password.js';
import { genToken, cookie, ok, err } from '../../_lib/response.js';

const SESSION_DAYS = 30;

export async function onRequestPost({ request, env }) {
  try {
    // 10 attempts per 15 minutes per IP
    const allowed = await checkRateLimit(env.DB, request, 'login', 10, 900);
    if (!allowed) return err('Too many login attempts. Please try again later.', 429);

    let body;
    try { body = await request.json(); } catch { return err('Invalid JSON'); }

    const email    = (body.email    || '').trim().toLowerCase();
    const password = (body.password || '').trim();

    if (!email || !password) return err('Email and password required');

    const user = await env.DB.prepare(
      'SELECT id, email, password_hash, plan, is_admin, banned FROM users WHERE email=?'
    ).bind(email).first();

    // Always verify to prevent timing attacks
    const dummy = 'a'.repeat(32) + ':' + 'a'.repeat(64);
    const result = user
      ? await verifyPassword(password, user.password_hash)
      : (await verifyPassword(password, dummy), { valid: false, needsRehash: false });

    if (!user || !result.valid) return err('Incorrect email or password', 401);

    if (user.banned) return err('Your account has been suspended. Contact support.', 403);

    if (result.needsRehash) {
      const newHash = await hashPassword(password);
      await env.DB.prepare('UPDATE users SET password_hash=? WHERE id=?').bind(newHash, user.id).run();
    }

    const token = genToken();
    const exp   = Math.floor(Date.now()/1000) + SESSION_DAYS * 86400;
    await env.DB.prepare(
      'INSERT INTO sessions (user_id, token, expires_at) VALUES (?,?,?)'
    ).bind(user.id, token, exp).run();

    return ok({
      email: user.email,
      plan: user.plan,
      is_admin: user.is_admin || 0
    }, 200, cookie(token, exp));
  } catch(e) {
    return err('Login failed: ' + (e && e.message ? e.message : String(e)), 500);
  }
}

