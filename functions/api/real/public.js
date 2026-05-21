import { getSession } from '../../_lib/session.js';
import { checkRateLimit } from '../../_lib/rateLimit.js';
import { hashidsEncode } from '../../_lib/hashids.js';
// functions/api/real/public.js
// GET /api/real/public?username=HANDLE
// Looks up any RS user's open positions by username using the shared RS auth token.
// Requires a valid RaxEdge session — not callable anonymously.

const BASE = 'https://web.realapp.com';

function buildHeaders(rsToken) {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${rsToken}`,
    'Origin': 'https://realsports.io',
    'Referer': 'https://realsports.io/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-device-type': 'desktop_web',
    'real-device-uuid': '2e0a38e2-0ee8-4f93-9a34-218ac1d10161',
    'real-device-name': '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-request-token': hashidsEncode(Date.now()),
    'real-version': '30'
  };
}

async function rsGet(path, hdrs, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, { headers: hdrs, signal: ctrl.signal });
    clearTimeout(timer);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 400); }
    return { status: res.status, body };
  } catch (e) {
    clearTimeout(timer);
    return { status: e.name === 'AbortError' ? 'timeout' : 'error', body: e.message };
  }
}

async function getRsToken(env) {
  try {
    const row = await env.DB.prepare(
      "SELECT value FROM odds_cache WHERE key='meta:rs_auth_token' LIMIT 1"
    ).first();
    if (row?.value) return row.value;
  } catch {}
  return env.RS_AUTH_TOKEN || env.REAL_AUTH_TOKEN || null;
}

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');

  const allowed = await checkRateLimit(env.DB, request, 'real_public', 10, 60);
  if (!allowed) return fail(429, 'Too many requests');

  const url = new URL(request.url);
  const username = (url.searchParams.get('username') || '').trim().replace(/^@/, '');

  if (!username) return fail(400, 'username required');
  if (!/^[a-zA-Z0-9_.-]{1,50}$/.test(username)) return fail(400, 'invalid username');

  const rsToken = await getRsToken(env);
  if (!rsToken) return fail(503, 'RS token unavailable — try again later');

  const hdrs = buildHeaders(rsToken);

  // Step 1: resolve username → userId
  // Try the most likely paths first (stay well under CF's 50 subrequest limit)
  const usernamePaths = [
    `/users/username/${username}`,
    `/user/username/${username}`,
    `/accounts/username/${username}`,
    `/profiles/username/${username}`,
    `/users?username=${username}`,
    `/users?handle=${username}`,
    `/users?search=${username}`,
  ];

  const profileResults = await Promise.all(
    usernamePaths.map(p => rsGet(p, hdrs).then(r => ({ path: p, ...r })))
  );

  const profileHit = profileResults.find(r => r.status === 200 && r.body && typeof r.body === 'object');

  if (!profileHit) {
    return json({
      ok: false,
      username,
      message: 'Could not resolve this username via RS API.',
      probe: profileResults.map(r => ({
        path: r.path,
        status: r.status,
        body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body).slice(0, 200)
      }))
    });
  }

  const userId =
    profileHit.body?.id ||
    profileHit.body?.userId ||
    profileHit.body?.user?.id ||
    profileHit.body?.data?.id ||
    (Array.isArray(profileHit.body?.users) ? profileHit.body.users[0]?.id : null) ||
    (Array.isArray(profileHit.body?.results) ? profileHit.body.results[0]?.id : null) ||
    null;

  if (!userId) {
    return json({
      ok: false,
      username,
      message: 'Profile found but could not extract userId.',
      profilePath: profileHit.path,
      profileBody: profileHit.body
    });
  }

  // Step 2: fetch open positions for this userId
  const posPaths = [
    `/users/${userId}/positions`,
    `/users/${userId}/predictions`,
    `/users/${userId}/open-positions`,
    `/predictions/user/${userId}`,
    `/positions/user/${userId}`,
  ];

  const posResults = await Promise.all(
    posPaths.map(p => rsGet(p, hdrs).then(r => ({ path: p, ...r })))
  );

  const posHit = posResults.find(r => r.status === 200 && r.body);

  return json({
    ok: true,
    username,
    userId,
    profile: profileHit.body,
    profilePath: profileHit.path,
    positions: posHit?.body || null,
    positionsPath: posHit?.path || null,
    positionsProbe: posResults.map(r => ({ path: r.path, status: r.status }))
  });
}

function json(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' }
  });
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
