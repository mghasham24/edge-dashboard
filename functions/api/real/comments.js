// functions/api/real/comments.js
// GET /api/real/comments?postId=XXX&groupId=60106&_tm_key=KEY
// Proxies RS group post comments through CF — bypasses TM sandbox auth issues

import { getSessionOrCron } from '../../_lib/auth.js';

const RS_BASE = 'https://web.realapp.com';
const TM_KEY  = 'rax-bridge-9w2k5j7n';

function fail(status, msg) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const tmKey = url.searchParams.get('_tm_key');
  if (tmKey !== (env.TM_PUSH_KEY || TM_KEY)) {
    const session = await getSessionOrCron(request, env);
    if (!session?.is_admin) return fail(401, 'Unauthorized');
  }

  const postId  = url.searchParams.get('postId');
  const groupId = url.searchParams.get('groupId') || '60106';
  const limit   = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 100);
  const cursor  = url.searchParams.get('cursor') || null;

  if (!postId) return fail(400, 'postId required');

  // Token priority: caller-supplied → D1 (token bridge) → env var
  let rsToken = url.searchParams.get('rsToken') || null;
  if (!rsToken) {
    try {
      const row = await env.DB.prepare(
        'SELECT data FROM odds_cache WHERE cache_key=?'
      ).bind('meta:rs_auth_token').first();
      if (row) rsToken = JSON.parse(row.data).token;
    } catch(e) {}
  }
  if (!rsToken) rsToken = env.RS_AUTH_TOKEN;
  if (!rsToken) return fail(503, 'No RS token available');

  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  const rsUrl = `${RS_BASE}/comments/groups/${groupId}/replies/${postId}?${params}`;

  try {
    const res = await fetch(rsUrl, {
      headers: {
        'Accept':             'application/json',
        'Content-Type':       'application/json',
        'Origin':             'https://realsports.io',
        'Referer':            'https://realsports.io/',
        'real-auth-info':     rsToken,
        'real-device-uuid':   '2e0a38e2-0ee8-4f93-9a34-218ac1d10161',
        'real-device-name':   '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
        'real-device-type':   'desktop_web',
        'real-version':       '32',
        'real-request-token': String(Date.now()),
      },
      signal: AbortSignal.timeout(10000),
    });

    const text = await res.text();
    if (!res.ok) return fail(res.status, `RS error ${res.status}: ${text}`);

    const data = JSON.parse(text);
    return new Response(JSON.stringify({ ok: true, comments: data.comments || [], cursor: data.cursor || data.nextCursor || null }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch(e) {
    return fail(500, e.message);
  }
}
