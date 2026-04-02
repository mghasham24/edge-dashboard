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

  // Block disposable email domains
  const BLOCKED_DOMAINS = new Set([
    'mailinator.com','guerrillamail.com','tempmail.com','throwam.com','sharklasers.com',
    'guerrillamailblock.com','grr.la','guerrillamail.info','guerrillamail.biz','guerrillamail.de',
    'guerrillamail.net','guerrillamail.org','spam4.me','trashmail.com','trashmail.me',
    'trashmail.net','dispostable.com','maildrop.cc','yopmail.com','yopmail.fr',
    'cool.fr.nf','jetable.fr.nf','nospam.ze.tc','nomail.xl.cx','mega.zik.dj',
    'speed.1s.fr','courriel.fr.nf','moncourrier.fr.nf','monemail.fr.nf','monmail.fr.nf',
    'spamgourmet.com','spamgourmet.net','spamgourmet.org','spamgourmet.me',
    'spamgourmet.net','jnxjn.com','tnef.com','10minutemail.com','10minutemail.net',
    'fakeinbox.com','filzmail.com','gowiki.com','humaility.com','incognitomail.com',
    'mail-temporaire.fr','mytrashmail.com','nobulk.com','nospamfor.us','nowmymail.com',
    'objectmail.com','obobbo.com','proxymail.eu','rcpt.at','recursor.net','shiftmail.com',
    'skeefmail.com','slopsbox.com','smellfear.com','snkmail.com','sofimail.com',
    'sogetthis.com','spamevader.com','spamfree24.org','spamhole.com','spamify.com',
    'spamoff.de','spamobox.com','spamthisplease.com','supergreatmail.com','suremail.info',
    'tempemail.net','tempinbox.co.uk','tempinbox.com','thanksnospam.info','thisisnotmyrealemail.com',
    'throwam.com','tradermail.info','trash-mail.at','trash-mail.com','trash-mail.de',
    'trash-mail.io','trash-mail.me','trash-mail.net','trash2009.com','trashdevil.com',
    'trashdevil.de','trashemail.de','trashimail.com','trashmail.at','travestimail.com',
    'trbvm.com','turual.com','twinmail.de','tyldd.com','uggsrock.com','uroid.com',
    'us.af','venompen.com','veryrealemail.com','vidchart.com','viditag.com','vipikings.com',
    'vmani.com','vomoto.com','vpn.st','vsimcard.com','vubby.com','wasteland.rfc822.org',
    'webemail.me','webm4il.info','weg-werf-email.de','wegwerf-emails.de','wegwerfadresse.de',
    'wegwerfemail.com','wegwerfemail.de','wegwerfmail.de','wegwerfmail.info','wegwerfmail.net',
    'wegwerfmail.org','wetrainbayarea.com','wetrainbayarea.org','whyspam.me','willhackforfood.biz',
    'willselfdestruct.com','winemaven.info','wronghead.com','wuzup.net','wuzupmail.net',
    'www.e4ward.com','www.mailinator.com','wwwnew.eu','x.ip6.li','xagloo.co','xagloo.com',
    'xemaps.com','xents.com','xmaily.com','xoxy.net','xup.in','xww.ro','xy9ce.at',
    'yapped.net','yep.it','yet.com','yomail.info','yopmail.pp.ua','yourdomain.com',
    'ypmail.webarnak.fr.eu.org','yuurok.com','z1p.biz','za.com','zebins.com','zebins.eu',
    'zehnminuten.de','zehnminutenmail.de','zetmail.com','zippymail.info','zoemail.net',
    'zoemail.org','zomg.info','jsncos.com','1951addd11f8.com','4218cd4d6883.com',
    'add746fba024.com','9d927fc60518.com','3f6bfd335f37.com','5cbb551b1faa.com'
  ]);
  const emailDomain = email.split('@')[1];
  if (BLOCKED_DOMAINS.has(emailDomain)) return err('Please use a valid email address.');

  // Block offensive email prefixes
  const localPart = email.split('@')[0];
  const BLOCKED_PREFIXES = ['fuckpalestine','fuckisrael','fuckjews','fuckarab','fuckmuslim','fuckchrist'];
  if (BLOCKED_PREFIXES.some(p => localPart.includes(p))) return err('Invalid email address.');

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
