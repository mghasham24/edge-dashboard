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
    if (v !== null && typeof v === 'object') {
      Object.assign(acc, flattenParams(v, key));
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
    'SELECT u.id, u.email, u.plan, u.stripe_customer_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(m[1], now).first();
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
