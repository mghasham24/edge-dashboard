import { getSession } from '../../_lib/session.js';
// functions/api/alerts/connect.js
// POST → generates a one-time verification token and returns a Telegram deep link
// DELETE → disconnects Telegram from this account

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

function randomToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequest({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');
  if (session.plan !== 'pro' && !session.is_admin) return fail(403, 'Pro plan required');

  // DELETE — disconnect Telegram
  if (request.method === 'DELETE') {
    await env.DB.prepare(
      'UPDATE notification_settings SET telegram_chat_id=NULL, telegram_verified=0, enabled=0 WHERE user_id=?'
    ).bind(session.user_id).run();
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (request.method !== 'POST') return fail(405, 'Method not allowed');

  if (!env.TELEGRAM_BOT_USERNAME) return fail(500, 'TELEGRAM_BOT_USERNAME not configured');

  const token    = randomToken();
  const now      = Math.floor(Date.now() / 1000);
  const expiresAt = now + 600; // 10 minutes

  // Clean up old tokens for this user, store new one
  await env.DB.prepare('DELETE FROM telegram_verify_tokens WHERE user_id=?').bind(session.user_id).run();
  await env.DB.prepare(
    'INSERT INTO telegram_verify_tokens (token, user_id, expires_at) VALUES (?,?,?)'
  ).bind(token, session.user_id, expiresAt).run();

  const deepLink = `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=${token}`;

  return new Response(JSON.stringify({ ok: true, deepLink, expiresIn: 600 }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
