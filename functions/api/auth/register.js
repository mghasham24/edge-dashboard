// functions/api/auth/register.js
import { checkRateLimit } from '../../_lib/rateLimit.js';
import { hashPassword } from '../../_lib/password.js';
import { genToken, cookie, ok, err } from '../../_lib/response.js';
import { BLOCKED_DOMAINS } from '../../_lib/blockedDomains.js';

const SESSION_DAYS = 30;

export async function onRequestPost({ request, env }) {
  // 3 registrations per hour per IP
  const allowed = await checkRateLimit(env.DB, request, 'register', 3, 3600);
  if (!allowed) return err('Too many accounts created from this IP. Please try again later.', 429);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const email    = (body.email    || '').trim().toLowerCase();
  const password = (body.password || '').trim();
  const refCode  = (body.refCode  || '').trim().toUpperCase();
  const rcToken  = (body.rcToken  || '').trim();

  // reCAPTCHA v3 verification — fail open to avoid blocking real users
  if (env.RECAPTCHA_SECRET && rcToken) {
    try {
      const rcRes = await fetch('https://www.google.com/recaptcha/api/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `secret=${env.RECAPTCHA_SECRET}&response=${rcToken}`
      });
      const rcData = await rcRes.json();
      // Only hard block obvious bots (score 0.1 or below) — fail open for everything else
      if (rcData.success && rcData.score <= 0.1) {
        return err('Registration blocked. Please try again.', 403);
      }
    } catch(e) {}
  }

  if (!email || !password) return err('Email and password required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err('Invalid email address');
  if (password.length < 8) return err('Password must be at least 8 characters');

  // Block disposable email domains
  const emailDomain = email.split('@')[1];
  if (BLOCKED_DOMAINS.has(emailDomain)) return err('Please use a valid email address.');

  // Block offensive email prefixes
  const localPart = email.split('@')[0];
  const BLOCKED_PREFIXES = /(?:^|[^a-zA-Z])fuck(?:palestine|israel|jews|arab|muslim|christ)/i;
  if (BLOCKED_PREFIXES.test(localPart)) return err('Invalid email address.');

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
  const newRefCode = await generateUniqueCode(env.DB);

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
        text: `Welcome to RaxEdge!\n\nYou now have access to real-time FanDuel odds, no-vig fair value, and instant edge calculations for your Rax predictions.\n\nYour referral code is ${newRefCode} — share it with friends to earn free Pro months!\n\nGo to RaxEdge: https://raxedge.com\n\nMade by @moe_ · raxedge.com`,
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

async function generateUniqueCode(db) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let i = 0; i < 10; i++) {
    const code = Array.from(crypto.getRandomValues(new Uint8Array(5)))
      .map(b => chars[b % chars.length]).join('');
    const exists = await db.prepare('SELECT 1 FROM users WHERE referral_code=?').bind(code).first();
    if (!exists) return code;
  }
  throw new Error('Failed to generate unique referral code');
}

