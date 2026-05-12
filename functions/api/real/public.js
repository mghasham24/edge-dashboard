import { getSession } from '../../_lib/session.js';
import { checkRateLimit } from '../../_lib/rateLimit.js';
import { hashidsEncode } from '../../_lib/hashids.js';
// functions/api/real/public.js
// GET /api/real/public?username=HANDLE
// Probes Real Sports public API for a given username.
// Requires a valid session to prevent use as an anonymous RS API relay.

function buildPublicHeaders() {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
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

async function tryFetch(url, headers, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
    return { status: res.status, body };
  } catch (e) {
    clearTimeout(timer);
    return { status: e.name === 'AbortError' ? 'timeout' : 'err', body: e.message };
  }
}

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');

  // 10 lookups per minute per IP — prevents use as anonymous RS relay
  const allowed = await checkRateLimit(env.DB, request, 'real_public', 10, 60);
  if (!allowed) return fail(429, 'Too many requests');

  const url = new URL(request.url);
  const username = (url.searchParams.get('username') || '').trim().replace(/^@/, '');

  if (!username) return fail(400, 'username required');
  if (!/^[a-zA-Z0-9_.-]{1,50}$/.test(username)) return fail(400, 'invalid username');

  const hdrs = buildPublicHeaders();
  const base = 'https://web.realapp.com';

  // Probe all likely public endpoints in parallel
  const candidates = [
    `/users/username/${username}`,
    `/users/${username}`,
    `/user/username/${username}`,
    `/user/${username}`,
    `/profiles/${username}`,
    `/profile/${username}`,
    `/accounts/username/${username}`,
    `/accounts/${username}`,
  ];

  const results = await Promise.all(
    candidates.map(async path => {
      const r = await tryFetch(`${base}${path}`, hdrs, 4000);
      return { path, status: r.status, body: r.status === 200 ? r.body : null };
    })
  );

  // Find any 200s
  const hits = results.filter(r => r.status === 200);

  if (!hits.length) {
    // Return the probe results so the frontend can inform the user
    return json({
      ok: false,
      username,
      message: 'No public profile found for this username.',
      probe: results.map(r => ({ path: r.path, status: r.status }))
    });
  }

  // Grab the first hit — likely the user profile
  const profile = hits[0];

  // If we have a profile/userId, try fetching public predictions too
  const userId = profile.body?.id || profile.body?.userId || profile.body?.user?.id || null;
  let predictions = null;

  if (userId) {
    const predPaths = [
      `/users/${userId}/predictions`,
      `/predictions/user/${userId}`,
      `/users/${userId}/positions`,
      `/users/${userId}/historyrollup`,
    ];
    const predResults = await Promise.all(
      predPaths.map(p => tryFetch(`${base}${p}`, hdrs, 4000))
    );
    const predHit = predResults.find(r => r.status === 200);
    if (predHit) predictions = predHit.body;
  }

  return json({
    ok: true,
    username,
    userId,
    profile: profile.body,
    profilePath: profile.path,
    predictions,
    allHits: hits.map(h => ({ path: h.path, status: h.status }))
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
