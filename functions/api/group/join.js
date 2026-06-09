// functions/api/group/join.js
// GET  /api/group/join  — returns { ok, joined, rs_username, link }
// POST /api/group/join  — { rs_username } → validate against RS API → set group_access=1 → { ok, link }

import { getSession } from '../../_lib/session.js';
import { hashidsEncode } from '../../_lib/hashids.js';

const GROUP_LINK_FALLBACK = 'https://www.realapp.com/ZdWcrFgFN6p';

export async function onRequest(ctx) {
  try { return await handle(ctx); }
  catch(e) { return fail(500, e.message); }
}

async function handle({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');

  const user = await env.DB.prepare(
    'SELECT plan, is_admin, group_access, rs_group_username FROM users WHERE id=?'
  ).bind(session.user_id).first();
  if (!user || (user.plan !== 'pro' && !user.is_admin)) return fail(403, 'Pro required');

  const groupLink = env.RS_GROUP_LINK || GROUP_LINK_FALLBACK;

  if (request.method === 'GET') {
    const joined = !!(user.group_access && user.rs_group_username);
    return ok({
      joined,
      rs_username: user.rs_group_username || null,
      link: joined ? groupLink : null,
    });
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return fail(400, 'Invalid JSON'); }
    const rs_username = (body.rs_username || '').trim();
    if (!rs_username) return fail(400, 'RS username required');
    if (!/^[a-zA-Z0-9_./-]{1,50}$/.test(rs_username)) return fail(400, 'Invalid RS username format');

    // Prevent two accounts sharing the same RS username
    const conflict = await env.DB.prepare(
      'SELECT id FROM users WHERE rs_group_username=? AND id!=?'
    ).bind(rs_username, session.user_id).first();
    if (conflict) return fail(409, 'That RS username is already linked to another RaxEdge account');

    // Validate RS username exists via RS API
    try {
      await validateRsUsername(rs_username, env);
    } catch(e) {
      const msg = e.message || '';
      if (msg === 'not_found') return fail(400, 'Username not found on RealSports — double-check your username');
      if (msg === 'no_token') return fail(503, 'Username verification temporarily unavailable — try again later');
      return fail(502, 'Could not verify username — try again');
    }

    await env.DB.prepare(
      'UPDATE users SET group_access=1, rs_group_username=? WHERE id=?'
    ).bind(rs_username, session.user_id).run();

    return ok({ link: groupLink, rs_username });
  }

  return fail(405, 'Method not allowed');
}

async function validateRsUsername(username, env) {
  let token = env.RS_AUTH_TOKEN || env.REAL_AUTH_TOKEN || '';
  const deviceUuid = env.REAL_DEVICE_UUID || '2e0a38e2-0ee8-4f93-9a34-218ac1d10161';
  if (!token) {
    try {
      const row = await env.DB.prepare("SELECT data FROM odds_cache WHERE cache_key='meta:rs_auth_token'").first();
      if (row) token = JSON.parse(row.data).token || '';
    } catch(e) {}
  }
  if (!token) throw new Error('no_token');

  const res = await fetch(`https://web.realapp.com/user/${encodeURIComponent(username)}`, {
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Origin': 'https://realsports.io',
      'Referer': 'https://realsports.io/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      'real-auth-info': token,
      'real-device-uuid': deviceUuid,
      'real-device-type': 'desktop_web',
      'real-version': '33',
      'real-request-token': hashidsEncode(Date.now()),
    },
    signal: AbortSignal.timeout(6000),
  });
  const data = await res.json();
  const u = data.user || null;
  if (!u || !u.id) throw new Error('not_found');
  return { hashid: u.id, username: u.username || username };
}

function ok(d) {
  return new Response(JSON.stringify({ ok: true, ...d }), { headers: { 'Content-Type': 'application/json' } });
}
function fail(status, msg) {
  return new Response(JSON.stringify({ ok: false, error: msg }), { status, headers: { 'Content-Type': 'application/json' } });
}
