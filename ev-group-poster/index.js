// ev-group-poster/index.js
// Polls RaxEdge /api/ev/current every 60s and posts new +EV bets to an RS group.
//
// Required env vars:
//   SITE_URL      — RaxEdge URL, e.g. https://raxedge.com
//   EV_POSTER_KEY — set this to any value in Cloudflare env + match here
//   RS_AUTH_INFO  — RS auth token: userId!deviceId!token
//   RS_GROUP_ID   — RS group ID to post to (e.g. 61979)
//
// Optional:
//   RS_DEVICE_UUID — RS device UUID
//   MIN_EV         — minimum EV% to post (default: 5)
//   MAX_POSTS      — cap posts per run (default: 5)
//   POST_DELAY_MS  — ms between consecutive posts (default: 5000)

const SITE_URL      = process.env.SITE_URL;
const EV_POSTER_KEY = process.env.EV_POSTER_KEY;
const RS_AUTH_INFO  = process.env.RS_AUTH_INFO;
const RS_GROUP_ID   = process.env.RS_GROUP_ID;
const DEVICE_UUID   = process.env.RS_DEVICE_UUID || '2e0a38e2-0ee8-4f93-9a34-218ac1d10161';
const MIN_EV           = parseFloat(process.env.MIN_EV            || '5');
const MAX_POSTS        = parseInt(process.env.MAX_POSTS            || '5');
const POST_DELAY_MS    = parseInt(process.env.POST_DELAY_MS        || '5000');
const REPOST_EV_JUMP   = parseFloat(process.env.REPOST_EV_JUMP     || '5');

const RS_BASE     = 'https://web.realapp.com';
const RS_WEB_BASE = 'https://realsports.io';

// In-memory dedup: betKey → EV% at time of posting
// Re-posts when EV has risen by REPOST_EV_JUMP since last post — cleared at midnight ET
const postedEv = new Map();
let running = false;

// ── RS request token (hashids-encoded timestamp, 'realwebapp' salt) ──────────

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
    'Origin':             RS_WEB_BASE,
    'Referer':            RS_WEB_BASE + '/',
    'Sec-Fetch-Dest':     'empty',
    'Sec-Fetch-Mode':     'cors',
    'Sec-Fetch-Site':     'cross-site',
    'User-Agent':         'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-device-uuid':   DEVICE_UUID,
    'real-device-name':   '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-device-type':   'desktop_web',
    'real-version':       '32',
    'real-request-token': hashidsEncode(Date.now()),
    'real-auth-info':     RS_AUTH_INFO,
  };
}

// ── Formatting ─────────────────────────────────────────

function rsBaseTake(p) {
  const pts = [[0.0918,0.0535],[0.13,0.065],[0.1737,0.0464],[0.32,0.046],[0.3757,0.039],[0.49,0.020],[0.59,0.018],[0.73,0.015],[0.7816,0.0125]];
  if (p <= pts[0][0]) return pts[0][1];
  if (p >= pts[pts.length-1][0]) return pts[pts.length-1][1];
  for (let i = 0; i < pts.length - 1; i++) {
    if (p >= pts[i][0] && p < pts[i+1][0]) {
      const t = (p - pts[i][0]) / (pts[i+1][0] - pts[i][0]);
      return pts[i][1] + t * (pts[i+1][1] - pts[i][1]);
    }
  }
  return 0.034;
}

function calcEV(fdFair, rsProb) {
  if (!fdFair || !rsProb || rsProb <= 0) return null;
  return (fdFair / rsProb * (1 - rsBaseTake(rsProb)) - 1) * 100;
}

function formatPost(bet) {
  const ptStr = bet.pt != null ? ' ' + (bet.pt > 0 ? '+' : '') + bet.pt : '';
  const line  = (bet.market === 'ML' || bet.market === 'RFI')
    ? bet.side
    : bet.side + ptStr;

  const evStr   = (bet.ev >= 0 ? '+' : '') + bet.ev.toFixed(1) + '% EV';
  const rsPct   = bet.rsPct      != null ? bet.rsPct.toFixed(1)      + '% RS'   : null;
  const fairPct = bet.adjFairPct != null ? bet.adjFairPct.toFixed(1) + '% Fair' : null;
  const raxAmt  = bet.units * 1000;
  const raxStr  = raxAmt >= 1000 ? (raxAmt / 1000).toFixed(raxAmt % 1000 === 0 ? 0 : 1) + 'k' : raxAmt;
  const statsLine = [rsPct, fairPct, evStr, bet.units + 'u · ' + raxStr + ' Rax'].filter(Boolean).join(' | ');

  const lines = [
    `+EV Pick: ${line} · ${bet.market} · ${bet.sport}`,
    statsLine,
  ];

  // RS sensitivity: EV at +1%, +2%, +3% RS price spike
  if (bet.rsPct != null && bet.adjFairPct != null) {
    const fdFair = bet.adjFairPct / 100;
    const rsProb = bet.rsPct / 100;
    const sensParts = [1, 2, 3].map(n => {
      const spiked = Math.min(0.999, rsProb + n / 100);
      const ev = calcEV(fdFair, spiked);
      if (ev == null) return null;
      return `RS@${(spiked * 100).toFixed(1)}%: ${ev >= 0 ? '+' : ''}${ev.toFixed(1)}%`;
    }).filter(Boolean);
    if (sensParts.length) lines.push(sensParts.join(' · '));
  }

  if (bet.gameUrl) lines.push(bet.gameUrl);
  return lines.join('\n');
}

// ── Main cron run ──────────────────────────────────────

async function run() {
  if (running) { console.log('ev-poster: previous run in progress, skipping'); return; }
  running = true;

  try {
    // Fetch current +EV bets from RaxEdge
    let evData;
    try {
      const res = await fetch(`${SITE_URL}/api/ev/current?_poster_key=${EV_POSTER_KEY}`, {
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) { console.error('ev-poster: /api/ev/current failed', res.status); return; }
      evData = await res.json();
    } catch(e) {
      console.error('ev-poster: fetch error', e.message);
      return;
    }

    if (!evData.ok || !evData.bets?.length) {
      console.log('ev-poster: no bets in cache');
      return;
    }

    // Skip if alert-cron data is stale (> 5 min)
    const dataAge = Math.floor(Date.now() / 1000) - (evData.ts || 0);
    if (dataAge > 300) {
      console.log('ev-poster: data is', dataAge + 's old, skipping');
      return;
    }

    // Filter: MIN_EV threshold, skip live bets, skip unless new or EV jumped ≥ REPOST_EV_JUMP
    const newBets = evData.bets
      .filter(b => {
        if (b.ev < MIN_EV || b.isLive) return false;
        const lastEv = postedEv.get(b.betKey);
        return lastEv == null || b.ev - lastEv >= REPOST_EV_JUMP;
      })
      .sort((a, b) => b.ev - a.ev)
      .slice(0, MAX_POSTS);

    if (!newBets.length) {
      console.log('ev-poster: no new bets');
      return;
    }

    console.log('ev-poster: posting', newBets.length, 'new bet(s)');

    for (let i = 0; i < newBets.length; i++) {
      const bet  = newBets[i];
      const text = formatPost(bet);
      try {
        const res = await fetch(`${RS_BASE}/comments/groups/${RS_GROUP_ID}`, {
          method:  'POST',
          headers: rsHeaders(),
          body:    JSON.stringify({ text, content: { nodes: [{ text }] } }),
          signal:  AbortSignal.timeout(10000),
        });

        if (res.ok) {
          console.log('ev-poster: posted', bet.betKey, '| EV', bet.ev + '%');
          postedEv.set(bet.betKey, bet.ev);
        } else {
          const errText = await res.text();
          console.error('ev-poster: group post failed', res.status, errText.slice(0, 200));
        }
      } catch(e) {
        console.error('ev-poster: post error for', bet.betKey, e.message);
      }

      if (i < newBets.length - 1) await new Promise(r => setTimeout(r, POST_DELAY_MS));
    }
  } finally {
    running = false;
  }
}

// ── Midnight ET reset ──────────────────────────────────

function scheduleMidnightReset() {
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et    = new Date(etStr);
  const next  = new Date(et);
  next.setHours(24, 0, 30, 0);
  const msUntil = next - et;
  setTimeout(() => {
    console.log('ev-poster: midnight ET — clearing', postedEv.size, 'posted bets');
    postedEv.clear();
    scheduleMidnightReset();
  }, Math.max(msUntil, 60_000));
}

// ── Boot ───────────────────────────────────────────────

if (!SITE_URL || !EV_POSTER_KEY || !RS_AUTH_INFO || !RS_GROUP_ID) {
  console.error('ev-poster: missing required env vars: SITE_URL, EV_POSTER_KEY, RS_AUTH_INFO, RS_GROUP_ID');
  process.exit(1);
}

console.log(`ev-poster: starting | group ${RS_GROUP_ID} | min EV ${MIN_EV}% | max ${MAX_POSTS}/run`);
scheduleMidnightReset();
run();
setInterval(run, 60_000);
