// functions/api/stripe/webhook.js
export async function onRequestPost({ request, env }) {
  let event;
  try {
    const rawBody = await request.text();
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
