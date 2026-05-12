// functions/_lib/stripe.js — shared Stripe API helpers

export async function stripeGet(endpoint, secretKey) {
  const res = await fetch('https://api.stripe.com/v1/' + endpoint, {
    headers: { 'Authorization': 'Bearer ' + secretKey }
  });
  return res.json();
}

export async function stripePost(endpoint, params, secretKey) {
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

export function flattenParams(obj, prefix) {
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
