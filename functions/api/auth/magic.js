// functions/api/auth/magic.js
// Exchanges a one-time magic token (from onboarding emails) for a live session.
// The token is created in webhook.js when Email 1 fires, and in onboarding-cron
// for emails 2–4. Each token is single-use with a 48h TTL.

const SESSION_DAYS = 30;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';

  if (!token) return redirect('/');

  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    'SELECT user_id, expires_at FROM magic_tokens WHERE token=?'
  ).bind(token).first();

  if (!row || row.expires_at < now) return redirect('/');

  // Single-use — delete before creating session to prevent replay
  await env.DB.prepare('DELETE FROM magic_tokens WHERE token=?').bind(token).run();

  const sessionToken = hexRandom(32);
  const exp = now + SESSION_DAYS * 86400;
  await env.DB.prepare(
    'INSERT INTO sessions (user_id, token, expires_at) VALUES (?,?,?)'
  ).bind(row.user_id, sessionToken, exp).run();

  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': `session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`
    }
  });
}

function redirect(path) {
  return new Response(null, { status: 302, headers: { 'Location': path } });
}

function hexRandom(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}
