// functions/api/referral/stats.js
export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');

  let user = await env.DB.prepare(
    'SELECT id, plan, referral_code, pro_expires_at FROM users WHERE id=?'
  ).bind(session.user_id).first();

  if (!user) return fail(404, 'User not found');

  // Auto-generate random 5-char alphanumeric code if missing
  if (!user.referral_code) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing chars like 0/O, 1/I
    let code;
    // Retry until unique
    for (let attempt = 0; attempt < 10; attempt++) {
      code = Array.from(crypto.getRandomValues(new Uint8Array(5)))
        .map(b => chars[b % chars.length]).join('');
      const existing = await env.DB.prepare('SELECT id FROM users WHERE referral_code=?').bind(code).first();
      if (!existing) break;
    }
    await env.DB.prepare('UPDATE users SET referral_code=? WHERE id=?').bind(code, user.id).run();
    user = { ...user, referral_code: code };
  }

  // Count paid referrals — users referred by this user who are on pro plan
  const paidRow = await env.DB.prepare(
    "SELECT COUNT(*) as c FROM referrals r JOIN users u ON u.id=r.referred_id WHERE r.referrer_id=? AND u.plan='pro'"
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
