import { getSession } from '../../_lib/session.js';
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

  // Only count rows where the reward has actually fired (rewarded_at set).
  // Trialing users have plan='pro' immediately, so counting by plan would show false positives.
  const paidRow = await env.DB.prepare(
    'SELECT COUNT(*) as c, COALESCE(SUM(months_earned), 0) as m FROM referrals WHERE referrer_id=? AND rewarded_at IS NOT NULL'
  ).bind(user.id).first();

  const paidReferrals = paidRow ? paidRow.c : 0;
  const monthsEarned  = paidRow ? paidRow.m : 0;

  return new Response(JSON.stringify({
    ok: true,
    referralCode: user.referral_code,
    plan: user.plan,
    proExpiresAt: user.pro_expires_at || null,
    paidReferrals,
    monthsEarned,
  }), { headers: { 'Content-Type': 'application/json' } });
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
