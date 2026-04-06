// functions/api/real/public.js
// GET /api/real/public?username=HANDLE
// Probes Real Sports public API for a given username — no auth required.
// Returns whatever public data is accessible (profile, predictions, leaderboard, etc.)

function hashidsEncode(number) {
  const saltChars = Array.from('realwebapp');
  const keepUnique = c => [...new Set(c)];
  const without = (c, x) => c.filter(ch => !x.includes(ch));
  const only = (c, k) => c.filter(ch => k.includes(ch));
  function shuffle(alpha, salt) {
    if (!salt.length) return alpha;
    let int, t = [...alpha];
    for (let i = t.length - 1, v = 0, p = 0; i > 0; i--, v++) {
      v %= salt.length; p += int = salt[v].codePointAt(0);
      const j = (int + v + p) % i; [t[i], t[j]] = [t[j], t[i]];
    }
    return t;
  }
  function toAlpha(n, alpha) {
    const id = []; let v = n;
    do { id.unshift(alpha[v % alpha.length]); v = Math.floor(v / alpha.length); } while (v > 0);
    return id;
  }
  let alpha = Array.from('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890');
  let seps = Array.from('cfhistuCFHISTU');
  const uniq = keepUnique(alpha);
  alpha = without(uniq, seps);
  seps = shuffle(only(seps, uniq), saltChars);
  if (!seps.length || alpha.length / seps.length > 3.5) {
    const sl = Math.ceil(alpha.length / 3.5);
    if (sl > seps.length) { seps.push(...alpha.slice(0, sl - seps.length)); alpha = alpha.slice(sl - seps.length); }
  }
  alpha = shuffle(alpha, saltChars);
  const gc = Math.ceil(alpha.length / 12);
  let guards;
  if (alpha.length < 3) { guards = seps.slice(0, gc); seps = seps.slice(gc); }
  else { guards = alpha.slice(0, gc); alpha = alpha.slice(gc); }
  const numId = number % 100;
  let ret = [alpha[numId % alpha.length]];
  const lottery = [...ret];
  alpha = shuffle(alpha, lottery.concat(saltChars, alpha));
  ret.push(...toAlpha(number, alpha));
  if (ret.length < 16) ret.unshift(guards[(numId + ret[0].codePointAt(0)) % guards.length]);
  if (ret.length < 16) ret.push(guards[(numId + ret[2].codePointAt(0)) % guards.length]);
  const half = Math.floor(alpha.length / 2);
  while (ret.length < 16) {
    alpha = shuffle(alpha, alpha);
    ret.unshift(...alpha.slice(half)); ret.push(...alpha.slice(0, half));
    const ex = ret.length - 16;
    if (ex > 0) ret = ret.slice(ex / 2, ex / 2 + 16);
  }
  return ret.join('');
}

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

export async function onRequestGet({ request }) {
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
