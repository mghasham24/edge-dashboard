import { getSession } from '../../_lib/session.js';
import { checkRateLimit } from '../../_lib/rateLimit.js';
import { hashidsEncode } from '../../_lib/hashids.js';
// functions/api/real/public.js
// GET /api/real/public?username=HANDLE
// Resolves an RS username to their profile and open positions.
// Positions are only returned when that user has connected their RS account to RaxEdge.
// Requires a valid RaxEdge session.

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

async function getSharedRsToken(env) {
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

  const sharedToken = await getSharedRsToken(env);
  if (!sharedToken) return fail(503, 'RS token unavailable — try again later');

  const sharedHdrs = buildHeaders(sharedToken);

  // Step 1: resolve username → profile (using shared token)
  const r = await rsGet(`/user/${encodeURIComponent(username)}`, sharedHdrs);
  if (r.status !== 200 || !r.body || typeof r.body !== 'object') {
    return json({ ok: false, username, message: `RS profile not found (status ${r.status}).` });
  }

  const profile = r.body;
  const userId =
    profile?.user?.id ||
    profile?.id ||
    profile?.userId ||
    null;

  const rsDisplayName = profile?.user?.name || profile?.name || null;
  const rsUserName = profile?.user?.userName || username;

  if (!userId) {
    return json({ ok: false, username, message: 'Profile found but could not extract userId.', profile });
  }

  // Step 2: check if this RS user has connected their account to RaxEdge
  // Match by rs_username (case-insensitive) or rs_user_id
  let userToken = null;
  let userDeviceUuid = null;
  try {
    const authRow = await env.DB.prepare(
      `SELECT auth_token, device_uuid FROM real_auth
       WHERE (LOWER(rs_username) = LOWER(?) OR rs_user_id = ?)
         AND auth_token IS NOT NULL
       LIMIT 1`
    ).bind(username, userId).first();
    if (authRow) {
      userToken = authRow.auth_token;
      userDeviceUuid = authRow.device_uuid;
    }
  } catch {}

  // Step 3: fetch open positions using the user's own token (if connected)
  let positions = null;
  let positionsSource = null;

  if (userToken) {
    const userHdrs = buildHeaders(userToken, userDeviceUuid || undefined);
    const posRes = await rsGet('/predictions/openpositions', userHdrs);
    if (posRes.status === 200 && posRes.body) {
      positions = posRes.body;
      positionsSource = 'connected';
    }
  }

  return json({
    ok: true,
    username: rsUserName,
    userId,
    displayName: rsDisplayName,
    profile,
    positions,
    positionsSource,
    isConnected: !!userToken
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
