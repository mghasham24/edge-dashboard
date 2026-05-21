import { getSession } from '../../_lib/session.js';
import { checkRateLimit } from '../../_lib/rateLimit.js';
import { hashidsEncode } from '../../_lib/hashids.js';
// functions/api/real/public.js
// GET /api/real/public?username=HANDLE
// Probes Real Sports public API for a given username (no RS auth token needed).
// Requires a valid RaxEdge session to prevent anonymous RS relay abuse.

const RS_BASES = [
  'https://web.realapp.com',
  'https://api.realapp.tools',
  'https://realapp.tools',
];

function buildRsHeaders() {
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

// Minimal headers — what a public endpoint would accept without auth
function buildPublicHeaders() {
  return {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'Origin': 'https://realsports.io',
    'Referer': 'https://realsports.io/',
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
    try { body = JSON.parse(text); } catch { body = text.slice(0, 500); }
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

  const rsHdrs = buildRsHeaders();
  const pubHdrs = buildPublicHeaders();

  // Username-based profile paths to try across all bases
  const profilePaths = [
    `/users/username/${username}`,
    `/users/${username}`,
    `/user/username/${username}`,
    `/user/${username}`,
    `/profiles/username/${username}`,
    `/profiles/${username}`,
    `/profile/${username}`,
    `/accounts/username/${username}`,
    `/accounts/${username}`,
    `/v1/users/username/${username}`,
    `/v2/users/username/${username}`,
  ];

  // Try all bases × all paths × both header sets in parallel
  const probes = [];
  for (const base of RS_BASES) {
    for (const path of profilePaths) {
      const fullUrl = `${base}${path}`;
      // RS-authenticated headers
      probes.push(tryFetch(fullUrl, rsHdrs, 4000).then(r => ({ url: fullUrl, base, path, hdrs: 'rs', ...r })));
      // Public (no real-* headers)
      probes.push(tryFetch(fullUrl, pubHdrs, 4000).then(r => ({ url: fullUrl, base, path, hdrs: 'pub', ...r })));
    }
  }

  const results = await Promise.all(probes);
  const hits = results.filter(r => r.status === 200 && r.body && typeof r.body === 'object');

  if (!hits.length) {
    return json({
      ok: false,
      username,
      message: 'No public profile found for this username.',
      probe: results.map(r => ({ url: r.url, hdrs: r.hdrs, status: r.status, bodySnippet: typeof r.body === 'string' ? r.body.slice(0, 80) : null }))
    });
  }

  const profile = hits[0];
  const userId = profile.body?.id || profile.body?.userId || profile.body?.user?.id || null;

  let positions = null;
  if (userId) {
    const posPaths = [
      `/users/${userId}/positions`,
      `/users/${userId}/predictions`,
      `/users/${userId}/open-positions`,
      `/users/${userId}/active-positions`,
      `/predictions/user/${userId}`,
      `/positions/user/${userId}`,
      `/users/${userId}/historyrollup`,
      `/v1/users/${userId}/positions`,
      `/v2/users/${userId}/positions`,
    ];
    // Also try username-based position paths (some APIs skip the userId lookup)
    const usernamePosPaths = [
      `/users/username/${username}/positions`,
      `/users/username/${username}/predictions`,
    ];

    const posProbes = [];
    for (const base of RS_BASES) {
      for (const p of [...posPaths, ...usernamePosPaths]) {
        posProbes.push(tryFetch(`${base}${p}`, rsHdrs, 4000).then(r => ({ url: `${base}${p}`, hdrs: 'rs', ...r })));
        posProbes.push(tryFetch(`${base}${p}`, pubHdrs, 4000).then(r => ({ url: `${base}${p}`, hdrs: 'pub', ...r })));
      }
    }
    const posResults = await Promise.all(posProbes);
    const posHit = posResults.find(r => r.status === 200 && r.body && typeof r.body === 'object');
    if (posHit) {
      positions = { data: posHit.body, url: posHit.url, hdrs: posHit.hdrs };
    }
  }

  return json({
    ok: true,
    username,
    userId,
    profile: profile.body,
    profileUrl: profile.url,
    profileHdrs: profile.hdrs,
    positions,
    allProfileHits: hits.map(h => ({ url: h.url, hdrs: h.hdrs }))
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
