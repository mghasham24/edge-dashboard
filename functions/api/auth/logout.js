// functions/api/auth/logout.js
export async function onRequestPost({ request, env }) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  if (m) await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(m[1]).run();
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': 'session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
    }
  });
}
