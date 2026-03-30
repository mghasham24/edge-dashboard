// functions/api/referral/stats.js
export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');

  const user = await env.DB.prepare(
    'SELECT id, plan, referral_code, pro_expires_at FROM users WHERE id=?'
  ).bind(session.user_id).first();

  if (!user) return fail(404, 'User not found');

  // Count paid referrals — users referred by this user who are on pro plan
  const paidRow = await env.DB.prepare(
    'SELECT COUNT(*) as c FROM referrals r JOIN users u ON u.id=r.referred_id WHERE r.referrer_id=? AND u.plan=\'pro\''
  ).bind(user.id).first();

  const paidReferrals = paidRow ? paidRow.c : 0;

  return new Response(JSON.stringify({
    ok: true,
    referralCode: user.referral_code,
    plan: user.plan,
    proExpiresAt: user.pro_expires_at || null,
    paidReferrals
  }), { headers: { 'Content-Type': 'application/json' } });
}

async function getSession(request, db) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return null;
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    'SELECT u.id as user_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(m[1], now).first();
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
