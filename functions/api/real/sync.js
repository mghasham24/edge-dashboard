// functions/api/real/sync.js
// Fetches all Real Sports games + markets for a sport, returns { gameKey -> markets }
// gameKey format: "LAL @ IND" to match FanDuel game strings

// ── Hashids ───────────────────────────────────────────
function hashidsEncode(number) {
  const saltChars = Array.from('realwebapp');
  const minLen = 16;
  const keepUnique = c => [...new Set(c)];
  const without = (c, x) => c.filter(ch => !x.includes(ch));
  const only = (c, k) => c.filter(ch => k.includes(ch));

  function shuffle(alpha, salt) {
    if (!salt.length) return alpha;
    let int, t = [...alpha];
    for (let i = t.length-1, v=0, p=0; i>0; i--, v++) {
      v %= salt.length;
      p += int = salt[v].codePointAt(0);
      const j = (int+v+p) % i;
      [t[i],t[j]] = [t[j],t[i]];
    }
    return t;
  }

  function toAlpha(n, alpha) {
    const id=[]; let v=n;
    do { id.unshift(alpha[v%alpha.length]); v=Math.floor(v/alpha.length); } while(v>0);
    return id;
  }

  let alpha = Array.from('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890');
  let seps  = Array.from('cfhistuCFHISTU');
  const uniq = keepUnique(alpha);
  alpha = without(uniq, seps);
  seps  = shuffle(only(seps, uniq), saltChars);
  if (!seps.length || alpha.length/seps.length > 3.5) {
    const sl = Math.ceil(alpha.length/3.5);
    if (sl > seps.length) { seps.push(...alpha.slice(0,sl-seps.length)); alpha=alpha.slice(sl-seps.length); }
  }
  alpha = shuffle(alpha, saltChars);
  const gc = Math.ceil(alpha.length/12);
  let guards;
  if (alpha.length < 3) { guards=seps.slice(0,gc); seps=seps.slice(gc); }
  else { guards=alpha.slice(0,gc); alpha=alpha.slice(gc); }

  const numId = number % 100;
  let ret = [alpha[numId % alpha.length]];
  const lottery = [...ret];
  alpha = shuffle(alpha, lottery.concat(saltChars, alpha));
  ret.push(...toAlpha(number, alpha));
  if (ret.length < minLen) ret.unshift(guards[(numId+ret[0].codePointAt(0)) % guards.length]);
  if (ret.length < minLen) ret.push(guards[(numId+ret[2].codePointAt(0)) % guards.length]);
  const half = Math.floor(alpha.length/2);
  while (ret.length < minLen) {
    alpha = shuffle(alpha, alpha);
    ret.unshift(...alpha.slice(half));
    ret.push(...alpha.slice(0,half));
    const ex = ret.length-minLen;
    if (ex>0) ret=ret.slice(ex/2, ex/2+minLen);
  }
  return ret.join('');
}

// ── Auth headers ──────────────────────────────────────
function buildHeaders(env) {
  return {
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
  };
}

// ── Sport key mapping ─────────────────────────────────
const SPORT_MAP = {
  'basketball_nba': 'nba',
  'icehockey_nhl': 'nhl',
  'baseball_mlb': 'mlb',
  'basketball_ncaab': 'ncaab',
  'mma_mixed_martial_arts': 'mma',
  'soccer_epl': 'epl',
  'soccer_uefa_champs_league': 'ucl'
};

// ── Session check ─────────────────────────────────────
async function getSession(request, db) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return null;
  const now = Math.floor(Date.now()/1000);
  return db.prepare(
    'SELECT u.id as user_id, u.plan FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(m[1], now).first();
}

// ── Main handler ──────────────────────────────────────
export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');
  if (!env.REAL_AUTH_TOKEN) return fail(500, 'Real Sports integration not configured');

  const url   = new URL(request.url);
  const fdKey = url.searchParams.get('sport'); // FanDuel sport key e.g. basketball_nba
  const realSport = SPORT_MAP[fdKey] || fdKey;

  try {
    // Step 1: Get all games for this sport
    const nextRes = await fetch(`https://web.realapp.com/home/${realSport}/next?cohort=0`, {
      headers: buildHeaders(env)
    });
    if (!nextRes.ok) return fail(nextRes.status, 'Failed to fetch Real Sports games');
    const nextData = await nextRes.json();

    // Extract games array - try common response shapes
    const games = nextData.games || nextData.data?.games || nextData.items || [];
    if (!games.length) return new Response(JSON.stringify({ ok: true, markets: {} }), {
      headers: { 'Content-Type': 'application/json' }
    });

    // Step 2: Fetch markets for each game in parallel
    const marketResults = await Promise.allSettled(
      games.map(async (game) => {
        const gameId = game.id || game.gameId;
        const awayKey = game.awayTeamKey || game.awayTeam?.key;
        const homeKey = game.homeTeamKey || game.homeTeam?.key;
        if (!gameId || !awayKey || !homeKey) return null;

        const mRes = await fetch(
          `https://web.realapp.com/predictions/game/${realSport}/${gameId}/markets`,
          { headers: buildHeaders(env) }
        );
        if (!mRes.ok) return null;
        const mData = await mRes.json();

        // Build gameKey matching FanDuel format: "LAL @ IND"
        const gameKey = `${awayKey} @ ${homeKey}`;

        // Map markets to { label -> { outcomes } }
        const markets = {};
        for (const m of (mData.markets || [])) {
          markets[m.label] = m.outcomes.map(o => ({
            key: o.key,
            label: o.label,
            probability: o.probability,
            pct: Math.round(o.probability * 100)
          }));
        }

        return { gameKey, markets };
      })
    );

    // Assemble result map: { "LAL @ IND": { "Game Winner": [...], "Spread": [...], "Total": [...] } }
    const result = {};
    for (const r of marketResults) {
      if (r.status === 'fulfilled' && r.value) {
        result[r.value.gameKey] = r.value.markets;
      }
    }

    return new Response(JSON.stringify({ ok: true, markets: result }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60' // cache 60s to avoid hammering
      }
    });

  } catch(e) {
    return fail(500, 'Real Sports sync failed: ' + e.message);
  }
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
