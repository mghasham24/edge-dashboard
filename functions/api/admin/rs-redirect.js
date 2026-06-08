// functions/api/admin/rs-redirect.js
// GET /api/admin/rs-redirect?id={hashid}
// Looks up current RS username by hashid, redirects to realsports.io/u/{username}

import { getSession } from '../../_lib/session.js';
import { hashidsEncode } from '../../_lib/hashids.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session || !session.is_admin) {
    return new Response('Forbidden', { status: 403 });
  }

  const hashid = new URL(request.url).searchParams.get('id');
  if (!hashid) return new Response('Missing id', { status: 400 });

  // Get shared RS auth token
  let token = env.RS_AUTH_TOKEN || env.REAL_AUTH_TOKEN || '';
  const deviceUuid = env.REAL_DEVICE_UUID || '2e0a38e2-0ee8-4f93-9a34-218ac1d10161';
  if (!token) {
    try {
      const row = await env.DB.prepare("SELECT data FROM odds_cache WHERE cache_key='meta:rs_auth_token'").first();
      if (row) token = JSON.parse(row.data).token || '';
    } catch(e) {}
  }
  if (!token) return new Response('RS token not available', { status: 503 });

  try {
    const res = await fetch(`https://web.realapp.com/user/${encodeURIComponent(hashid)}`, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': 'https://realsports.io',
        'Referer': 'https://realsports.io/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
        'real-auth-info': token,
        'real-device-uuid': deviceUuid,
        'real-device-type': 'desktop_web',
        'real-version': '33',
        'real-request-token': hashidsEncode(Date.now()),
      },
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    const username = data.username || data.userName || data.user?.username || null;
    if (!username) {
      return new Response(JSON.stringify({ error: 'Username not found', keys: Object.keys(data), userKeys: data.user ? Object.keys(data.user) : null }), {
        status: 404, headers: { 'Content-Type': 'application/json' }
      });
    }
    return Response.redirect(`https://realsports.io/u/${encodeURIComponent(username)}`, 302);
  } catch(e) {
    return new Response('Lookup failed: ' + e.message, { status: 502 });
  }
}
