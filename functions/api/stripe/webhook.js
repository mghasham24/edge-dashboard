// functions/api/stripe/webhook.js

// ── Stripe signature verification (Web Crypto) ────────
async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) return false;

  const parts = sigHeader.split(',');
  const tPart = parts.find(p => p.startsWith('t='));
  const vParts = parts.filter(p => p.startsWith('v1='));
  if (!tPart || !vParts.length) return false;

  const timestamp = tPart.slice(2);
  const signatures = vParts.map(p => p.slice(3));

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;

  const signedPayload = timestamp + '.' + payload;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload));
  const expected = Array.from(new Uint8Array(mac))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return signatures.some(sig => sig === expected);
}

// ── Handler ───────────────────────────────────────────
export async function onRequestPost({ request, env }) {
  const rawBody = await request.text();
  const sigHeader = request.headers.get('Stripe-Signature') || '';

  const valid = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return new Response('Unauthorized', { status: 401 });

  let event;
  try { event = JSON.parse(rawBody); }
  catch { return new Response('Bad JSON', { status: 400 }); }

  const obj = event.data.object;

  switch (event.type) {
    case 'customer.subscription.created': {
      const status = obj.status;
      const plan   = (status === 'active' || status === 'trialing') ? 'pro' : 'free';
      const proExpiresAt = (plan === 'pro' && obj.current_period_end) ? obj.current_period_end : null;
      await env.DB.prepare(
        'UPDATE users SET plan=?, stripe_sub_id=?, pro_expires_at=? WHERE stripe_customer_id=?'
      ).bind(plan, obj.id, proExpiresAt, obj.customer).run();

      if (status === 'trialing') {
        // Mark trial used — fingerprint abuse check happens in checkout.session.completed
        await env.DB.prepare(
          'UPDATE users SET had_free_trial=1 WHERE stripe_customer_id=?'
        ).bind(obj.customer).run();
      }
      break;
    }

    case 'customer.subscription.updated': {
      const status = obj.status;
      const plan   = (status === 'active' || status === 'trialing') ? 'pro' : 'free';
      const proExpiresAt = (plan === 'pro' && obj.current_period_end) ? obj.current_period_end : null;
      await env.DB.prepare(
        'UPDATE users SET plan=?, stripe_sub_id=?, pro_expires_at=? WHERE stripe_customer_id=?'
      ).bind(plan, obj.id, proExpiresAt, obj.customer).run();

      // Trial converted to paid — reward referrer now (not at trial start)
      const prevAttrs = event.data.previous_attributes || {};
      if (prevAttrs.status === 'trialing' && status === 'active') {
        await rewardReferrerForCustomer(obj.customer, obj.metadata, env.DB);
      }
      break;
    }

    case 'customer.subscription.deleted': {
      await env.DB.prepare(
        'UPDATE users SET plan=\'free\', stripe_sub_id=NULL, pro_expires_at=NULL WHERE stripe_customer_id=?'
      ).bind(obj.customer).run();
      break;
    }

    case 'checkout.session.completed': {
      if (obj.mode === 'subscription') {
        const isTrial = obj.payment_status === 'no_payment_required';
        const isPaid  = obj.payment_status === 'paid';

        if (isTrial) {
          // Trial checkout — check card fingerprint for abuse via setup_intent
          const abused = await checkFingerprintFromSetupIntent(obj.setup_intent, obj.customer, env);
          if (abused) {
            // Cancel subscription and drop back to free
            try {
              await fetch('https://api.stripe.com/v1/subscriptions/' + obj.subscription, {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY }
              });
            } catch(e) {}
            await env.DB.prepare(
              'UPDATE users SET plan=\'free\', stripe_sub_id=NULL, pro_expires_at=NULL, had_free_trial=0 WHERE stripe_customer_id=?'
            ).bind(obj.customer).run();
          }
        }

        if (isPaid) {
          // Immediate paid subscription — set pro and reward referrer
          let proExpiresAt = null;
          try {
            const subRes = await fetch('https://api.stripe.com/v1/subscriptions/' + obj.subscription, {
              headers: { 'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY }
            });
            const subData = await subRes.json();
            if (subData.current_period_end) proExpiresAt = subData.current_period_end;
          } catch(e) {}

          await env.DB.prepare(
            'UPDATE users SET plan=\'pro\', stripe_sub_id=?, pro_expires_at=? WHERE stripe_customer_id=?'
          ).bind(obj.subscription, proExpiresAt, obj.customer).run();

          await rewardReferrerForCustomer(obj.customer, obj.metadata, env.DB);
        }
      }
      break;
    }

    case 'invoice.payment_failed': {
      await env.DB.prepare(
        'UPDATE users SET plan=\'free\' WHERE stripe_customer_id=?'
      ).bind(obj.customer).run();
      break;
    }
  }

  return new Response('ok', { status: 200 });
}

// ── Card fingerprint abuse check ──────────────────────
// Fetches the customer's saved card fingerprint from Stripe.
// Tries multiple sources in order of reliability.
// Returns true if this card has already been used for a trial on a different account.
async function checkFingerprintFromSetupIntent(setupIntentId, stripeCustomerId, env) {
  try {
    const fingerprint = await getCardFingerprint(setupIntentId, stripeCustomerId, env.STRIPE_SECRET_KEY);
    if (!fingerprint) return false; // can't determine — allow through

    // Look up user_id for this customer
    const user = await env.DB.prepare(
      'SELECT id FROM users WHERE stripe_customer_id=?'
    ).bind(stripeCustomerId).first();
    const userId = user ? user.id : 0;

    // Check if fingerprint already used for a trial by a different user
    const existing = await env.DB.prepare(
      'SELECT user_id FROM trial_fingerprints WHERE fingerprint=?'
    ).bind(fingerprint).first();

    if (existing && existing.user_id !== userId) {
      // Same card, different account — abuse
      return true;
    }

    if (!existing) {
      // First time — store it
      await env.DB.prepare(
        'INSERT OR IGNORE INTO trial_fingerprints (fingerprint, user_id, created_at) VALUES (?,?,?)'
      ).bind(fingerprint, userId, Math.floor(Date.now() / 1000)).run();
    }

    return false;
  } catch(e) {
    return false; // don't block on errors
  }
}

async function getCardFingerprint(setupIntentId, stripeCustomerId, secretKey) {
  const authHeader = { 'Authorization': 'Bearer ' + secretKey };

  // Source 1: customer's payment methods list (most reliable post-checkout)
  try {
    const pmListRes = await fetch(
      'https://api.stripe.com/v1/customers/' + stripeCustomerId + '/payment_methods?type=card&limit=1',
      { headers: authHeader }
    );
    const pmList = await pmListRes.json();
    const pm = pmList.data && pmList.data[0];
    if (pm && pm.card && pm.card.fingerprint) return pm.card.fingerprint;
  } catch(e) {}

  // Source 2: setup_intent → payment_method
  if (setupIntentId) {
    try {
      const siRes = await fetch('https://api.stripe.com/v1/setup_intents/' + setupIntentId, {
        headers: authHeader
      });
      const si = await siRes.json();
      if (si.payment_method) {
        const pmRes = await fetch('https://api.stripe.com/v1/payment_methods/' + si.payment_method, {
          headers: authHeader
        });
        const pm = await pmRes.json();
        if (pm.card && pm.card.fingerprint) return pm.card.fingerprint;
      }
    } catch(e) {}
  }

  return null;
}

// ── Reward referrer helper ────────────────────────────
async function rewardReferrerForCustomer(stripeCustomerId, metadata, db) {
  try {
    const newPro = await db.prepare(
      'SELECT id, referred_by FROM users WHERE stripe_customer_id=?'
    ).bind(stripeCustomerId).first();
    if (!newPro) return;

    const referrerIdFromMeta = metadata && metadata.referrer_id
      ? parseInt(metadata.referrer_id, 10) : null;
    const referrerId = referrerIdFromMeta || newPro.referred_by || null;
    if (!referrerId) return;

    const referrer = await db.prepare(
      'SELECT id, plan, pro_expires_at FROM users WHERE id=?'
    ).bind(referrerId).first();
    if (!referrer) return;

    const now = Math.floor(Date.now() / 1000);
    const base = (referrer.pro_expires_at && referrer.pro_expires_at > now)
      ? referrer.pro_expires_at : now;
    const newExpiry = base + 2592000; // +30 days
    await db.prepare(
      'UPDATE users SET plan=\'pro\', pro_expires_at=? WHERE id=?'
    ).bind(newExpiry, referrer.id).run();
  } catch(e) {}
}
