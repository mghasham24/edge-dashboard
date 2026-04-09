// functions/api/stripe/checkout.js
const TRIAL_DAYS = 14;

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');
  if (session.plan === 'pro') return fail(400, 'Already on Pro plan');

  const origin = new URL(request.url).origin;

  // Read optional referral code from request body
  let referrerId = null;
  try {
    const body = await request.json().catch(() => ({}));
    const code = (body.referral_code || '').trim().toUpperCase();
    if (code) {
      const referrer = await env.DB.prepare(
        'SELECT id FROM users WHERE referral_code=? AND id!=?'
      ).bind(code, session.id).first();
      if (referrer) referrerId = referrer.id;
    }
  } catch {}

  // Create or retrieve Stripe customer
  let customerId = session.stripe_customer_id;
  if (!customerId) {
    const customer = await stripePost('customers', {
      email: session.email,
      metadata: { user_id: String(session.id) }
    }, env.STRIPE_SECRET_KEY);
    if (customer.error) return fail(500, 'Failed to create customer');
    customerId = customer.id;
    await env.DB.prepare('UPDATE users SET stripe_customer_id=? WHERE id=?')
      .bind(customerId, session.id).run();
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

  const trialEligible = !session.had_free_trial;

  // Build Checkout session params
  const checkoutParams = {
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
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
    // No trial — immediate payment, store referrer in checkout metadata for webhook
    if (referrerId) checkoutParams.metadata = { referrer_id: String(referrerId) };
  }

  const checkout = await stripePost('checkout/sessions', checkoutParams, env.STRIPE_SECRET_KEY);
  if (checkout.error) return fail(500, 'Failed to create checkout session: ' + (checkout.error.message || JSON.stringify(checkout.error)));

  return new Response(JSON.stringify({ ok: true, url: checkout.url, trial: trialEligible }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// ── Stripe API helpers ────────────────────────────────
async function stripeGet(endpoint, secretKey) {
  const res = await fetch('https://api.stripe.com/v1/' + endpoint, {
    headers: { 'Authorization': 'Bearer ' + secretKey }
  });
  return res.json();
}

async function stripePost(endpoint, params, secretKey) {
  const body = Object.entries(flattenParams(params))
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');
  const res = await fetch('https://api.stripe.com/v1/' + endpoint, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + secretKey,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body
  });
  return res.json();
}

function flattenParams(obj, prefix) {
  return Object.entries(obj).reduce((acc, [k, v]) => {
    const key = prefix ? prefix + '[' + k + ']' : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(acc, flattenParams(v, key));
    } else if (Array.isArray(v)) {
      v.forEach(function(item, i) {
        if (typeof item === 'object') {
          Object.assign(acc, flattenParams(item, key + '[' + i + ']'));
        } else {
          acc[key + '[' + i + ']'] = item;
        }
      });
    } else {
      acc[key] = v;
    }
    return acc;
  }, {});
}

async function getSession(request, db) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return null;
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    'SELECT u.id, u.email, u.plan, u.stripe_customer_id, u.had_free_trial FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(m[1], now).first();
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
