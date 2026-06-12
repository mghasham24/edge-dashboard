// functions/api/stripe/upgrade-preview.js
// Returns the exact prorated charge if a monthly pro user upgrades to annual right now.
// Used by the frontend confirmation modal before committing the upgrade.
import { getSessionOrCron } from '../../_lib/auth.js';
import { stripeGet, stripePost } from '../../_lib/stripe.js';

export async function onRequestGet({ request, env }) {
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
    return fail(400, 'already_annual');
  }

  const annualPriceId = env.STRIPE_ANNUAL_PRICE_ID;
  if (!annualPriceId) return fail(500, 'Annual price not configured');

  // Trialing users haven't been charged yet — no proration possible.
  // They pay the full annual price immediately when upgrading.
  if (sub.status === 'trialing') {
    const annualPrice = await stripeGet('prices/' + annualPriceId, env.STRIPE_SECRET_KEY);
    const amountDue = (annualPrice && annualPrice.unit_amount) ? annualPrice.unit_amount : 3900;
    return new Response(JSON.stringify({
      ok: true,
      amountDue,
      amountDueStr: '$' + (amountDue / 100).toFixed(2),
      itemId: item.id,
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  const preview = await stripePost(
    'invoices/create_preview',
    {
      customer: sub.customer,
      subscription: row.stripe_sub_id,
      subscription_details: {
        items: [{ id: item.id, price: annualPriceId }],
        billing_cycle_anchor: 'now',
        proration_behavior: 'always_invoice',
      },
    },
    env.STRIPE_SECRET_KEY
  );

  if (preview.error) return fail(500, preview.error.message || 'Failed to preview upgrade');

  const amountDue = Math.max(0, preview.amount_due || 0);
  return new Response(JSON.stringify({
    ok: true,
    amountDue,
    amountDueStr: '$' + (amountDue / 100).toFixed(2),
    itemId: item.id,
  }), { headers: { 'Content-Type': 'application/json' } });
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
