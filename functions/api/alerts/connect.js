import { getSession } from '../../_lib/session.js';
// functions/api/alerts/connect.js
// POST → generates a one-time 6-char verification code; user DMs /connect <code> to the bot
// DELETE → disconnects Discord from this account

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (const b of bytes) code += chars[b % chars.length];
  return code;
}

export async function onRequest({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');
  if (session.plan !== 'pro' && !session.is_admin) return fail(403, 'Pro plan required');

  // DELETE — disconnect Discord
  if (request.method === 'DELETE') {
    await env.DB.prepare(
      'UPDATE notification_settings SET discord_user_id=NULL, discord_dm_channel_id=NULL, discord_verified=0, enabled=0 WHERE user_id=?'
    ).bind(session.user_id).run();
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (request.method !== 'POST') return fail(405, 'Method not allowed');

  const code      = randomCode();
  const now       = Math.floor(Date.now() / 1000);
  const expiresAt = now + 600; // 10 minutes

  await env.DB.prepare('DELETE FROM discord_verify_tokens WHERE user_id=?').bind(session.user_id).run();
  await env.DB.prepare(
    'INSERT INTO discord_verify_tokens (token, user_id, expires_at) VALUES (?,?,?)'
  ).bind(code, session.user_id, expiresAt).run();

  const botName = env.DISCORD_BOT_USERNAME || 'RaxEdgeBot';

  return new Response(JSON.stringify({ ok: true, code, botName, expiresIn: 600 }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
