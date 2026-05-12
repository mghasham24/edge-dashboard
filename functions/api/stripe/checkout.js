import { getSession } from '../../_lib/session.js';
import { stripeGet, stripePost } from '../../_lib/stripe.js';
// functions/api/stripe/checkout.js
const TRIAL_DAYS = 14;

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');
  if (session.plan === 'pro') return fail(400, 'Already on Pro plan');

  const origin = new URL(request.url).origin;

  // Read optional referral code and billing period from request body
  let referrerId = null;
  let isAnnual = false;
  try {
    const body = await request.json().catch(() => ({}));
    const code = (body.referral_code || '').trim().toUpperCase();
    if (code) {
      const referrer = await env.DB.prepare(
        'SELECT id FROM users WHERE referral_code=? AND id!=?'
      ).bind(code, session.user_id).first();
      if (referrer) referrerId = referrer.id;
    }
    isAnnual = body.billing === 'annual';
  } catch {}

  // Create or retrieve Stripe customer
  let customerId = session.stripe_customer_id;
  if (!customerId) {
    // Before creating, search Stripe for an existing customer with this email
    // to prevent duplicate customers on retry (e.g. if DB write failed last time).
    // Fetch up to 10 — prefer the one whose metadata.user_id matches this session
    // to avoid picking an orphaned record belonging to a different user.
    const existingList = await stripeGet(
      'customers?email=' + encodeURIComponent(session.email) + '&limit=10',
      env.STRIPE_SECRET_KEY
    );
    if (existingList.data && existingList.data.length > 0) {
      const matched = existingList.data.find(
        c => c.metadata && String(c.metadata.user_id) === String(session.user_id)
      );
      if (matched) {
        customerId = matched.id;
        // Ensure metadata is stamped (may be missing on older customers)
        await stripePost('customers/' + customerId, {
          metadata: { user_id: String(session.user_id) }
        }, env.STRIPE_SECRET_KEY);
      } else {
        // Email exists in Stripe but belongs to a different user — create fresh
        const customer = await stripePost('customers', {
          email: session.email,
          metadata: { user_id: String(session.user_id) }
        }, env.STRIPE_SECRET_KEY);
        if (customer.error) return fail(500, 'Failed to create customer');
        customerId = customer.id;
      }
    } else {
      const customer = await stripePost('customers', {
        email: session.email,
        metadata: { user_id: String(session.user_id) }
      }, env.STRIPE_SECRET_KEY);
      if (customer.error) return fail(500, 'Failed to create customer');
      customerId = customer.id;
    }
    await env.DB.prepare('UPDATE users SET stripe_customer_id=? WHERE id=?')
      .bind(customerId, session.user_id).run();
  }

  // Block if customer already has an active or trialing subscription
  if (customerId) {
    const subList = await stripeGet(
      'subscriptions?customer=' + customerId + '&status=active&limit=1',
      env.STRIPE_SECRET_KEY
    );
    if (subList.data && subList.data.length > 0) {
      return fail(400, 'Already has an active subscription');
    }
    const trialList = await stripeGet(
      'subscriptions?customer=' + customerId + '&status=trialing&limit=1',
      env.STRIPE_SECRET_KEY
    );
    if (trialList.data && trialList.data.length > 0) {
      return fail(400, 'Already has an active trial');
    }
  }

  const trialEligible = !isAnnual && !session.had_free_trial;

  // Annual requires a separate Stripe price — fall back to monthly if not configured
  const priceId = (isAnnual && env.STRIPE_ANNUAL_PRICE_ID)
    ? env.STRIPE_ANNUAL_PRICE_ID
    : env.STRIPE_PRICE_ID;
  if (isAnnual && !env.STRIPE_ANNUAL_PRICE_ID) {
    return fail(500, 'Annual plan not yet configured');
  }

  // Build Checkout session params
  const checkoutParams = {
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: origin + '/?checkout=success',
    cancel_url:  origin + '/?checkout=cancel',
    allow_promotion_codes: true,
  };

  if (trialEligible) {
    // Free trial: 14-day trial, then monthly recurring
    // Store referrer_id in subscription metadata so webhook can reward on trial→paid conversion
    checkoutParams.subscription_data = {
      trial_period_days: TRIAL_DAYS,
      metadata: referrerId ? { referrer_id: String(referrerId) } : {}
    };
  } else {
    // No trial — immediate payment (annual or already-trialed monthly)
    // Store referrer in subscription metadata for webhook
    if (referrerId) checkoutParams.subscription_data = { metadata: { referrer_id: String(referrerId) } };
  }

  const checkout = await stripePost('checkout/sessions', checkoutParams, env.STRIPE_SECRET_KEY);
  if (checkout.error) return fail(500, 'Failed to create checkout session: ' + (checkout.error.message || JSON.stringify(checkout.error)));

  return new Response(JSON.stringify({ ok: true, url: checkout.url, trial: trialEligible }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
