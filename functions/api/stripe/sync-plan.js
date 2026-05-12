import { getSession } from '../../_lib/session.js';
// functions/api/stripe/sync-plan.js
// Called by the frontend after returning from Stripe checkout.
// Reads subscription status directly from Stripe (authoritative, no D1 lag),
// then force-writes plan='pro' to D1 so subsequent /api/auth/me reads see it.

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return json({ plan: 'free' });
  if (!session.stripe_customer_id) return json({ plan: session.plan });

  const auth = { 'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY };
  const customerId = session.stripe_customer_id;

  try {
    const [trialRes, activeRes] = await Promise.all([
      fetch('https://api.stripe.com/v1/subscriptions?customer=' + customerId + '&status=trialing&limit=1', { headers: auth }),
      fetch('https://api.stripe.com/v1/subscriptions?customer=' + customerId + '&status=active&limit=1',   { headers: auth })
    ]);

    const [trialData, activeData] = await Promise.all([trialRes.json(), activeRes.json()]);
    const sub = (trialData.data && trialData.data[0]) || (activeData.data && activeData.data[0]);

    if (sub) {
      const proExpiresAt = sub.current_period_end || null;
      await env.DB.prepare(
        'UPDATE users SET plan=\'pro\', stripe_sub_id=?, pro_expires_at=?, had_free_trial=1 WHERE id=?'
      ).bind(sub.id, proExpiresAt, session.user_id).run();
      return json({ plan: 'pro' });
    }
  } catch(e) {}

  return json({ plan: session.plan });
}

function json(obj) {
  return new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });
}
