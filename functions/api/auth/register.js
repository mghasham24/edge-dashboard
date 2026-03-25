// functions/api/auth/register.js
const SESSION_DAYS = 30;

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const email    = (body.email    || '').trim().toLowerCase();
  const password = (body.password || '').trim();

  if (!email || !password) return err('Email and password required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err('Invalid email address');
  if (password.length < 8) return err('Password must be at least 8 characters');

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
  if (existing) return err('An account with that email already exists', 409);

  const hash = await hashPassword(password);
  const { meta } = await env.DB.prepare(
    'INSERT INTO users (email, password_hash, plan) VALUES (?,?,?)'
  ).bind(email, hash, 'free').run();

  const token = genToken();
  const exp   = Math.floor(Date.now()/1000) + SESSION_DAYS * 86400;
  await env.DB.prepare(
    'INSERT INTO sessions (user_id, token, expires_at) VALUES (?,?,?)'
  ).bind(meta.last_row_id, token, exp).run();

  return ok({ email, plan: 'free' }, 201, cookie(token, exp));
}

// ── Helpers ───────────────────────────────────────────
async function hashPassword(pw) {
  const enc  = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key  = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name:'PBKDF2', hash:'SHA-256', salt, iterations:100000 }, key, 256);
  const h2   = b => b.toString(16).padStart(2,'0');
  return [...salt].map(h2).join('') + ':' + [...new Uint8Array(bits)].map(h2).join('');
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
