// functions/api/stripe/upgrade.js
// Upgrades a monthly pro subscription to annual immediately with proration.
// Charges the prorated difference today; next billing is $39/yr from today.
import { getSessionOrCron } from '../../_lib/auth.js';
import { stripeGet, stripePost } from '../../_lib/stripe.js';

export async function onRequestPost({ request, env }) {
  const auth = await getSessionOrCron(request, env);
  if (!auth) return fail(401, 'Not authenticated');
  if (auth.plan !== 'pro' && !auth.is_admin) return fail(403, 'Pro plan required');

  const row = await env.DB.prepare(
    'SELECT stripe_sub_id FROM users WHERE id=?'
  ).bind(auth.user_id).first();

  if (!row?.stripe_sub_id) return fail(400, 'No active subscription');

  const sub = await stripeGet(
    'subscriptions/' + row.stripe_sub_id + '?expand[]=items.data.price',
    env.STRIPE_SECRET_KEY
  );
  if (sub.error || !sub.id) return fail(400, 'Subscription not found');
  if (sub.status === 'canceled') return fail(400, 'Subscription is cancelled');

  const item = (sub.items?.data || [])[0];
  if (!item) return fail(400, 'No subscription item');

  if (item.price?.recurring?.interval === 'year') {
    return fail(400, 'Already on annual plan');
  }

  const annualPriceId = env.STRIPE_ANNUAL_PRICE_ID;
  if (!annualPriceId) return fail(500, 'Annual price not configured');

  const updated = await stripePost(
    'subscriptions/' + row.stripe_sub_id,
    {
      items: [{ id: item.id, price: annualPriceId }],
      proration_behavior: 'always_invoice',
      billing_cycle_anchor: 'now',
    },
    env.STRIPE_SECRET_KEY
  );

  if (updated.error) return fail(500, updated.error.message || 'Upgrade failed');

  const proExpiresAt = updated.current_period_end || null;
  await env.DB.prepare(
    "UPDATE users SET pro_expires_at=?, billing_interval='annual' WHERE id=?"
  ).bind(proExpiresAt, auth.user_id).run();

  return new Response(JSON.stringify({ ok: true, proExpiresAt }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
