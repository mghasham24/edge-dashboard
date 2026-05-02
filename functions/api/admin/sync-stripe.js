// functions/api/admin/sync-stripe.js
// Syncs Stripe subscription statuses → D1.
// Processes active/trialing FIRST (pro), tracks those customers,
// then only processes canceled/past_due for customers with NO active sub.
export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');
  if (!session.is_admin) return fail(403, 'Forbidden');
  if (!env.STRIPE_SECRET_KEY) return fail(500, 'Missing Stripe key');

  const auth = { 'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY };
  const report = { upgraded: [], downgraded: [], unchanged: [], errors: [] };

  // Customers already handled by an active/trialing sub — don't overwrite with a old canceled sub
  const processedCustomers = new Set();

  // ── Pass 1: active + trialing → pro ──────────────────
  for (const status of ['active', 'trialing']) {
    let startingAfter = null;
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams({ limit: '100', status });
      if (startingAfter) params.set('starting_after', startingAfter);

      const res = await fetch('https://api.stripe.com/v1/subscriptions?' + params, { headers: auth });
      const data = await res.json();
      if (!res.ok) { report.errors.push('Stripe error (' + status + '): ' + (data.error?.message || 'unknown')); break; }

      for (const sub of (data.data || [])) {
        const customerId = sub.customer;
        if (!customerId) continue;
        processedCustomers.add(customerId);

        try {
          const user = await env.DB.prepare(
            'SELECT id, email, plan, stripe_sub_id FROM users WHERE stripe_customer_id=?'
          ).bind(customerId).first();
          if (!user) continue;

          const proExpiresAt = sub.current_period_end || null;
          await env.DB.prepare(
            'UPDATE users SET plan=\'pro\', stripe_sub_id=?, pro_expires_at=? WHERE id=?'
          ).bind(sub.id, proExpiresAt, user.id).run();

          if (user.plan !== 'pro') {
            report.upgraded.push({ email: user.email, userId: user.id, from: user.plan, status });
          } else {
            report.unchanged.push({ email: user.email, plan: 'pro', status });
          }
        } catch(e) {
          report.errors.push(customerId + ': ' + e.message);
        }
      }

      hasMore = data.has_more;
      startingAfter = hasMore ? data.data[data.data.length - 1].id : null;
    }
  }

  // ── Pass 2: canceled / past_due / unpaid → free (only if no active sub) ──
  for (const status of ['canceled', 'past_due', 'unpaid', 'paused']) {
    let startingAfter = null;
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams({ limit: '100', status });
      if (startingAfter) params.set('starting_after', startingAfter);

      const res = await fetch('https://api.stripe.com/v1/subscriptions?' + params, { headers: auth });
      const data = await res.json();
      if (!res.ok) { report.errors.push('Stripe error (' + status + '): ' + (data.error?.message || 'unknown')); break; }

      for (const sub of (data.data || [])) {
        const customerId = sub.customer;
        if (!customerId) continue;

        // Skip — this customer has an active/trialing sub that already set them to pro
        if (processedCustomers.has(customerId)) continue;

        try {
          const user = await env.DB.prepare(
            'SELECT id, email, plan FROM users WHERE stripe_customer_id=?'
          ).bind(customerId).first();
          if (!user) continue;

          if (user.plan === 'pro') {
            await env.DB.prepare(
              'UPDATE users SET plan=\'free\', pro_expires_at=NULL WHERE id=?'
            ).bind(user.id).run();
            report.downgraded.push({ email: user.email, userId: user.id, status });
          } else {
            report.unchanged.push({ email: user.email, plan: 'free', status });
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
