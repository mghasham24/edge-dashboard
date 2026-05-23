// vps-rs-sync/index.js
// Runs on the Hetzner VPS. Fetches RS game/market data through a residential
// proxy every 90s and POSTs it to /api/real/sync — replacing the browser
// TM bridge so D1 stays fresh even when Mac is off.
//
// Required env vars:
//   RS_AUTH_INFO  — RS auth token: userId!deviceId!token
//   RS_DEVICE_UUID — RS device UUID
//   SITE_URL      — RaxEdge URL, e.g. https://raxedge.com
//   SYNC_KEY      — TM push key (rax-bridge-9w2k5j7n)
//   RS_PROXY_URL  — residential proxy e.g. http://user:pass@host:port

import { ProxyAgent } from 'undici';

const RS_AUTH_INFO  = process.env.RS_AUTH_INFO;
const DEVICE_UUID   = process.env.RS_DEVICE_UUID || 'ErpZd4OA';
const SITE_URL      = process.env.SITE_URL;
const SYNC_KEY      = process.env.SYNC_KEY || 'rax-bridge-9w2k5j7n';
const RS_PROXY_URL  = process.env.RS_PROXY_URL || null;
const SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL_MS || '90000');

const RS_BASE  = 'https://web.realapp.com';
const SYNC_URL = `${SITE_URL}/api/real/sync?_tm_key=${SYNC_KEY}`;

const rsDispatcher = RS_PROXY_URL ? new ProxyAgent(RS_PROXY_URL) : undefined;

// Sports to sync: [fdKey, rsSport]
const SPORTS = [
  ['basketball_nba',   'nba'],
  ['icehockey_nhl',    'nhl'],
  ['baseball_mlb',     'mlb'],
  ['basketball_wnba',  'wnba'],
  ['soccer_fc',        'soccer'],
];

// ── RS request token (hashids, 'realwebapp' salt) ──────

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
      v %= salt.length; p += int = salt[v].codePointAt(0);
      const j = (int+v+p) % i; [t[i],t[j]] = [t[j],t[i]];
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
    ret.unshift(...alpha.slice(half)); ret.push(...alpha.slice(0,half));
    const ex = ret.length-minLen;
    if (ex>0) ret=ret.slice(ex/2, ex/2+minLen);
  }
  return ret.join('');
}

// ── RS API helpers ─────────────────────────────────────

function rsHeaders() {
  return {
    'Accept':             'application/json',
    'Accept-Encoding':    'gzip, deflate, br',
    'Accept-Language':    'en-US,en;q=0.9',
    'Cache-Control':      'max-age=0',
    'Content-Type':       'application/json',
    'Origin':             'https://realsports.io',
    'Referer':            'https://realsports.io/',
    'Sec-Fetch-Dest':     'empty',
    'Sec-Fetch-Mode':     'cors',
    'Sec-Fetch-Site':     'cross-site',
    'User-Agent':         'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-auth-info':     RS_AUTH_INFO,
    'real-device-name':   '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-device-type':   'desktop_web',
    'real-device-uuid':   DEVICE_UUID,
    'real-request-token': hashidsEncode(Date.now()),
    'real-version':       '32',
  };
}

function rsFetch(url) {
  return fetch(url, {
    headers:    rsHeaders(),
    dispatcher: rsDispatcher,
    signal:     AbortSignal.timeout(12000),
  });
}

// ── Data extraction (mirrors TM bridge logic) ──────────

function extractGames(data) {
  const seen = {}, games = [];
  function add(g) {
    if (!g) return;
    const id = g.id || g.gameId;
    if (!id || seen[id]) return;
    if (g.isClosed) return;
    const s = g.status;
    if (s === 'final' || s === 'closed' || s === 'completed') return;
    seen[id] = true; games.push(g);
  }
  function addArr(arr) { if (Array.isArray(arr)) arr.forEach(add); }
  addArr(data.games); addArr(data.data); addArr(data.items); addArr(data.predictions);
  if (data.latestDayContent) {
    const lcd = data.latestDayContent;
    addArr(lcd.games || lcd.predictions || lcd.items || lcd.events);
  }
  return games;
}

function buildGameKey(game) {
  const fighters = game.fighters || game.athletes || game.players;
  const away = (game.awayTeam && game.awayTeam.name) || game.awayTeamKey
            || (fighters && fighters[0] && (fighters[0].name || fighters[0].displayName));
  const home = (game.homeTeam && game.homeTeam.name) || game.homeTeamKey
            || (fighters && fighters[1] && (fighters[1].name || fighters[1].displayName));
  return (away && home) ? (away + ' @ ' + home) : null;
}

function parseMarkets(game, mData) {
  const fighters = game.fighters || game.athletes || game.players;
  const keyToName = {};
  if (game.awayTeam) keyToName[game.awayTeam.key] = game.awayTeam.name;
  if (game.homeTeam) keyToName[game.homeTeam.key] = game.homeTeam.name;
  if (fighters) fighters.forEach(f => {
    if (f.key && (f.name || f.displayName)) keyToName[f.key] = f.name || f.displayName;
  });
  const markets = {};
  (mData.markets || []).forEach(mk => {
    const volStr = String(mk.volumeDisplay || '');
    const volNum = volStr.endsWith('k') ? parseFloat(volStr) * 1000
                 : volStr.endsWith('m') ? parseFloat(volStr) * 1000000
                 : parseFloat(volStr) || 0;
    markets[mk.label] = {
      id: mk.id,
      volume: volNum, volumeDisplay: volStr,
      outcomes: (mk.outcomes || []).map(o => {
        const m = (o.label || '').match(/([+-]?\d+\.?\d*)\s*$/);
        return {
          key: o.key,
          label: keyToName[o.label] || keyToName[o.key] || o.label,
          probability: o.probability,
          pct: Math.round(o.probability * 100),
          line: m ? parseFloat(m[1]) : null,
        };
      }),
    };
  });
  return markets;
}

function extractLines(mData) {
  const lines = {};
  const spreadMkt = (mData.markets || []).find(m => m.label === 'Spread');
  if (spreadMkt && spreadMkt.outcomes) {
    const a = spreadMkt.outcomes[0], h = spreadMkt.outcomes[1];
    const al = a && /[a-zA-Z]/.test(a.label || '') && (a.label || '').match(/([+-]?\d+\.?\d*)\s*$/);
    const hl = h && /[a-zA-Z]/.test(h.label || '') && (h.label || '').match(/([+-]?\d+\.?\d*)\s*$/);
    if (al) lines.awaySpread = parseFloat(al[1]);
    if (hl) lines.homeSpread = parseFloat(hl[1]);
  }
  const totalMkt = (mData.markets || []).find(m => m.label === 'Total');
  if (totalMkt && totalMkt.outcomes && totalMkt.outcomes[0]) {
    const tl = (totalMkt.outcomes[0].label || '').match(/(\d+\.?\d*)\s*$/);
    if (tl) lines.total = parseFloat(tl[1]);
  }
  return lines;
}

// ── Sync one sport ──────────────────────────────────────

async function syncSport(fdKey, rsSport) {
  let gamesData;
  try {
    const r = await rsFetch(`${RS_BASE}/home/${rsSport}/next?cohort=0`);
    if (r.status !== 200) { console.log(`rs-sync: ${fdKey} games status ${r.status}`); return; }
    gamesData = await r.json();
  } catch(e) { console.error(`rs-sync: ${fdKey} games fetch error:`, e.message); return; }

  let games = extractGames(gamesData);

  // Soccer: also pull UCL
  if (rsSport === 'soccer') {
    try {
      const r = await rsFetch(`${RS_BASE}/home/ucl/next?cohort=0`);
      if (r.status === 200) {
        const seen = {}; games.forEach(g => { seen[g.id || g.gameId] = true; });
        extractGames(await r.json()).forEach(g => {
          const id = g.id || g.gameId;
          if (id && !seen[id]) { g._rsSport = 'ucl'; games.push(g); seen[id] = true; }
        });
      }
    } catch(e) {}
  }

  if (!games.length) { console.log(`rs-sync: ${fdKey} — 0 games`); return; }

  const freshMap = {};
  for (let i = 0; i < games.length; i += 4) {
    await Promise.all(games.slice(i, i + 4).map(async game => {
      const gameKey = buildGameKey(game);
      if (!gameKey) return;
      const gameId = game.id || game.gameId;
      const sport  = game._rsSport || rsSport;
      try {
        const r = await rsFetch(`${RS_BASE}/predictions/game/${sport}/${gameId}/markets`);
        if (r.status !== 200) return;
        const mData = await r.json();
        if (mData.statusCode === 429 || mData.error === 'Too Many Requests') {
          console.warn(`rs-sync: 429 on ${gameKey} — backing off`);
          return;
        }
        freshMap[gameKey] = parseMarkets(game, mData);
        const lines = extractLines(mData);
        if (Object.keys(lines).length) freshMap[gameKey + '__lines'] = lines;
        freshMap[gameKey + '__gid'] = gameId;
        const rsSportTag = game.sport || (game.league && (game.league.sport || game.league.key)) || null;
        if (rsSportTag) freshMap[gameKey + '__sport'] = rsSportTag;
        const rawStart = game.dateTime || game.commenceTime || game.startTime || game.scheduledAt || game.gameTime;
        if (rawStart) freshMap[gameKey + '__startMs'] = typeof rawStart === 'number' ? rawStart : new Date(rawStart).getTime();
      } catch(e) {}
    }));
    if (i + 4 < games.length) await new Promise(r => setTimeout(r, 400));
  }

  const gameCount = Object.keys(freshMap).filter(k => !k.includes('__')).length;
  if (!gameCount) { console.log(`rs-sync: ${fdKey} — no market data`); return; }

  try {
    const r = await fetch(SYNC_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sport: fdKey, markets: freshMap }),
      signal:  AbortSignal.timeout(10000),
    });
    console.log(`rs-sync: ${fdKey} — ${gameCount} games → D1 | status ${r.status}`);
  } catch(e) {
    console.error(`rs-sync: ${fdKey} POST failed:`, e.message);
  }
}

// ── Main loop ───────────────────────────────────────────

let running = false;

async function run() {
  if (running) { console.log('rs-sync: previous cycle still running, skipping'); return; }
  running = true;
  try {
    for (const [fdKey, rsSport] of SPORTS) {
      await syncSport(fdKey, rsSport);
    }
  } finally {
    running = false;
  }
}

// ── Boot ────────────────────────────────────────────────

if (!RS_AUTH_INFO || !SITE_URL) {
  console.error('rs-sync: missing required env vars: RS_AUTH_INFO, SITE_URL');
  process.exit(1);
}

console.log(`rs-sync: starting | ${SPORTS.length} sports | interval ${SYNC_INTERVAL / 1000}s`);
run();
setInterval(run, SYNC_INTERVAL);
