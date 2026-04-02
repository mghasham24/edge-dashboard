// functions/api/auth/register.js
const SESSION_DAYS = 30;
const MAX_REGS_PER_HOUR = 3;

export async function onRequestPost({ request, env }) {
  // IP-based rate limiting — max 3 registrations per IP per hour
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
  const hourKey = 'reg_ip_' + ip + '_' + Math.floor(Date.now() / 3600000);
  try {
    const ipRow = await env.DB.prepare(
      'SELECT data FROM odds_cache WHERE cache_key=?'
    ).bind(hourKey).first();
    const count = ipRow ? parseInt(ipRow.data) : 0;
    if (count >= MAX_REGS_PER_HOUR) {
      return err('Too many accounts created from this IP. Please try again later.', 429);
    }
    // Increment counter
    await env.DB.prepare(
      'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data'
    ).bind(hourKey, String(count + 1), Math.floor(Date.now() / 1000)).run();
  } catch(e) {}

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
  const newRefCode = generateCode();

  const hash = await hashPassword(password);
  const { meta } = await env.DB.prepare(
    'INSERT INTO users (email, password_hash, plan, referral_code) VALUES (?,?,?,?)'
  ).bind(email, hash, 'free', newRefCode).run();

  const newUserId = meta.last_row_id;

  // Track referral — reward is granted when referred user upgrades to Pro (via Stripe webhook)
  if (referrerId) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO referrals (referrer_id, referred_id) VALUES (?,?)'
    ).bind(referrerId, newUserId).run();
    // Also store referred_by on the new user for webhook lookup
    await env.DB.prepare(
      'UPDATE users SET referred_by=? WHERE id=?'
    ).bind(referrerId, newUserId).run();
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

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(5)))
    .map(b => chars[b % chars.length]).join('');
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
