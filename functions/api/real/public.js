import { getSession } from '../../_lib/session.js';
import { checkRateLimit } from '../../_lib/rateLimit.js';
import { hashidsEncode } from '../../_lib/hashids.js';
// functions/api/real/public.js
// GET /api/real/public?username=HANDLE
// Returns RS profile + bet history for any username using shared RS token.
// Uses /predictions/history?userId= (public) for bet history — no user connection required.
// Open positions returned additionally if that user has connected their RS account to RaxEdge.

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
      "SELECT value FROM odds_cache WHERE key='meta:rs_auth_token' LIMIT 1"
    ).first();
    if (row?.value) return row.value;
  } catch {}
  return env.RS_AUTH_TOKEN || env.REAL_AUTH_TOKEN || null;
}

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');

  const url = new URL(request.url);
  const before = url.searchParams.get('before') || null;
  const paramUserId = url.searchParams.get('userId') || null;

  // Pagination requests are cheap (1 RS call) — high limit. Search requests are expensive (3 RS calls) — low limit.
  const rlKey = (before && paramUserId) ? 'real_public_page' : 'real_public_search';
  const rlMax = (before && paramUserId) ? 120 : 10;
  const allowed = await checkRateLimit(env.DB, request, rlKey, rlMax, 60);
  if (!allowed) return fail(429, 'Too many requests');

  const PAGE = `limit=100&pageSize=100&size=100&count=100`;

  // Load-more mode: only fetch next page of history (no profile/activity re-fetch needed)
  if (before && paramUserId) {
    const sharedToken = await getSharedRsToken(env);
    if (!sharedToken) return fail(503, 'RS token unavailable — try again later');
    const hdrs = buildHeaders(sharedToken);
    // Try public history endpoint first; fall back to historyrollup (session-scoped, may not work)
    const [histRes, rollupRes] = await Promise.all([
      rsGet(`/predictions/history?userId=${paramUserId}&${PAGE}&before=${encodeURIComponent(before)}`, hdrs),
      rsGet(`/predictions/historyrollup?userId=${paramUserId}&${PAGE}&before=${encodeURIComponent(before)}`, hdrs),
    ]);
    const betHistory = (histRes.status === 200 && histRes.body) ? histRes.body
                     : (rollupRes.status === 200 && rollupRes.body) ? rollupRes.body
                     : null;
    return json({ ok: true, betHistory, _dbg: { histStatus: histRes.status, rollupStatus: rollupRes.status } });
  }

  const username = (url.searchParams.get('username') || '').trim().replace(/^@/, '');
  if (!username) return fail(400, 'username required');
  if (!/^[a-zA-Z0-9_.-]{1,50}$/.test(username)) return fail(400, 'invalid username');

  const sharedToken = await getSharedRsToken(env);
  if (!sharedToken) return fail(503, 'RS token unavailable — try again later');

  const hdrs = buildHeaders(sharedToken);

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

  // Step 2: look up whether this RS user has connected their account to RaxEdge
  let userRow = await env.DB.prepare(
    `SELECT auth_token, device_uuid FROM real_auth
     WHERE (LOWER(rs_username) = LOWER(?) OR rs_user_id = ?)
       AND auth_token IS NOT NULL
     LIMIT 1`
  ).bind(username, userId).first();

  // Fallback for existing token-connects where rs_user_id was never stored:
  // check if the session user's own token prefix matches this RS userId
  if (!userRow) {
    const sessionRow = await env.DB.prepare(
      `SELECT auth_token, device_uuid FROM real_auth
       WHERE user_id = ? AND auth_token IS NOT NULL LIMIT 1`
    ).bind(session.user_id).first();
    if (sessionRow && sessionRow.auth_token.startsWith(userId + '!')) {
      userRow = sessionRow;
      // Self-heal: store rs_user_id for future lookups
      await env.DB.prepare(
        `UPDATE real_auth SET rs_user_id = ? WHERE user_id = ? AND rs_user_id IS NULL`
      ).bind(userId, session.user_id).run().catch(() => {});
    }
  }

  // Step 3: parallel fetches
  // - activity + betHistory: public endpoints, use shared token, work for any userId
  // - openPositions: session-scoped, requires the searched user's own stored token
  const userHdrs = userRow ? buildHeaders(userRow.auth_token, userRow.device_uuid || undefined) : null;

  const [activityRes, publicHistRes, rollupRes, openPosRes] = await Promise.all([
    rsGet(`/activity?userId=${userId}`, hdrs),
    rsGet(`/predictions/history?userId=${userId}&${PAGE}`, hdrs),
    rsGet(`/predictions/historyrollup?userId=${userId}&${PAGE}`, hdrs),
    userHdrs ? rsGet('/predictions/openpositions', userHdrs) : Promise.resolve(null),
  ]);

  // Use /predictions/history (public, respects userId) if it returned items.
  // Fall back to historyrollup only if the user has their own token stored (session-scoped).
  const publicHistOk = publicHistRes?.status === 200 && publicHistRes.body &&
                       typeof publicHistRes.body === 'object';
  const rollupOk     = rollupRes?.status === 200 && rollupRes.body &&
                       typeof rollupRes.body === 'object' && userHdrs;
  const betHistory   = publicHistOk ? publicHistRes.body
                     : rollupOk     ? rollupRes.body
                     : null;

  return json({
    ok: true,
    username: rsUserName,
    userId,
    displayName,
    profile,
    activity:      activityRes?.status === 200 ? activityRes.body : null,
    betHistory,
    openPositions: openPosRes?.status === 200 ? openPosRes.body : null,
    isConnected:   !!userRow,
    _dbg: {
      publicHistStatus: publicHistRes?.status,
      rollupStatus:     rollupRes?.status,
      publicHistItems:  publicHistOk ? (publicHistRes.body.items?.length ?? 'no items key') : null,
      rollupItems:      rollupOk     ? (rollupRes.body.items?.length ?? 'no items key')     : null,
    }
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
