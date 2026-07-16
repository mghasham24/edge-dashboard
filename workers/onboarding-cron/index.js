// workers/onboarding-cron/index.js
// Runs once daily at 2pm UTC via Cloudflare Cron Trigger.
// Sends onboarding emails 2, 3, 4 to new Pro trial subscribers who
// haven't activated yet, based on when Email 1 was sent.
//
// Email timing:
//   Email 2: T+24h  — only if 0 sessions recorded
//   Email 3: T+72h  — only if still 0 sessions
//   Email 4: T+11d  — everyone (two versions: 0-session vs engaged)

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  }
};

async function run(env) {
  if (!env.RESEND_API_KEY) return;
  const now = Math.floor(Date.now() / 1000);
  await sendEmail2Batch(env, now);
  await sendEmail3Batch(env, now);
  await sendEmail4Batch(env, now);
}

// ── Email 2: T+24h, zero sessions ────────────────────

async function sendEmail2Batch(env, now) {
  const windowStart = now - 48 * 3600;
  const windowEnd   = now - 24 * 3600;

  const rows = await env.DB.prepare(`
    SELECT u.id, u.email, oe.sent_at AS sub_at
    FROM onboarding_emails oe
    JOIN users u ON u.id = oe.user_id
    WHERE oe.step = 1
      AND oe.sent_at >= ? AND oe.sent_at < ?
      AND NOT EXISTS (SELECT 1 FROM onboarding_emails x WHERE x.user_id = oe.user_id AND x.step = 2)
      AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = oe.user_id)
  `).bind(windowStart, windowEnd).all();

  for (const row of rows.results || []) {
    try {
      const magicUrl = await createMagicLink(row.id, env);
      await sendEmail(row.id, row.email, 2, magicUrl, env);
    } catch(e) {}
  }
}

// ── Email 3: T+72h, zero sessions ────────────────────

async function sendEmail3Batch(env, now) {
  const windowStart = now - 96 * 3600;
  const windowEnd   = now - 72 * 3600;

  const rows = await env.DB.prepare(`
    SELECT u.id, u.email
    FROM onboarding_emails oe
    JOIN users u ON u.id = oe.user_id
    WHERE oe.step = 1
      AND oe.sent_at >= ? AND oe.sent_at < ?
      AND NOT EXISTS (SELECT 1 FROM onboarding_emails x WHERE x.user_id = oe.user_id AND x.step = 3)
      AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = oe.user_id)
  `).bind(windowStart, windowEnd).all();

  for (const row of rows.results || []) {
    try {
      const magicUrl = await createMagicLink(row.id, env);
      await sendEmail(row.id, row.email, 3, magicUrl, env);
    } catch(e) {}
  }
}

// ── Email 4: T+11d, everyone (two versions) ──────────

async function sendEmail4Batch(env, now) {
  const windowStart = now - 12 * 86400;
  const windowEnd   = now - 11 * 86400;

  const rows = await env.DB.prepare(`
    SELECT u.id, u.email,
           (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS session_count
    FROM onboarding_emails oe
    JOIN users u ON u.id = oe.user_id
    WHERE oe.step = 1
      AND oe.sent_at >= ? AND oe.sent_at < ?
      AND NOT EXISTS (SELECT 1 FROM onboarding_emails x WHERE x.user_id = oe.user_id AND x.step = 4)
  `).bind(windowStart, windowEnd).all();

  for (const row of rows.results || []) {
    try {
      const magicUrl = await createMagicLink(row.id, env);
      const engaged = row.session_count > 0;
      await sendEmail(row.id, row.email, 4, magicUrl, env, { engaged });
    } catch(e) {}
  }
}

// ── Shared email dispatcher ───────────────────────────

async function sendEmail(userId, email, step, magicUrl, env, opts = {}) {
  const billingPortal = 'https://billing.stripe.com/p/login/raxedge';
  let subject, text, html;

  if (step === 2) {
    subject = 'Quick one — did you get logged in okay?';
    text = `Hey,\n\nNoticed you haven't checked out the dashboard yet — just want to make sure everything's working on your end.\n\nHere's the direct link: ${magicUrl}\n\nOnce you're in, look for anything with a green edge % next to it. Those are bets where the model thinks the number is off from what it should be.\n\nIf something's broken or confusing, just hit reply and tell me — I read every one of these.\n\n— Moe, RaxEdge`;
    html = buildHtml({
      title: 'Did you get logged in okay?',
      body: `<p style="${p}">Noticed you haven't checked out the dashboard yet — just want to make sure everything's working on your end.</p>
             <p style="${p}">Once you're in, look for anything with a green edge % next to it. Those are bets where the model thinks the number is off from what it should be.</p>`,
      cta: { url: magicUrl, label: 'Take me to the dashboard' },
      footer: "If something's broken or confusing, just hit reply — I read every one.\n— Moe, RaxEdge"
    });
  } else if (step === 3) {
    subject = 'New +EV bets are live right now';
    text = `Hey,\n\nJust a heads up — there are new bets flagged +EV on the board right now. The list changes constantly as odds move, so today's picks won't be there tomorrow.\n\nOpen your dashboard: ${magicUrl}\n\nIf you're not sure where to start:\n- Green edge % = the bet is priced in your favor\n- Tap any bet to see the Kelly-suggested stake size\n- New bets get added as odds shift throughout the day\n\nThis is the whole point of the Pro plan — worth taking 2 minutes to actually look.\n\n— Moe, RaxEdge`;
    html = buildHtml({
      title: 'New +EV bets are live right now',
      body: `<p style="${p}">There are new bets flagged +EV on the board right now. The list changes constantly as odds move, so today's picks won't be there tomorrow.</p>
             <ul style="color:#b0afc5;font-size:14px;line-height:1.9;margin:0 0 24px;padding-left:20px">
               <li>Green edge % = the bet is priced in your favor</li>
               <li>Tap any bet to see the Kelly-suggested stake size</li>
               <li>New bets get added as odds shift throughout the day</li>
             </ul>`,
      cta: { url: magicUrl, label: "See today's +EV bets" },
      footer: "This is the whole point of the Pro plan — worth taking 2 minutes to actually look.\n— Moe, RaxEdge"
    });
  } else if (step === 4 && !opts.engaged) {
    subject = "Your trial ends in 3 days — haven't seen you yet";
    const portalUrl = `${env.SITE_URL || 'https://raxedge.com'}/api/stripe/portal`;
    text = `Hey,\n\nYour trial wraps up in 3 days and it looks like you haven't had a chance to check out the dashboard yet.\n\nIf you want to see what you're paying for before you're charged, now's the time: ${magicUrl}\n\nIf you meant to cancel or this isn't for you, no hard feelings — you can manage your subscription here: ${portalUrl}\n\nEither way, just wanted to make sure you had the choice with full information.\n\n— Moe, RaxEdge`;
    html = buildHtml({
      title: "Your trial ends in 3 days",
      body: `<p style="${p}">Your trial wraps up in 3 days and it looks like you haven't had a chance to check out the dashboard yet.</p>
             <p style="${p}">If you want to see what you're paying for before you're charged, now's the time.</p>`,
      cta: { url: magicUrl, label: 'Open my dashboard' },
      footer: `No hard feelings if it's not for you — <a href="${portalUrl}" style="color:#7a7990">manage or cancel here</a>.\n— Moe, RaxEdge`
    });
  } else if (step === 4 && opts.engaged) {
    subject = '3 days left on your trial';
    const portalUrl = `${env.SITE_URL || 'https://raxedge.com'}/api/stripe/portal`;
    text = `Hey,\n\nQuick heads up — your trial ends in 3 days. After that you'll move to the paid Pro plan at $4.99/month.\n\nIf RaxEdge has been useful, no action needed — you're all set.\n\nIf you want to manage or cancel, you can do that here: ${portalUrl}\n\n— Moe, RaxEdge`;
    html = buildHtml({
      title: '3 days left on your trial',
      body: `<p style="${p}">Quick heads up — your trial ends in 3 days. After that you'll move to the paid Pro plan at $4.99/month.</p>
             <p style="${p}">If RaxEdge has been useful, no action needed — you're all set.</p>`,
      cta: { url: portalUrl, label: 'Manage subscription' },
      footer: "Thanks for trying it out.\n— Moe, RaxEdge"
    });
  } else {
    return; // unknown step
  }

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: {
      'Authorization': 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Moe at RaxEdge <noreply@raxedge.com>',
      to: email,
      subject,
      text,
      html
    })
  });

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    'INSERT OR IGNORE INTO onboarding_emails (user_id, step, sent_at) VALUES (?,?,?)'
  ).bind(userId, step, now).run();
}

// ── Email HTML builder ────────────────────────────────

const p = 'color:#b0afc5;font-size:14px;line-height:1.7;margin:0 0 16px';

function buildHtml({ title, body, cta, footer }) {
  return `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 24px;background:#0a0a0c;color:#f0eff5;border-radius:12px">
    <div style="font-size:20px;font-weight:700;margin-bottom:4px">RaxEdge</div>
    <div style="font-size:13px;color:#7a7990;margin-bottom:28px">Pro Trial</div>
    <div style="font-size:18px;font-weight:600;margin-bottom:18px">${title}</div>
    ${body}
    <a href="${cta.url}" style="display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;padding:13px 32px;border-radius:7px;font-weight:600;font-size:15px;margin-bottom:28px">${cta.label}</a>
    <p style="color:#4a4960;font-size:13px;margin:0;white-space:pre-line">${footer}</p>
  </div>`;
}

// ── Magic link helper ─────────────────────────────────

function hexRandom(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

async function createMagicLink(userId, env) {
  const token = hexRandom(32);
  const expires = Math.floor(Date.now() / 1000) + 48 * 3600;
  await env.DB.prepare(
    'INSERT OR REPLACE INTO magic_tokens (token, user_id, expires_at) VALUES (?,?,?)'
  ).bind(token, userId, expires).run();
  const base = (env.SITE_URL || 'https://raxedge.com');
  return base + '/api/auth/magic?token=' + token;
}
