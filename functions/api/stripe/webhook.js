// functions/api/stripe/webhook.js

// ── Stripe signature verification (Web Crypto) ────────
async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) return false;

  // sigHeader format: "t=timestamp,v1=sig1,v1=sig2,..."
  const parts = sigHeader.split(',');
  const tPart = parts.find(p => p.startsWith('t='));
  const vParts = parts.filter(p => p.startsWith('v1='));
  if (!tPart || !vParts.length) return false;

  const timestamp = tPart.slice(2);
  const signatures = vParts.map(p => p.slice(3));

  // Reject if timestamp is more than 5 minutes old (replay attack protection)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;

  // Signed payload = "timestamp.rawBody"
  const signedPayload = timestamp + '.' + payload;

  // HMAC-SHA256 using Web Crypto
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload));
  const expected = Array.from(new Uint8Array(mac))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Check if any of the v1 signatures match
  return signatures.some(sig => sig === expected);
}

// ── Handler ───────────────────────────────────────────
export async function onRequestPost({ request, env }) {
  const rawBody = await request.text();
  const sigHeader = request.headers.get('Stripe-Signature') || '';

  // Verify signature before doing anything
  const valid = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    return new Response('Unauthorized', { status: 401 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }

  const obj = event.data.object;

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const status = obj.status;
      const plan   = (status === 'active' || status === 'trialing') ? 'pro' : 'free';
      await env.DB.prepare(
        'UPDATE users SET plan=?, stripe_sub_id=? WHERE stripe_customer_id=?'
      ).bind(plan, obj.id, obj.customer).run();
      break;
    }
    case 'customer.subscription.deleted': {
      await env.DB.prepare(
        'UPDATE users SET plan=\'free\', stripe_sub_id=NULL WHERE stripe_customer_id=?'
      ).bind(obj.customer).run();
      break;
    }
    case 'checkout.session.completed': {
      if (obj.mode === 'subscription' && obj.payment_status === 'paid') {
        await env.DB.prepare(
          'UPDATE users SET plan=\'pro\', stripe_sub_id=? WHERE stripe_customer_id=?'
        ).bind(obj.subscription, obj.customer).run();

        // Check if this user was referred — if so, reward referrer with +1 month Pro
        const newPro = await env.DB.prepare(
          'SELECT id, referred_by FROM users WHERE stripe_customer_id=?'
        ).bind(obj.customer).first();
        if (newPro && newPro.referred_by) {
          const referrer = await env.DB.prepare(
            'SELECT id, plan, pro_expires_at FROM users WHERE id=?'
          ).bind(newPro.referred_by).first();
          if (referrer) {
            const now = Math.floor(Date.now() / 1000);
            const base = (referrer.pro_expires_at && referrer.pro_expires_at > now)
              ? referrer.pro_expires_at
              : now;
            const newExpiry = base + 30 * 86400; // +1 month
            await env.DB.prepare(
              'UPDATE users SET plan=\'pro\', pro_expires_at=? WHERE id=?'
            ).bind(newExpiry, referrer.id).run();
          }
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
