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
      if (obj.mode === 'subscription' && obj.subscription) {
        // Fetch the subscription to determine if this is a trial or immediate payment
        let subData = null;
        try {
          const subRes = await fetch('https://api.stripe.com/v1/subscriptions/' + obj.subscription, {
            headers: { 'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY }
          });
          subData = await subRes.json();
        } catch(e) {}

        const subStatus = subData && subData.status;
        const isTrial = subStatus === 'trialing';
        const isPaid  = subStatus === 'active';

        if (isTrial) {
          const pmId = subData.default_payment_method;
          const abused = await checkFingerprintByPmId(pmId, obj.customer, env.DB, env.STRIPE_SECRET_KEY);
          if (abused) {
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
          const proExpiresAt = subData && subData.current_period_end ? subData.current_period_end : null;
          await env.DB.prepare(
            'UPDATE users SET plan=\'pro\', stripe_sub_id=?, pro_expires_at=? WHERE stripe_customer_id=?'
          ).bind(obj.subscription, proExpiresAt, obj.customer).run();
          await rewardReferrerForCustomer(obj.customer, obj.metadata, env.DB);
        }
      }
      break;
    }

    case 'invoice.created': {
      // If this is a subscription renewal invoice with a charge, check referral credits.
      // If the user has credits banked, apply a Stripe customer balance credit equal to
      // the invoice amount so the net charge is $0, then decrement the credit counter.
      if (obj.billing_reason !== 'subscription_cycle' && obj.billing_reason !== 'subscription_create') break;
      if (!obj.customer || !obj.amount_due || obj.amount_due <= 0) break;
      try {
        const user = await env.DB.prepare(
          'SELECT id, referral_credits FROM users WHERE stripe_customer_id=?'
        ).bind(obj.customer).first();
        if (!user || !user.referral_credits || user.referral_credits <= 0) break;

        // Apply a credit to the Stripe customer balance — Stripe auto-applies on finalization
        const creditRes = await fetch(
          'https://api.stripe.com/v1/customers/' + obj.customer + '/balance_transactions',
          {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
              amount: String(-obj.amount_due), // negative = credit
              currency: obj.currency || 'usd',
              description: 'Referral reward — 1 free month'
            }).toString()
          }
        );
        if (!creditRes.ok) break;

        await env.DB.prepare(
          'UPDATE users SET referral_credits = referral_credits - 1 WHERE id=?'
        ).bind(user.id).run();
      } catch(e) {}
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
// Returns true only if this card is actively held by a DIFFERENT user with had_free_trial=1.
// userId is resolved from Stripe customer metadata (not D1) to avoid replication lag.
async function checkFingerprintByPmId(pmId, stripeCustomerId, db, secretKey) {
  try {
    const fingerprint = await resolveFingerprint(pmId, stripeCustomerId, secretKey);
    if (!fingerprint) return false; // can't determine fingerprint — allow through

    // Get userId from Stripe customer metadata — avoids D1 replication lag entirely.
    const auth = { 'Authorization': 'Bearer ' + secretKey };
    const custRes = await fetch('https://api.stripe.com/v1/customers/' + stripeCustomerId, { headers: auth });
    const cust = await custRes.json();
    const userId = cust.metadata && cust.metadata.user_id ? parseInt(cust.metadata.user_id, 10) : 0;
    if (!userId) return false; // can't identify user — allow through

    const existing = await db.prepare(
      'SELECT user_id FROM trial_fingerprints WHERE fingerprint=?'
    ).bind(fingerprint).first();

    if (existing) {
      if (existing.user_id === userId) return false; // same user retrying

      // Different user. Only block if the other account still has had_free_trial=1
      // (their trial is genuinely active). If had_free_trial=0 the entry is stale
      // (cancelled trial or bug victim) — reassign and allow.
      const existingUser = existing.user_id > 0
        ? await db.prepare('SELECT had_free_trial FROM users WHERE id=?')
            .bind(existing.user_id).first()
        : null;

      if (existingUser && existingUser.had_free_trial === 1) return true; // genuine abuse

      // Stale entry — take over and allow.
      await db.prepare(
        'UPDATE trial_fingerprints SET user_id=? WHERE fingerprint=?'
      ).bind(userId, fingerprint).run();
      return false;
    }

    // First time this card is seen — record it.
    await db.prepare(
      'INSERT OR IGNORE INTO trial_fingerprints (fingerprint, user_id, created_at) VALUES (?,?,?)'
    ).bind(fingerprint, userId, Math.floor(Date.now() / 1000)).run();
    return false;
  } catch(e) {
    return false; // on any error, allow through
  }
}

async function resolveFingerprint(pmId, stripeCustomerId, secretKey) {
  const auth = { 'Authorization': 'Bearer ' + secretKey };

  // Source 1: direct payment method lookup (most reliable — subscription.default_payment_method)
  if (pmId && typeof pmId === 'string') {
    try {
      const pmRes = await fetch('https://api.stripe.com/v1/payment_methods/' + pmId, { headers: auth });
      const pm = await pmRes.json();
      if (pm.card && pm.card.fingerprint) return pm.card.fingerprint;
    } catch(e) {}
  }

  // Source 2: customer's payment methods list
  try {
    const listRes = await fetch(
      'https://api.stripe.com/v1/customers/' + stripeCustomerId + '/payment_methods?type=card&limit=1',
      { headers: auth }
    );
    const list = await listRes.json();
    const pm = list.data && list.data[0];
    if (pm && pm.card && pm.card.fingerprint) return pm.card.fingerprint;
  } catch(e) {}

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
      'SELECT id, plan, stripe_sub_id, pro_expires_at FROM users WHERE id=?'
    ).bind(referrerId).first();
    if (!referrer) return;

    if (referrer.stripe_sub_id) {
      // Referrer is a paying Stripe subscriber — bank a credit month so the
      // invoice.created handler can apply it against their next renewal charge.
      await db.prepare(
        'UPDATE users SET referral_credits = referral_credits + 1 WHERE id=?'
      ).bind(referrer.id).run();
    } else {
      // Referrer is on a free/manual pro plan — extend pro_expires_at directly.
      const now = Math.floor(Date.now() / 1000);
      const base = (referrer.pro_expires_at && referrer.pro_expires_at > now)
        ? referrer.pro_expires_at : now;
      const newExpiry = base + 2592000; // +30 days
      await db.prepare(
        'UPDATE users SET plan=\'pro\', pro_expires_at=? WHERE id=?'
      ).bind(newExpiry, referrer.id).run();
    }
  } catch(e) {}
}
