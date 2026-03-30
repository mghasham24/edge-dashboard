// functions/api/admin/backfill-pro-expiry.js
// One-time endpoint to backfill pro_expires_at from Stripe for all active subscribers
export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');
  if (!session.is_admin) return fail(403, 'Forbidden');

  if (!env.STRIPE_SECRET_KEY) return fail(500, 'Missing Stripe key');

  // Fetch all active subscriptions from Stripe (paginated)
  let updated = 0;
  let errors = [];
  let startingAfter = null;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({ limit: '100', status: 'active' });
    if (startingAfter) params.set('starting_after', startingAfter);

    const res = await fetch('https://api.stripe.com/v1/subscriptions?' + params.toString(), {
      headers: { 'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY }
    });
    const data = await res.json();
    if (!res.ok) return fail(500, 'Stripe error: ' + (data.error?.message || 'unknown'));

    for (const sub of (data.data || [])) {
      const customerId = sub.customer;
      const periodEnd = sub.current_period_end;
      if (!customerId || !periodEnd) continue;

      try {
        const result = await env.DB.prepare(
          'UPDATE users SET pro_expires_at=? WHERE stripe_customer_id=? AND plan=\'pro\''
        ).bind(periodEnd, customerId).run();
        if (result.meta.changes > 0) updated++;
      } catch(e) {
        errors.push(customerId + ': ' + e.message);
      }
    }

    hasMore = data.has_more;
    if (hasMore && data.data.length > 0) {
      startingAfter = data.data[data.data.length - 1].id;
    } else {
      hasMore = false;
    }
  }

  return new Response(JSON.stringify({ ok: true, updated, errors }), {
    headers: { 'Content-Type': 'application/json' }
  });
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
