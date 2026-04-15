// functions/api/admin/sync-stripe.js
// One-time fix: sync all Stripe subscription statuses → D1
// Fetches active, trialing, past_due, and cancelled subs and corrects plan in DB.
export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');
  if (!session.is_admin) return fail(403, 'Forbidden');
  if (!env.STRIPE_SECRET_KEY) return fail(500, 'Missing Stripe key');

  const auth = { 'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY };
  const report = { upgraded: [], downgraded: [], unchanged: [], errors: [] };

  // Fetch all subs for these statuses and apply the right plan
  const statusMap = {
    active:   'pro',
    trialing: 'pro',
    past_due: 'free',
    canceled: 'free',
    unpaid:   'free',
    paused:   'free'
  };

  for (const [status, plan] of Object.entries(statusMap)) {
    let startingAfter = null;
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams({ limit: '100', status });
      if (startingAfter) params.set('starting_after', startingAfter);

      const res = await fetch('https://api.stripe.com/v1/subscriptions?' + params, { headers: auth });
      const data = await res.json();
      if (!res.ok) { report.errors.push('Stripe list error (' + status + '): ' + (data.error?.message || 'unknown')); break; }

      for (const sub of (data.data || [])) {
        const customerId = sub.customer;
        if (!customerId) continue;

        try {
          const user = await env.DB.prepare(
            'SELECT id, plan, stripe_sub_id FROM users WHERE stripe_customer_id=?'
          ).bind(customerId).first();

          if (!user) continue;

          const proExpiresAt = (plan === 'pro' && sub.current_period_end) ? sub.current_period_end : null;

          if (user.plan !== plan) {
            await env.DB.prepare(
              'UPDATE users SET plan=?, stripe_sub_id=?, pro_expires_at=? WHERE id=?'
            ).bind(plan, sub.id, proExpiresAt, user.id).run();

            if (plan === 'pro') {
              report.upgraded.push({ customerId, userId: user.id, from: user.plan, status });
            } else {
              report.downgraded.push({ customerId, userId: user.id, from: user.plan, status });
            }
          } else {
            // Plan matches — still update pro_expires_at in case it drifted
            if (plan === 'pro') {
              await env.DB.prepare(
                'UPDATE users SET stripe_sub_id=?, pro_expires_at=? WHERE id=?'
              ).bind(sub.id, proExpiresAt, user.id).run();
            }
            report.unchanged.push({ customerId, plan, status });
          }
        } catch(e) {
          report.errors.push(customerId + ': ' + e.message);
        }
      }

      hasMore = data.has_more;
      startingAfter = hasMore ? data.data[data.data.length - 1].id : null;
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    upgraded: report.upgraded.length,
    downgraded: report.downgraded.length,
    unchanged: report.unchanged.length,
    errors: report.errors.length,
    detail: report
  }), { headers: { 'Content-Type': 'application/json' } });
}

async function getSession(request, db) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return null;
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    'SELECT u.id as user_id, u.is_admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(m[1], now).first();
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
