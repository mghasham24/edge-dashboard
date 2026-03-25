// functions/api/stripe/webhook.js
export async function onRequestPost({ request, env }) {
  const sig     = request.headers.get('stripe-signature') || '';
  const rawBody = await request.text();

  // Verify webhook signature
  const valid = await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return new Response('Invalid signature', { status: 400 });

  let event;
  try { event = JSON.parse(rawBody); } catch { return new Response('Bad JSON', { status: 400 }); }

  const obj = event.data.object;

  switch (event.type) {
    // Subscription activated or renewed
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const status = obj.status;
      const plan   = (status === 'active' || status === 'trialing') ? 'pro' : 'free';
      const custId = obj.customer;
      const subId  = obj.id;
      await env.DB.prepare(
        'UPDATE users SET plan=?, stripe_sub_id=? WHERE stripe_customer_id=?'
      ).bind(plan, subId, custId).run();
      break;
    }
    // Subscription cancelled or payment failed
    case 'customer.subscription.deleted': {
      const custId = obj.customer;
      await env.DB.prepare(
        'UPDATE users SET plan=\'free\', stripe_sub_id=NULL WHERE stripe_customer_id=?'
      ).bind(custId).run();
      break;
    }
    // Checkout completed — belt-and-suspenders upgrade
    case 'checkout.session.completed': {
      if (obj.mode === 'subscription' && obj.payment_status === 'paid') {
        const custId = obj.customer;
        const subId  = obj.subscription;
        await env.DB.prepare(
          'UPDATE users SET plan=\'pro\', stripe_sub_id=? WHERE stripe_customer_id=?'
        ).bind(subId, custId).run();
      }
      break;
    }
    // Payment failed — downgrade
    case 'invoice.payment_failed': {
      const custId = obj.customer;
      await env.DB.prepare(
        'UPDATE users SET plan=\'free\' WHERE stripe_customer_id=?'
      ).bind(custId).run();
      break;
    }
  }

  return new Response('ok', { status: 200 });
}

// ── Stripe webhook signature verification ─────────────
async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!secret) return true; // skip in dev if not set
  try {
    const parts     = sigHeader.split(',').reduce((acc, part) => {
      const [k, v] = part.split('=');
      acc[k] = v;
      return acc;
    }, {});
    const timestamp = parts['t'];
    const sig       = parts['v1'];
    if (!timestamp || !sig) return false;

    const enc     = new TextEncoder();
    const keyData = enc.encode(secret);
    const msgData = enc.encode(timestamp + '.' + payload);

    const key = await crypto.subtle.importKey(
      'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const signed  = await crypto.subtle.sign('HMAC', key, msgData);
    const computed = Array.from(new Uint8Array(signed))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    return computed === sig;
  } catch { return false; }
}
