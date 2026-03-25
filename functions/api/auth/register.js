// functions/api/auth/register.js
const SESSION_DAYS = 30;
const REFERRALS_FOR_REWARD = 5;
const REWARD_MONTHS = 3;

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const email   = (body.email    || '').trim().toLowerCase();
  const password = (body.password || '').trim();
  const refCode  = (body.refCode  || '').trim().toUpperCase();

  if (!email || !password) return err('Email and password required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err('Invalid email address');
  if (password.length < 8) return err('Password must be at least 8 characters');

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
  if (existing) return err('An account with that email already exists', 409);

  // Validate referral code if provided
  let referrerId = null;
  if (refCode) {
    const referrer = await env.DB.prepare(
      'SELECT id FROM users WHERE referral_code=?'
    ).bind(refCode).first();
    if (referrer) referrerId = referrer.id;
  }

  // Generate referral code for new user
  const newRefCode = generateCode(email);

  const hash = await hashPassword(password);
  const { meta } = await env.DB.prepare(
    'INSERT INTO users (email, password_hash, plan, referral_code) VALUES (?,?,?,?)'
  ).bind(email, hash, 'free', newRefCode).run();

  const newUserId = meta.last_row_id;

  // Track referral and check for reward
  if (referrerId) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO referrals (referrer_id, referred_id) VALUES (?,?)'
    ).bind(referrerId, newUserId).run();

    // Count referrer's total referrals
    const countRow = await env.DB.prepare(
      'SELECT COUNT(*) as c FROM referrals WHERE referrer_id=?'
    ).bind(referrerId).first();
    const total = countRow ? countRow.c : 0;

    // Every 5 referrals = 3 months Pro
    if (total % REFERRALS_FOR_REWARD === 0) {
      const referrer = await env.DB.prepare(
        'SELECT plan, pro_expires_at FROM users WHERE id=?'
      ).bind(referrerId).first();
      const now = Math.floor(Date.now() / 1000);
      const base = (referrer && referrer.pro_expires_at && referrer.pro_expires_at > now)
        ? referrer.pro_expires_at
        : now;
      const newExpiry = base + REWARD_MONTHS * 30 * 86400;
      await env.DB.prepare(
        'UPDATE users SET plan=\'pro\', pro_expires_at=? WHERE id=?'
      ).bind(newExpiry, referrerId).run();
    }
  }

  const token = genToken();
  const exp   = Math.floor(Date.now()/1000) + SESSION_DAYS * 86400;
  await env.DB.prepare(
    'INSERT INTO sessions (user_id, token, expires_at) VALUES (?,?,?)'
  ).bind(newUserId, token, exp).run();

  // Send welcome email
  if (env.RESEND_API_KEY) {
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'RaxEdge <noreply@raxedge.com>',
        to: email,
        subject: 'Welcome to RaxEdge',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 24px;background:#0a0a0c;color:#f0eff5;border-radius:12px">
            <div style="font-size:20px;font-weight:700;margin-bottom:8px">RaxEdge</div>
            <div style="font-size:15px;color:#7a7990;margin-bottom:32px">Rax Prediction Edge Calculator</div>
            <div style="font-size:18px;font-weight:600;margin-bottom:16px">Welcome! You're in.</div>
            <p style="color:#7a7990;font-size:14px;line-height:1.6">You now have access to real-time FanDuel odds, no-vig fair value, and instant edge calculations for your Rax predictions.</p>
            <p style="color:#7a7990;font-size:14px;line-height:1.6;margin-top:16px">Your referral code is <strong style="color:#4f6ef7">${newRefCode}</strong> — share it with friends to earn free Pro months!</p>
            <a href="https://raxedge.com" style="display:inline-block;margin:24px 0;background:#4f6ef7;color:#fff;text-decoration:none;padding:12px 28px;border-radius:7px;font-weight:600;font-size:14px">Go to RaxEdge</a>
            <p style="color:#4a4960;font-size:12px">Made by @moe_ · raxedge.com</p>
          </div>
        `
      })
    }).catch(() => {});
  }

  return ok({ email, plan: 'free' }, 201, cookie(token, exp));
}

function generateCode(email) {
  const prefix = email.split('@')[0].replace(/[^a-zA-Z0-9]/g,'').toUpperCase().slice(0, 6);
  const suffix = Math.floor(1000 + Math.random() * 9000);
  return prefix + suffix;
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
