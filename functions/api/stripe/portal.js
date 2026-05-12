import { getSession } from '../../_lib/session.js';
import { stripePost } from '../../_lib/stripe.js';
// functions/api/stripe/portal.js
export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');
  if (!session.stripe_customer_id) return fail(400, 'No billing account found');

  const origin = new URL(request.url).origin;

  const portal = await stripePost('billing_portal/sessions', {
    customer:   session.stripe_customer_id,
    return_url: origin + '/'
  }, env.STRIPE_SECRET_KEY);

  if (portal.error) return fail(500, 'Failed to open billing portal');

  return new Response(JSON.stringify({ ok: true, url: portal.url }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
