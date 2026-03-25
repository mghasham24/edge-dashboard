// functions/api/real/markets.js
// Proxies Real Sports market data with proper auth headers

// ── Hashids implementation (salt: 'realwebapp') ───────
const keepUnique = (c) => [...new Set(c)];
const withoutChars = (c, x) => c.filter(ch => !x.includes(ch));
const onlyChars = (c, k) => c.filter(ch => k.includes(ch));
const isInt = (n) => typeof n === 'bigint' || (!Number.isNaN(Number(n)) && Math.floor(Number(n)) === n);
const isPos = (n) => typeof n === 'bigint' || (n >= 0 && Number.isSafeInteger(n));

function shuffle(alpha, salt) {
  if (!salt.length) return alpha;
  let integer, t = [...alpha];
  for (let i = t.length - 1, v = 0, p = 0; i > 0; i--, v++) {
    v %= salt.length;
    p += integer = salt[v].codePointAt(0);
    const j = (integer + v + p) % i;
    [t[i], t[j]] = [t[j], t[i]];
  }
  return t;
}

function toAlpha(input, alpha) {
  const id = [];
  let val = input;
  do {
    id.unshift(alpha[val % alpha.length]);
    val = Math.floor(val / alpha.length);
  } while (val > 0);
  return id;
}

function hashidsEncode(number, salt = 'realwebapp', minLen = 16) {
  const saltChars = Array.from(salt);
  let alpha = Array.from('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890');
  let seps  = Array.from('cfhistuCFHISTU');
  alpha = withoutChars(keepUnique(alpha), seps);
  seps  = shuffle(onlyChars(seps, keepUnique(Array.from('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'))), saltChars);
  if (!seps.length || alpha.length / seps.length > 3.5) {
    const sepsLen = Math.ceil(alpha.length / 3.5);
    if (sepsLen > seps.length) { seps.push(...alpha.slice(0, sepsLen - seps.length)); alpha = alpha.slice(sepsLen - seps.length); }
  }
  alpha = shuffle(alpha, saltChars);
  const guardCount = Math.ceil(alpha.length / 12);
  let guards, ret;
  if (alpha.length < 3) { guards = seps.slice(0, guardCount); seps = seps.slice(guardCount); }
  else { guards = alpha.slice(0, guardCount); alpha = alpha.slice(guardCount); }

  const numbers = [number];
  const numbersIdInt = numbers.reduce((last, n, i) => last + n % (i + 100), 0);
  ret = [alpha[numbersIdInt % alpha.length]];
  const lottery = [...ret];
  numbers.forEach((n, i) => {
    alpha = shuffle(alpha, lottery.concat(saltChars, alpha));
    const last = toAlpha(n, alpha);
    ret.push(...last);
    if (i + 1 < numbers.length) {
      const charCode = last[0].codePointAt(0) + i;
      ret.push(seps[(n % charCode) % seps.length]);
    }
  });
  if (ret.length < minLen) {
    ret.unshift(guards[(numbersIdInt + ret[0].codePointAt(0)) % guards.length]);
    if (ret.length < minLen) ret.push(guards[(numbersIdInt + ret[2].codePointAt(0)) % guards.length]);
  }
  const half = Math.floor(alpha.length / 2);
  while (ret.length < minLen) {
    alpha = shuffle(alpha, alpha);
    ret.unshift(...alpha.slice(half));
    ret.push(...alpha.slice(0, half));
    const excess = ret.length - minLen;
    if (excess > 0) ret = ret.slice(excess / 2, excess / 2 + minLen);
  }
  return ret.join('');
}

// ── Session middleware ────────────────────────────────
async function getSession(request, db) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return null;
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    'SELECT u.id as user_id, u.plan FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(m[1], now).first();
}

// ── Handler ───────────────────────────────────────────
export async function onRequestGet({ request, env }) {
  // Auth check
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');

  const url    = new URL(request.url);
  const sport  = url.searchParams.get('sport');
  const gameId = url.searchParams.get('gameId');

  if (!sport || !gameId) return fail(400, 'Missing sport or gameId');
  if (!env.REAL_AUTH_TOKEN) return fail(500, 'Real Sports integration not configured');

  const realUrl = `https://web.realapp.com/predictions/game/${sport}/${gameId}/markets`;

  try {
    const res = await fetch(realUrl, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': 'https://realsports.io',
        'Referer': 'https://realsports.io/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'real-auth-info': env.REAL_AUTH_TOKEN,
        'real-device-name': 'Chrome on Windows',
        'real-device-type': 'desktop_web',
        'real-device-uuid': '2e0a38e2-0ee8-4f93-9a34-218ac1d10161',
        'real-request-token': hashidsEncode(Date.now()),
        'real-version': '28'
      }
    });

    if (!res.ok) return fail(res.status, 'Real Sports API error');
    const data = await res.json();

    // Extract just what we need: market label + probabilities per outcome
    const markets = (data.markets || []).map(m => ({
      label: m.label,
      outcomes: (m.outcomes || []).map(o => ({
        key: o.key,
        label: o.label,
        probability: o.probability,
        priceLabel: o.priceLabel
      }))
    }));

    return new Response(JSON.stringify({ ok: true, markets }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch(e) {
    return fail(500, 'Failed to fetch Real Sports data');
  }
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
