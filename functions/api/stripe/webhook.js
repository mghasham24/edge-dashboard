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
  const expectedBytes = new Uint8Array(mac);
  // Constant-time compare — XOR all bytes so runtime doesn't leak match position
  return signatures.some(sig => {
    const sigBytes = new Uint8Array(sig.match(/.{2}/g).map(h => parseInt(h, 16)));
    if (sigBytes.length !== expectedBytes.length) return false;
    let diff = 0;
    for (let i = 0; i < expectedBytes.length; i++) diff |= sigBytes[i] ^ expectedBytes[i];
    return diff === 0;
  });
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

  // Idempotency guard — Stripe retries on non-2xx or network errors.
  // Insert the event id; if it conflicts, we already processed it.
  try {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      'INSERT INTO processed_webhook_events (event_id, processed_at) VALUES (?,?)'
    ).bind(event.id, now).run();
  } catch(e) {
    // Unique constraint violation — duplicate delivery, already handled
    if (e && e.message && e.message.includes('UNIQUE')) return new Response('ok', { status: 200 });
  }

  const obj = event.data.object;

  switch (event.type) {
    case 'customer.subscription.created': {
      const status = obj.status;
      const plan   = (status === 'active' || status === 'trialing') ? 'pro' : 'free';
      const proExpiresAt = (plan === 'pro' && obj.current_period_end) ? obj.current_period_end : null;

      if (status === 'trialing') {
        // Run fingerprint check here AND in checkout.session.completed — Stripe does not
        // guarantee delivery order, so whichever fires first catches abuse, the other confirms.
        const pmId   = obj.default_payment_method;
        const abused = await checkFingerprintByPmId(pmId, obj.customer, env.DB, env.STRIPE_SECRET_KEY);
        if (abused) {
          try {
            await fetch('https://api.stripe.com/v1/subscriptions/' + obj.id, {
              method: 'DELETE',
              headers: { 'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY }
            });
          } catch(e) {}
          await env.DB.prepare(
            'UPDATE users SET plan=\'free\', stripe_sub_id=NULL, pro_expires_at=NULL, had_free_trial=0 WHERE stripe_customer_id=?'
          ).bind(obj.customer).run();
          break;
        }
        await env.DB.prepare(
          'UPDATE users SET plan=?, stripe_sub_id=?, pro_expires_at=?, had_free_trial=1 WHERE stripe_customer_id=?'
        ).bind(plan, obj.id, proExpiresAt, obj.customer).run();
      } else {
        await env.DB.prepare(
          'UPDATE users SET plan=?, stripe_sub_id=?, pro_expires_at=? WHERE stripe_customer_id=?'
        ).bind(plan, obj.id, proExpiresAt, obj.customer).run();
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
        const interval = obj.items?.data?.[0]?.price?.recurring?.interval || 'month';
        await rewardReferrerForCustomer(obj.customer, obj.metadata, env.DB, interval);
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const now = Math.floor(Date.now() / 1000);
      if (obj.trial_end && obj.trial_end > now) {
        // Cancelled during active trial — keep pro until trial_end, just detach sub
        await env.DB.prepare(
          'UPDATE users SET stripe_sub_id=NULL, pro_expires_at=? WHERE stripe_customer_id=? AND stripe_sub_id=?'
        ).bind(obj.trial_end, obj.customer, obj.id).run();
      } else {
        // Before downgrading, check if customer still has another active/past_due sub.
        // A customer can have multiple subs (e.g. old canceled + new active) — canceling
        // the old one should not downgrade them if the new one is still running.
        let otherActiveSub = null;
        try {
          const subsRes = await fetch(
            'https://api.stripe.com/v1/subscriptions?customer=' + obj.customer + '&status=all&limit=10',
            { headers: { 'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY } }
          );
          const subs = await subsRes.json();
          otherActiveSub = (subs.data || []).find(function(s) {
            return s.id !== obj.id && (s.status === 'active' || s.status === 'past_due' || s.status === 'trialing');
          }) || null;
        } catch(e) {}

        if (otherActiveSub) {
          // Still has a live sub — point stripe_sub_id to it and keep pro
          const proExpiresAt = otherActiveSub.current_period_end || null;
          await env.DB.prepare(
            'UPDATE users SET plan=\'pro\', stripe_sub_id=?, pro_expires_at=? WHERE stripe_customer_id=? AND stripe_sub_id=?'
          ).bind(otherActiveSub.id, proExpiresAt, obj.customer, obj.id).run();
        } else {
          // No other active subs — safe to downgrade
          await env.DB.prepare(
            'UPDATE users SET plan=\'free\', stripe_sub_id=NULL, pro_expires_at=NULL, billing_interval=\'monthly\' WHERE stripe_customer_id=? AND stripe_sub_id=?'
          ).bind(obj.customer, obj.id).run();
        }
      }
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

        const billingInterval = (subData?.items?.data?.[0]?.price?.recurring?.interval === 'year') ? 'annual' : 'monthly';

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
              'UPDATE users SET plan=\'free\', stripe_sub_id=NULL, pro_expires_at=NULL, had_free_trial=0, billing_interval=\'monthly\' WHERE stripe_customer_id=?'
            ).bind(obj.customer).run();
            break; // abused — skip welcome email
          } else {
            // Activate pro immediately — don't rely on subscription.created webhook firing successfully
            const proExpiresAt = subData.trial_end || subData.current_period_end || null;
            await env.DB.prepare(
              'UPDATE users SET plan=\'pro\', stripe_sub_id=?, pro_expires_at=?, had_free_trial=1, billing_interval=? WHERE stripe_customer_id=?'
            ).bind(obj.subscription, proExpiresAt, billingInterval, obj.customer).run();
          }
        }

        if (isPaid) {
          // Immediate paid subscription — set pro and reward referrer
          const proExpiresAt = subData && subData.current_period_end ? subData.current_period_end : null;
          await env.DB.prepare(
            'UPDATE users SET plan=\'pro\', stripe_sub_id=?, pro_expires_at=?, billing_interval=? WHERE stripe_customer_id=?'
          ).bind(obj.subscription, proExpiresAt, billingInterval, obj.customer).run();
          const subInterval = subData?.items?.data?.[0]?.price?.recurring?.interval || 'month';
          await rewardReferrerForCustomer(obj.customer, subData?.metadata || {}, env.DB, subInterval);
        }

        // Send Email 1 (welcome) — fire-and-forget, don't block webhook response
        if ((isTrial || isPaid) && env.RESEND_API_KEY) {
          try {
            const user = await env.DB.prepare(
              'SELECT id, email FROM users WHERE stripe_customer_id=?'
            ).bind(obj.customer).first();
            if (user) {
              const alreadySent = await env.DB.prepare(
                'SELECT 1 FROM onboarding_emails WHERE user_id=? AND step=1'
              ).bind(user.id).first();
              if (!alreadySent) {
                const magicUrl = await createMagicLink(user.id, env);
                await sendEmail1(user.id, user.email, magicUrl, env);
              }
            }
          } catch(e) {}
        }
      }
      break;
    }

    case 'invoice.created': {
      // Only act on subscription invoices with a real charge while still in draft.
      // If the invoice is already past draft (finalized/paid), the credit would miss it.
      if (obj.billing_reason !== 'subscription_cycle' && obj.billing_reason !== 'subscription_create') break;
      if (!obj.customer || !obj.amount_due || obj.amount_due <= 0) break;
      if (obj.status !== 'draft') break; // too late — invoice already finalized
      try {
        // Decrement first, atomically. If changes=0, another delivery already handled it.
        const { meta } = await env.DB.prepare(
          'UPDATE users SET referral_credits = referral_credits - 1 WHERE stripe_customer_id=? AND referral_credits > 0'
        ).bind(obj.customer).run();
        if (!meta.changes) break; // no credits to spend, or already decremented by a retry

        // Apply a credit to the Stripe customer balance — Stripe auto-applies on finalization
        const user = await env.DB.prepare(
          'SELECT id FROM users WHERE stripe_customer_id=?'
        ).bind(obj.customer).first();
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
        // If Stripe call fails, restore the credit so it isn't silently lost
        if (!creditRes.ok && user) {
          await env.DB.prepare(
            'UPDATE users SET referral_credits = referral_credits + 1 WHERE id=?'
          ).bind(user.id).run();
        }
      } catch(e) {}
      break;
    }

    case 'invoice.payment_failed': {
      // No plan change — Stripe retries via dunning; downgrade only on subscription.deleted.
      // On the first failure only, send a "update your card" email.
      if (obj.attempt_count === 1 && obj.customer && env.RESEND_API_KEY) {
        try {
          const user = await env.DB.prepare(
            'SELECT id, email FROM users WHERE stripe_customer_id=?'
          ).bind(obj.customer).first();
          if (user) {
            const alreadySent = await env.DB.prepare(
              'SELECT 1 FROM onboarding_emails WHERE user_id=? AND step=5'
            ).bind(user.id).first();
            if (!alreadySent) {
              const portalMagicUrl = await createMagicLink(user.id, env, '/api/stripe/portal');
              await sendDunningEmail(user.id, user.email, portalMagicUrl, env);
            }
          }
        } catch(e) {}
      }
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

// ── Onboarding email helpers ──────────────────────────

function hexRandom(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

async function createMagicLink(userId, env, redirect) {
  const token = hexRandom(32);
  const expires = Math.floor(Date.now() / 1000) + 48 * 3600; // 48h
  await env.DB.prepare(
    'INSERT OR REPLACE INTO magic_tokens (token, user_id, expires_at) VALUES (?,?,?)'
  ).bind(token, userId, expires).run();
  const base = 'https://raxedge.com';
  const url = base + '/api/auth/magic?token=' + token;
  return redirect ? url + '&redirect=' + encodeURIComponent(redirect) : url;
}

async function sendEmail1(userId, email, magicUrl, env) {
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 24px;background:#0a0a0c;color:#f0eff5;border-radius:12px">
      <div style="font-size:20px;font-weight:700;margin-bottom:4px">RaxEdge</div>
      <div style="font-size:13px;color:#7a7990;margin-bottom:32px">Pro Member</div>
      <div style="font-size:18px;font-weight:600;margin-bottom:16px">You're in — here's what to do first</div>
      <p style="color:#b0afc5;font-size:14px;line-height:1.7;margin:0 0 24px">Here's the fastest way to see what you're paying for:</p>
      <ol style="color:#b0afc5;font-size:14px;line-height:1.9;margin:0 0 28px;padding-left:20px">
        <li>Open your dashboard — every bet flagged green is one where the math is in your favor right now</li>
        <li>Tap any bet to see edge %, Kelly stake suggestion, and where the value is coming from</li>
        <li>That's it. No setup, no linking accounts required to start seeing value</li>
      </ol>
      <a href="${magicUrl}" style="display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;padding:13px 32px;border-radius:7px;font-weight:600;font-size:15px;margin-bottom:28px">Open my dashboard →</a>
      <p style="color:#4a4960;font-size:13px;margin:0">Questions? Just reply to this email.<br>— Moe, RaxEdge</p>
    </div>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Moe at RaxEdge <noreply@raxedge.com>',
      to: email,
      subject: "You're in — here's what to do first",
      text: `You're now a RaxEdge Pro member.\n\nHere's the fastest way to see what you're paying for:\n\n1. Open your dashboard — every bet flagged green is one where the math is in your favor right now\n2. Tap any bet to see edge %, Kelly stake suggestion, and where the value is coming from\n3. That's it. No setup required.\n\nOpen your dashboard: ${magicUrl}\n\nQuestions? Just reply to this email.\n— Moe, RaxEdge`,
      html
    })
  });

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    'INSERT OR IGNORE INTO onboarding_emails (user_id, step, sent_at) VALUES (?,1,?)'
  ).bind(userId, now).run();
}

async function sendDunningEmail(userId, email, portalMagicUrl, env) {
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 24px;background:#0a0a0c;color:#f0eff5;border-radius:12px">
      <div style="font-size:20px;font-weight:700;margin-bottom:4px">RaxEdge</div>
      <div style="font-size:13px;color:#7a7990;margin-bottom:32px">Billing</div>
      <div style="font-size:18px;font-weight:600;margin-bottom:16px">Your payment didn't go through</div>
      <p style="color:#b0afc5;font-size:14px;line-height:1.7;margin:0 0 16px">We weren't able to charge your card for your RaxEdge Pro subscription. Stripe will retry automatically, but to avoid losing access you can update your payment method now.</p>
      <a href="${portalMagicUrl}" style="display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;padding:13px 32px;border-radius:7px;font-weight:600;font-size:15px;margin-bottom:28px">Update payment method</a>
      <p style="color:#4a4960;font-size:13px;margin:0">— Moe, RaxEdge</p>
    </div>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Moe at RaxEdge <noreply@raxedge.com>',
      to: email,
      subject: "Your payment didn't go through",
      text: `Hey,\n\nWe weren't able to charge your card for your RaxEdge Pro subscription. Stripe will retry automatically, but to avoid losing access you can update your payment method now.\n\nUpdate your card: ${portalMagicUrl}\n\n— Moe, RaxEdge`,
      html
    })
  });

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    'INSERT OR IGNORE INTO onboarding_emails (user_id, step, sent_at) VALUES (?,5,?)'
  ).bind(userId, now).run();
}

// ── Reward referrer helper ────────────────────────────
// billingInterval: Stripe interval string — 'year' for annual, 'month' for monthly.
// Annual referrals earn 2 months; monthly earns 1.
async function rewardReferrerForCustomer(stripeCustomerId, metadata, db, billingInterval) {
  try {
    const newPro = await db.prepare(
      'SELECT id, referred_by FROM users WHERE stripe_customer_id=?'
    ).bind(stripeCustomerId).first();
    if (!newPro) return;

    const referrerIdFromMeta = metadata && metadata.referrer_id
      ? parseInt(metadata.referrer_id, 10) : null;
    const referrerId = referrerIdFromMeta || newPro.referred_by || null;
    if (!referrerId) return;

    // Idempotency guard — skip if this referral was already rewarded.
    const existing = await db.prepare(
      'SELECT rewarded_at FROM referrals WHERE referrer_id=? AND referred_id=?'
    ).bind(referrerId, newPro.id).first();
    if (existing && existing.rewarded_at) return;

    const referrer = await db.prepare(
      'SELECT id, plan, stripe_sub_id, pro_expires_at FROM users WHERE id=?'
    ).bind(referrerId).first();
    if (!referrer) return;

    const months = (billingInterval === 'year') ? 3 : 1;

    if (referrer.stripe_sub_id) {
      // Referrer is a paying Stripe subscriber — bank credit months so the
      // invoice.created handler can apply them against their next renewal charge.
      await db.prepare(
        'UPDATE users SET referral_credits = referral_credits + ? WHERE id=?'
      ).bind(months, referrer.id).run();
    } else {
      // Referrer is on a free/manual pro plan — extend pro_expires_at directly.
      const now = Math.floor(Date.now() / 1000);
      const base = (referrer.pro_expires_at && referrer.pro_expires_at > now)
        ? referrer.pro_expires_at : now;
      const newExpiry = base + (months * 2592000); // 30 days per month
      await db.prepare(
        'UPDATE users SET plan=\'pro\', pro_expires_at=? WHERE id=?'
      ).bind(newExpiry, referrer.id).run();
    }

    // Stamp the referral row — marks confirmed paid conversion and prevents double-reward.
    const rewardedAt = Math.floor(Date.now() / 1000);
    await db.prepare(
      'UPDATE referrals SET rewarded_at=?, months_earned=? WHERE referrer_id=? AND referred_id=?'
    ).bind(rewardedAt, months, referrerId, newPro.id).run();
  } catch(e) { console.error('rewardReferrer failed:', e && e.message); }
}
