import { getSession } from '../../_lib/session.js';
import { checkRateLimit } from '../../_lib/rateLimit.js';
import { hashidsEncode } from '../../_lib/hashids.js';
// functions/api/real/public.js
// GET /api/real/public?username=HANDLE
// Returns RS profile + open positions + portfolio performance for any username.
// All three endpoints are public — shared token + userId param, no user connection required.

const BASE = 'https://web.realapp.com';

function buildHeaders(rsToken, deviceUuid = '2e0a38e2-0ee8-4f93-9a34-218ac1d10161') {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': 'https://realsports.io',
    'Referer': 'https://realsports.io/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-auth-info': rsToken,
    'real-device-type': 'desktop_web',
    'real-device-uuid': deviceUuid,
    'real-device-name': '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-request-token': hashidsEncode(Date.now()),
    'real-version': '31'
  };
}

async function rsGet(path, hdrs, timeoutMs = 7000) {
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

async function getSharedRsToken(env) {
  try {
    const row = await env.DB.prepare(
      "SELECT data FROM odds_cache WHERE cache_key='rs_auth_token' LIMIT 1"
    ).first();
    if (row?.data) {
      try {
        const parsed = JSON.parse(row.data);
        if (parsed?.token) return parsed.token;
      } catch { if (typeof row.data === 'string' && row.data.includes('!')) return row.data; }
    }
  } catch {}
  return env.RS_AUTH_TOKEN || env.REAL_AUTH_TOKEN || null;
}

export async function onRequestGet({ request, env }) {
  try {
    return await handleGet(request, env);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Internal error', message: e.message, stack: (e.stack || '').slice(0, 500) }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleGet(request, env) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');

  const url = new URL(request.url);
  const allowed = await checkRateLimit(env.DB, request, 'real_public_search', 10, 60);
  if (!allowed) return fail(429, 'Too many requests');

  const sharedToken = await getSharedRsToken(env);
  if (!sharedToken) return fail(503, 'RS token unavailable — try again later');

  const hdrs = buildHeaders(sharedToken);

  const username = (url.searchParams.get('username') || '').trim().replace(/^@/, '');
  if (!username) return fail(400, 'username required');
  if (!/^[a-zA-Z0-9_.-]{1,50}$/.test(username)) return fail(400, 'invalid username');

  // Step 1: resolve username → profile + userId
  const profileRes = await rsGet(`/user/${encodeURIComponent(username)}`, hdrs);
  if (profileRes.status !== 200 || !profileRes.body || typeof profileRes.body !== 'object') {
    return json({ ok: false, username, message: `RS user not found (status ${profileRes.status}).` });
  }

  const profile = profileRes.body;
  const userId = profile?.user?.id || profile?.id || profile?.userId || null;
  const displayName = profile?.user?.name || profile?.name || null;
  const rsUserName = profile?.user?.userName || username;

  if (!userId) {
    return json({ ok: false, username, message: 'Profile found but could not extract userId.', profile });
  }

  // Build a no-auth header set to test truly public endpoints
  const noAuthHdrs = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': 'https://realsports.io',
    'Referer': 'https://realsports.io/',
    'User-Agent': hdrs['User-Agent'],
    'real-device-type': 'desktop_web',
    'real-device-uuid': hdrs['real-device-uuid'],
    'real-version': '31',
  };

  // Try fetching a guest token from RS — unauthenticated visitors to realsports.io
  // might get a limited token where ?userId= is actually respected
  let guestToken = null;
  try {
    const guestR = await rsGet('/users/login/guest', {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Origin': 'https://realsports.io',
      'Referer': 'https://realsports.io/',
      'User-Agent': hdrs['User-Agent'],
      'real-device-type': 'desktop_web',
      'real-device-uuid': hdrs['real-device-uuid'],
      'real-version': '31',
    });
    if (guestR.status === 200 && guestR.body?.token) guestToken = guestR.body.token;
    else if (guestR.status === 200 && guestR.body?.user?.token) guestToken = guestR.body.user.token;
  } catch {}

  const [
    openPosRes,
    perfRes,
    guestOpenPosRes,
  ] = await Promise.all([
    rsGet(`/predictions/openpositions?userId=${userId}`, hdrs),
    rsGet(`/predictions/portfolioperformance?userId=${userId}`, hdrs),
    guestToken
      ? rsGet(`/predictions/openpositions?userId=${userId}`, buildHeaders(guestToken))
      : Promise.resolve({ status: 'skipped', body: 'no guest token' }),
  ]);

  const snapPos = r => {
    if (!r || r.status !== 200) return { status: r?.status };
    const positions = r.body?.positions;
    const first = Array.isArray(positions) ? positions[0] : null;
    return { status: 200, count: Array.isArray(positions) ? positions.length : 'n/a', firstUserId: first?.userId || 'n/a' };
  };

  return json({
    ok: true,
    username: rsUserName,
    userId,
    displayName,
    profile,
    openPositions:        openPosRes?.status === 200 ? openPosRes.body : null,
    portfolioPerformance: perfRes?.status === 200 ? perfRes.body : null,
    _probe: {
      targetUserId: userId,
      guestTokenObtained: !!guestToken,
      guestTokenPrefix: guestToken ? guestToken.slice(0, 12) + '…' : null,
      authedOpenPos:   snapPos(openPosRes),
      guestOpenPos:    snapPos(guestOpenPosRes),
    },
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
