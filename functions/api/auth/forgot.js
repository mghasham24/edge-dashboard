// functions/api/auth/forgot.js
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return ok(); }

  const email = (body.email || '').trim().toLowerCase();
  if (!email) return ok();

  const user = await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
  if (!user) return ok(); // Silent - don't reveal if email exists

  // Generate reset token (expires in 1 hour)
  const token   = genToken();
  const expires = Math.floor(Date.now() / 1000) + 3600;

  await env.DB.prepare(
    'INSERT INTO password_resets (user_id, token, expires_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET token=excluded.token, expires_at=excluded.expires_at'
  ).bind(user.id, token, expires).run();

  const resetUrl = 'https://raxedge.com/reset?token=' + token;

  // Send email via Resend
  if (env.RESEND_API_KEY) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'RaxEdge <noreply@raxedge.com>',
        to: email,
        subject: 'Reset your RaxEdge password',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 24px;background:#0a0a0c;color:#f0eff5;border-radius:12px">
            <div style="font-size:20px;font-weight:700;margin-bottom:8px">RaxEdge</div>
            <div style="font-size:15px;color:#7a7990;margin-bottom:32px">Rax Prediction Edge Calculator</div>
            <div style="font-size:16px;margin-bottom:16px">Reset your password</div>
            <p style="color:#7a7990;font-size:14px;line-height:1.6">Click the button below to reset your password. This link expires in 1 hour.</p>
            <a href="${resetUrl}" style="display:inline-block;margin:24px 0;background:#4f6ef7;color:#fff;text-decoration:none;padding:12px 28px;border-radius:7px;font-weight:600;font-size:14px">Reset Password</a>
            <p style="color:#4a4960;font-size:12px">If you didn't request this, you can safely ignore this email.</p>
          </div>
        `
      })
    }).catch(() => {});
  }

  return ok();
}

function genToken() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join('');
}

function ok() {
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}
