// functions/api/referral/stats.js
export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');

  // Get user's referral code, create one if doesn't exist
  let user = await env.DB.prepare(
    'SELECT id, email, referral_code, plan, pro_expires_at FROM users WHERE id=?'
  ).bind(session.user_id).first();

  if (!user.referral_code) {
    const code = generateCode(user.email);
    await env.DB.prepare('UPDATE users SET referral_code=? WHERE id=?').bind(code, user.id).run();
    user.referral_code = code;
  }

  // Count referrals
  const refCount = await env.DB.prepare(
    'SELECT COUNT(*) as c FROM referrals WHERE referrer_id=?'
  ).bind(user.id).first();

  const count = refCount ? refCount.c : 0;
  const nextReward = 5;
  const progress = count % nextReward;
  const rewards = Math.floor(count / nextReward);

  return new Response(JSON.stringify({
    ok: true,
    code: user.referral_code,
    count,
    progress,
    nextReward,
    rewards,
    plan: user.plan,
    proExpiresAt: user.pro_expires_at
  }), { headers: { 'Content-Type': 'application/json' } });
}

function generateCode(email) {
  const prefix = email.split('@')[0].replace(/[^a-zA-Z0-9]/g,'').toUpperCase().slice(0, 6);
  const suffix = Math.floor(1000 + Math.random() * 9000);
  return prefix + suffix;
}

async function getSession(request, db) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return null;
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    'SELECT u.id as user_id, u.plan FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(m[1], now).first();
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
