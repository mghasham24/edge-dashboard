// functions/api/auth/login.js
const SESSION_DAYS = 30; // 30-day sessions



export async function onRequestPost({ request, env }) {
  try {
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
    const valid  = user
      ? await verifyPassword(password, user.password_hash)
      : (await verifyPassword(password, dummy), false);

    if (!user || !valid) return err('Incorrect email or password', 401);

    if (user.banned) return err('Your account has been suspended. Contact support.', 403);

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

// ── Helpers ───────────────────────────────────────────
async function verifyPassword(pw, stored) {
  const parts = (stored || '').split(':');
  if (parts.length !== 2) return false;
  const salt = new Uint8Array(parts[0].match(/.{2}/g).map(b => parseInt(b, 16)));
  const enc  = new TextEncoder();
  const key  = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name:'PBKDF2', hash:'SHA-256', salt, iterations:100000 }, key, 256);
  const hex  = [...new Uint8Array(bits)].map(b=>b.toString(16).padStart(2,'0')).join('');
  return hex === parts[1];
}

function genToken() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join('');
}

function cookie(token, exp) {
  return `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=${new Date(exp*1000).toUTCString()}`;
}

function ok(data, status, setCookie) {
  const h = { 'Content-Type': 'application/json' };
  if (setCookie) h['Set-Cookie'] = setCookie;
  return new Response(JSON.stringify({ ok: true, ...data }), { status, headers: h });
}

function err(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
