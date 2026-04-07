// functions/api/auth/me.js
export async function onRequestGet({ request, env }) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return fail();

  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    'SELECT u.email, u.plan, u.is_admin, u.referral_code FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(m[1], now).first();

  if (!row) return fail();
  return new Response(JSON.stringify({ ok: true, email: row.email, plan: row.plan, is_admin: row.is_admin || 0, referral_code: row.referral_code || '' }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

function fail() {
  return new Response(JSON.stringify({ error: 'Not authenticated' }), {
    status: 401, headers: { 'Content-Type': 'application/json' }
  });
}
