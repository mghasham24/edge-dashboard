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

  // Get token holder's own open positions — we need their sharedPositionIds to test cross-user access
  const myOpenPos = await rsGet(`/predictions/openpositions`, hdrs);
  const myPositions = myOpenPos?.body?.positions || [];
  const myPosId = myPositions[0]?.sharedPositionId || null;

  // Cross-user test: pick an ID just below ours — global sequential, likely a different user
  const crossId = myPosId ? String(parseInt(myPosId) - 3) : null;

  const [
    openPosRes,
    perfRes,
    myPosRes,
    crossPosRes,
    // Feed/group endpoints — how Justin discovers position IDs per user
    feedRes,
    groupFeedRes,
    trendingRes,
  ] = await Promise.all([
    rsGet(`/predictions/openpositions?userId=${userId}`, hdrs),
    rsGet(`/predictions/portfolioperformance?userId=${userId}`, hdrs),
    myPosId ? rsGet(`/predictions/position/${myPosId}`, hdrs) : Promise.resolve(null),
    crossId  ? rsGet(`/predictions/position/${crossId}`,  hdrs) : Promise.resolve(null),
    rsGet(`/feed`, hdrs),
    rsGet(`/group/61979/posts?limit=3`, hdrs),
    rsGet(`/predictions/trending`, hdrs),
  ]);

  const snapPos = r => {
    if (!r) return null;
    if (r.status !== 200) return { status: r?.status };
    const uid = r.body?.position?.user?.id || r.body?.position?.userId || 'n/a';
    return { status: 200, positionUserId: uid, topKeys: Object.keys(r.body || {}).slice(0,6) };
  };
  const snapFeed = r => {
    if (!r || r.status !== 200) return { status: r?.status };
    const b = r.body;
    const items = b?.posts || b?.items || b?.data || (Array.isArray(b) ? b : null);
    const first = Array.isArray(items) ? items[0] : null;
    return { status: 200, topKeys: Object.keys(b||{}).slice(0,8), firstKeys: first ? Object.keys(first).slice(0,10) : null };
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
      myPosId,
      crossId,
      myPos:    snapPos(myPosRes),
      crossPos: snapPos(crossPosRes),
      feed:     snapFeed(feedRes),
      groupFeed:    snapFeed(groupFeedRes),
      trending:     snapFeed(trendingRes),
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
