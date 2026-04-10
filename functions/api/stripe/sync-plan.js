// functions/api/stripe/sync-plan.js
// Called by the frontend after returning from Stripe checkout.
// Reads subscription status directly from Stripe (authoritative, no D1 lag),
// then force-writes plan='pro' to D1 so subsequent /api/auth/me reads see it.

export async function onRequestGet({ request, env }) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return json({ plan: 'free' });

  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    'SELECT u.id, u.plan, u.stripe_customer_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(m[1], now).first();

  if (!row) return json({ plan: 'free' });
  if (!row.stripe_customer_id) return json({ plan: row.plan });

  // Query Stripe directly — bypasses D1 replica lag entirely.
  const auth = { 'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY };
  const customerId = row.stripe_customer_id;

  try {
    // Check trialing first (most common post-checkout state)
    const [trialRes, activeRes] = await Promise.all([
      fetch('https://api.stripe.com/v1/subscriptions?customer=' + customerId + '&status=trialing&limit=1', { headers: auth }),
      fetch('https://api.stripe.com/v1/subscriptions?customer=' + customerId + '&status=active&limit=1',   { headers: auth })
    ]);

    const [trialData, activeData] = await Promise.all([trialRes.json(), activeRes.json()]);
    const sub = (trialData.data && trialData.data[0]) || (activeData.data && activeData.data[0]);

    if (sub) {
      // Subscription is valid in Stripe — force-write pro to D1 primary so replicas catch up.
      const proExpiresAt = sub.current_period_end || null;
      await env.DB.prepare(
        'UPDATE users SET plan=\'pro\', stripe_sub_id=?, pro_expires_at=?, had_free_trial=1 WHERE id=?'
      ).bind(sub.id, proExpiresAt, row.id).run();
      return json({ plan: 'pro' });
    }
  } catch(e) {}

  // No active subscription in Stripe — return whatever D1 currently has.
  return json({ plan: row.plan });
}

function json(obj) {
  return new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });
}
