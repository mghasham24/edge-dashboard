import { getSession } from '../../_lib/session.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return json(401, { ok: false, error: 'Not authenticated' });

  const user = await env.DB.prepare('SELECT plan, is_admin FROM users WHERE id=?').bind(session.user_id).first();
  if (!user || (user.plan !== 'pro' && !user.is_admin)) return json(403, { ok: false, error: 'Pro required' });

  return json(200, { ok: true, code: env.RS_GROUP_CODE || null });
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
