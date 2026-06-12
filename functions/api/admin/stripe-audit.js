// TEMPORARY — delete after use
import { getSession } from '../../../_lib/session.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session || !session.is_admin) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  async function stripeGet(path) {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }
    });
    return res.json();
  }

  async function getAllSubs(status) {
    const subs = [];
    let startingAfter = null;
    while (true) {
      const qs = `status=${status}&limit=100${startingAfter ? '&starting_after=' + startingAfter : ''}`;
      const data = await stripeGet(`subscriptions?${qs}`);
      if (data.error) return { error: data.error.message };
      subs.push(...data.data);
      if (!data.has_more) break;
      startingAfter = data.data[data.data.length - 1].id;
    }
    return subs;
  }

  const [active, trialing, pastDue] = await Promise.all([
    getAllSubs('active'),
    getAllSubs('trialing'),
    getAllSubs('past_due'),
  ]);

  const all = [...active, ...trialing, ...pastDue];

  const byCustomer = {};
  for (const sub of all) {
    if (!byCustomer[sub.customer]) byCustomer[sub.customer] = [];
    byCustomer[sub.customer].push({ id: sub.id, status: sub.status, created: sub.created });
  }

  const dupes = Object.entries(byCustomer)
    .filter(([, subs]) => subs.length > 1)
    .map(([custId, subs]) => ({ customer: custId, subscriptions: subs }));

  return new Response(JSON.stringify({
    totals: { active: active.length, trialing: trialing.length, past_due: pastDue.length },
    duplicate_customers: dupes,
    duplicate_count: dupes.length
  }, null, 2), { headers: { 'Content-Type': 'application/json' } });
}
