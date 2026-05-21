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
  return rsGetUrl(`${BASE}${path}`, hdrs, timeoutMs);
}

async function rsGetUrl(url, hdrs, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: hdrs, signal: ctrl.signal });
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

  // Step 3: try fetching open positions in order of preference
  let positions = null;
  let positionsSource = null;

  // 3a. User has connected their RS account — use their own token (best accuracy)
  if (userToken) {
    const userHdrs = buildHeaders(userToken, userDeviceUuid || undefined);
    const posRes = await rsGet('/predictions/openpositions', userHdrs);
    if (posRes.status === 200 && posRes.body) {
      positions = posRes.body;
      positionsSource = 'connected';
    }
  }

  // 3b. Try public / no-auth paths — RS may expose positions without auth for public profiles
  if (!positions) {
    const noAuthHdrs = {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Origin': 'https://realsports.io',
      'Referer': `https://realsports.io/user/${username}`,
    };

    // Candidates based on network analysis of Justin's site (meowbot-ap... backend calls /activity)
    // His backend hits RS with a shared token — "activity" is the key term
    const publicCandidates = [
      // activity-style paths (new — based on Justin's /activity endpoint name)
      { url: `https://web.realapp.com/user/${userId}/activity`, hdrs: sharedHdrs },
      { url: `https://web.realapp.com/user/${username}/activity`, hdrs: sharedHdrs },
      { url: `https://web.realapp.com/activity?userId=${userId}`, hdrs: sharedHdrs },
      { url: `https://web.realapp.com/activity/user/${userId}`, hdrs: sharedHdrs },
      { url: `https://web.realapp.com/predictions/activity?userId=${userId}`, hdrs: sharedHdrs },
      { url: `https://web.realapp.com/user/${userId}/activity?type=predictions`, hdrs: sharedHdrs },
      { url: `https://web.realapp.com/user/${userId}/activity?type=open`, hdrs: sharedHdrs },
      // cross-user open positions (shared token, other user's ID)
      { url: `https://web.realapp.com/user/${userId}/openpositions`, hdrs: sharedHdrs },
      { url: `https://web.realapp.com/user/${userId}/predictions/open`, hdrs: sharedHdrs },
      { url: `https://web.realapp.com/predictions/openpositions?targetUserId=${userId}`, hdrs: sharedHdrs },
      { url: `https://web.realapp.com/user/${userId}/feed`, hdrs: sharedHdrs },
      { url: `https://web.realapp.com/user/${userId}/stats`, hdrs: sharedHdrs },
      // no auth at all
      { url: `https://web.realapp.com/user/${userId}/activity`, hdrs: noAuthHdrs },
      { url: `https://web.realapp.com/user/${userId}/openpositions`, hdrs: noAuthHdrs },
    ];

    const publicResults = await Promise.all(
      publicCandidates.map(({ url, hdrs }) =>
        rsGetUrl(url, hdrs).then(r => ({ url, status: r.status, body: r.body }))
      )
    );

    const publicHit = publicResults.find(r => r.status === 200 && r.body && typeof r.body === 'object');
    if (publicHit) {
      positions = publicHit.body;
      positionsSource = `public:${publicHit.url}`;
    }

    // Return probe results for debugging when no public hit found
    if (!publicHit) {
      return json({
        ok: true,
        username: rsUserName,
        userId,
        displayName: rsDisplayName,
        positions: null,
        positionsSource: null,
        isConnected: !!userToken,
        publicProbe: publicResults.map(r => ({
          url: r.url,
          status: r.status,
          bodySnippet: typeof r.body === 'string' ? r.body.slice(0, 100) : (r.body ? JSON.stringify(r.body).slice(0, 100) : null)
        }))
      });
    }
  }

  return json({
    ok: true,
    username: rsUserName,
    userId,
    displayName: rsDisplayName,
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
