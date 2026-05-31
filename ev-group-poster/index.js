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
//   RS_PROXY_URL   — residential proxy e.g. http://user:pass@host:port (required on VPS)
//   MIN_EV         — minimum EV% to post (default: 5)
//   MAX_POSTS      — cap posts per run (default: 5)
//   POST_DELAY_MS  — ms between consecutive posts (default: 5000)

import { ProxyAgent } from 'undici';
import { readFileSync, writeFileSync } from 'fs';
import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';

const SITE_URL         = process.env.SITE_URL;
const EV_POSTER_KEY    = process.env.EV_POSTER_KEY;
const ALERT_CRON_URL   = process.env.ALERT_CRON_URL || 'https://raxedge-alert-cron.mghasham24.workers.dev';
const RS_AUTH_INFO  = process.env.RS_AUTH_INFO;
const RS_GROUP_ID   = process.env.RS_GROUP_ID;
const DEVICE_UUID   = process.env.RS_DEVICE_UUID || '2e0a38e2-0ee8-4f93-9a34-218ac1d10161';
const RS_PROXY_URL  = process.env.RS_PROXY_URL || null;
const MIN_EV             = parseFloat(process.env.MIN_EV              || '5');  // WS payout EV gate
const PRE_FILTER_EV      = parseFloat(process.env.PRE_FILTER_EV       || '5');  // traditional-formula pre-filter
const MAX_POSTS          = parseInt(process.env.MAX_POSTS              || '5');
const POST_DELAY_MS      = parseInt(process.env.POST_DELAY_MS          || '5000');
const REPOST_EV_JUMP     = parseFloat(process.env.REPOST_EV_JUMP       || '5');
const REPOST_COOLDOWN_MS = parseInt(process.env.REPOST_COOLDOWN_MS     || String(30 * 60 * 1000)); // 30min
const REPOST_URGENT_EV   = parseFloat(process.env.REPOST_URGENT_EV      || '25'); // bypass cooldown
const STATE_FILE         = process.env.STATE_FILE || '/opt/ev-group-poster/state.json';
const STAKE_RAX          = parseInt(process.env.STAKE_RAX || '700'); // Rax per 1 unit — group post uses avg stake for slippage-adjusted EV

const RS_BASE     = 'https://web.realapp.com';
const RS_WEB_BASE = 'https://realsports.io';

const rsDispatcher = RS_PROXY_URL ? new ProxyAgent(RS_PROXY_URL) : undefined;

// Dedup state: betKey → { ev, postedAt }
// Persisted to disk so restarts don't re-post.
// Repost only if EV jumped ≥ REPOST_EV_JUMP AND cooldown has passed.
const postedEv = new Map();
let dailyPosts    = [];  // all posts today for end-of-day summary
let weeklyRecord  = { w: 0, l: 0, weekStart: 0 };
let running = false;

function loadState() {
  try {
    const data = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(data)) {
      if (k === '_dailyPosts')   { dailyPosts   = v || []; continue; }
      if (k === '_weeklyRecord') { weeklyRecord = v || { w: 0, l: 0, weekStart: 0 }; continue; }
      postedEv.set(k, v);
    }
    console.log('ev-poster: loaded', postedEv.size, 'dedup entries,', dailyPosts.length, 'daily posts from disk');
  } catch(e) {}
}

function saveState() {
  try {
    const obj = { _dailyPosts: dailyPosts, _weeklyRecord: weeklyRecord };
    for (const [k, v] of postedEv.entries()) obj[k] = v;
    writeFileSync(STATE_FILE, JSON.stringify(obj));
  } catch(e) { console.error('ev-poster: failed to save state:', e.message); }
}

function currentWeekStart() {
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et    = new Date(etStr);
  const day   = et.getDay(); // 0=Sun
  const monday = new Date(et);
  monday.setDate(et.getDate() - (day === 0 ? 6 : day - 1));
  monday.setHours(0, 0, 0, 0);
  return monday.getTime();
}

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

// ── Unit sizing (mirrors alert-cron unitsEV exactly) ──

function unitsEV(ev, realPct) {
  if (ev == null || !isFinite(ev)) return 0;
  const maxU = (realPct != null && realPct < 0.075) ? 0.25
             : (realPct != null && realPct < 0.15)  ? 0.5
             : (realPct != null && realPct < 0.25)  ? 0.5
             : 3;
  if (ev >= 35) return Math.min(3, maxU);
  if (ev >= 20) return Math.min(2, maxU);
  if (ev >= 10) return Math.min(1, maxU);
  if (ev >= 5)  return Math.min(0.5, maxU);
  return 0;
}

// ── Live RS odds refresh ────────────────────────────────

const RS_ML_LABELS    = ['Game Winner', 'Moneyline', 'To Win Match', 'Match Winner'];
const RS_MARKET_MAP   = { ML: RS_ML_LABELS, Spread: ['Spread'], Total: ['Total', 'Total Goals'], RFI: ['Run in 1st inning?'] };

function normName(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Returns {prob, marketId, outcomeId} or null
async function fetchLiveRSData(bet) {
  if (!bet.rsGameId || !bet.rsSport) return null;
  try {
    const res = await fetch(
      `${RS_BASE}/predictions/game/${bet.rsSport}/${bet.rsGameId}/markets`,
      { headers: rsHeaders(), signal: AbortSignal.timeout(6000), dispatcher: rsDispatcher }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (data.statusCode === 429) return null;
    const markets  = data.markets || [];
    const labels   = RS_MARKET_MAP[bet.market] || RS_ML_LABELS;
    const mkt      = markets.find(m => labels.includes(m.label));
    if (!mkt) return null;
    const normSide = normName(bet.side);
    const outcome  = (mkt.outcomes || []).find(o => {
      const norm = normName(o.label).replace(/\d/g, '');
      return norm === normSide || normSide.includes(norm) || norm.includes(normSide) || isSubseq(norm, normSide);
    });
    if (!outcome || !outcome.probability) return null;
    return { prob: outcome.probability, marketId: mkt.id, outcomeId: outcome.id };
  } catch(e) { return null; }
}

function generateOrderId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * 64)]).join('');
}

// Fetch exact RS payout via Socket.IO WebSocket — returns expectedPayout Rax for `amount` staked, or null
async function fetchExactPayout(marketId, outcomeId, amount = 10) {
  const token = RS_AUTH_INFO;
  if (!token || !marketId || !outcomeId) return null;
  const params = new URLSearchParams({
    socketType: 'predictionmarketorder',
    realRequestToken: hashidsEncode(Date.now()),
    realVersion: '32',
    marketId: String(marketId),
    orderInstanceId: generateOrderId(),
    rooms: 'undefined',
    deviceUuid: DEVICE_UUID,
    deviceVersion: 'undefined',
    deviceType: 'desktop_web',
    auth: token,
    EIO: '3',
    transport: 'websocket',
  });
  const wsUrl = `wss://web.realsports.io/socket.io/?${params}`;
  const agent = RS_PROXY_URL ? new HttpsProxyAgent(RS_PROXY_URL) : undefined;

  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); try { ws.terminate(); } catch(_) {} } };
    const timer = setTimeout(() => done(null), 8000);
    const ws = new WebSocket(wsUrl, {
      agent,
      headers: { 'Origin': 'https://realsports.io', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15' },
    });
    ws.on('message', (data) => {
      const msg = data.toString();
      if (msg === '2') { ws.send('3'); return; }
      if (msg === '40') {
        ws.send(`420["PredictionMarketGetExpectedPayout",{"marketId":${marketId},"outcomeId":${outcomeId},"sharesPct":null,"amount":${amount}}]`);
      }
      if (msg.startsWith('430')) {
        try {
          const parsed = JSON.parse(msg.slice(3));
          const result = Array.isArray(parsed) ? parsed[0] : parsed;
          clearTimeout(timer);
          done(result?.expectedPayout ?? null);
        } catch(_) { clearTimeout(timer); done(null); }
      }
    });
    ws.on('error', (e) => { console.error('ev-poster: payout WS error', e.message); clearTimeout(timer); done(null); });
    ws.on('close', () => { clearTimeout(timer); done(null); });
  });
}

function calcExactEV(fdFair, expectedPayout, amount) {
  if (!fdFair || !expectedPayout || !amount) return null;
  return (fdFair * expectedPayout / amount - 1) * 100;
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
  const rsPct   = bet.rsPct      != null ? Math.round(bet.rsPct)      + '% RS'   : null;
  const fairPct = bet.adjFairPct != null ? bet.adjFairPct.toFixed(1) + '% Fair' : null;
  const statsLine = [rsPct, fairPct, evStr, bet.units + 'u'].filter(Boolean).join(' | ');

  const lines = [
    `${line} · ${bet.market} · ${bet.sport}`,
    statsLine,
  ];

  // RS sensitivity: one full stats line per +1/+2/+3% RS spike
  // Apply the same slippage factor as the main line so all lines are on
  // the same scale (WS-adjusted). Avoids non-monotonic display when the
  // main line uses WS exact EV (lower, includes slippage) but sensitivity
  // lines use rsBaseTake approximation (higher, no slippage).
  if (bet.rsPct != null && bet.adjFairPct != null) {
    const fdFair = bet.adjFairPct / 100;
    const rsProb = bet.rsPct / 100;
    const approxEvMain = calcEV(fdFair, rsProb);
    const slippageFactor = (approxEvMain != null && approxEvMain > 0 && bet.ev > 0)
      ? bet.ev / approxEvMain   // < 1 when WS slippage reduced EV vs approximation
      : 1;
    for (const n of [1, 2, 3]) {
      const spiked   = Math.min(0.999, rsProb + n / 100);
      const ev       = calcEV(fdFair, spiked);
      if (ev == null) continue;
      const adjEv    = ev * slippageFactor;
      const u        = unitsEV(adjEv, fdFair);
      const evStr    = (adjEv >= 0 ? '+' : '') + adjEv.toFixed(1) + '% EV';
      const rsPctStr = Math.round(spiked * 100) + '% RS';
      const fairStr  = bet.adjFairPct.toFixed(1) + '% Fair';
      lines.push('-');
      lines.push([rsPctStr, fairStr, evStr, u + 'u'].join(' | '));
    }
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

    // Skip if alert-cron data is stale (> 5 min); nudge the Worker to restart if so
    const dataAge = Math.floor(Date.now() / 1000) - (evData.ts || 0);
    if (dataAge > 300) {
      console.log('ev-poster: data is', dataAge + 's old, skipping');
      if (EV_POSTER_KEY) {
        fetch(`${ALERT_CRON_URL}/trigger?_key=${EV_POSTER_KEY}`, { signal: AbortSignal.timeout(5000) })
          .then(r => console.log('ev-poster: nudged alert-cron, status', r.status))
          .catch(e => console.error('ev-poster: nudge failed', e.message));
      }
      return;
    }

    // Filter: MIN_EV threshold, skip live, skip if posted recently unless EV jumped ≥ REPOST_EV_JUMP
    const now2 = Date.now();
    const nowSec = Math.floor(Date.now() / 1000);
    const newBets = evData.bets
      .filter(b => {
        if (b.ev < PRE_FILTER_EV) return false;
        if (b.isLive) return false;
        if (b.commenceTime > 0 && b.commenceTime <= nowSec) return false;
        const last = postedEv.get(b.betKey);
        if (!last) return true;
        const evJumped  = b.ev - last.ev >= REPOST_EV_JUMP;
        if (!evJumped) return false;
        // Bypass cooldown if EV is outrageous (≥ REPOST_URGENT_EV)
        if (b.ev >= REPOST_URGENT_EV) return true;
        return (now2 - last.postedAt) >= REPOST_COOLDOWN_MS;
      })
      .sort((a, b) => b.ev - a.ev)
      .slice(0, MAX_POSTS);

    if (!newBets.length) {
      console.log('ev-poster: no new bets');
      return;
    }

    console.log('ev-poster: posting', newBets.length, 'new bet(s)');

    for (let i = 0; i < newBets.length; i++) {
      const bet = newBets[i];
      // Capture backend EV before any live/exact-payout mutations.
      // postedEv comparison uses backend EV so the evJumped check
      // stays on the same scale across runs — exact-payout EV is
      // lower (includes slippage) and would artificially inflate the jump.
      const backendEv = bet.ev;

      // Refresh RS probability + fetch exact payout via WebSocket
      const fdFair   = (bet.adjFairPct || 0) / 100;
      const liveData = await fetchLiveRSData(bet);
      if (liveData !== null) {
        const { prob: liveProb, marketId, outcomeId } = liveData;
        const livePct = Math.round(liveProb * 1000) / 10;
        const liveEv  = calcEV(fdFair, liveProb);
        if (liveEv !== null && liveEv < MIN_EV) {
          console.log('ev-poster: skip', bet.betKey, '— live RS prob', livePct + '% drops EV to', liveEv.toFixed(1) + '%');
          // Store cached bet.ev (not live EV) so evJump stays ~0 and repost logic doesn't keep retriggering
          postedEv.set(bet.betKey, { ev: bet.ev, postedAt: Date.now() });
          saveState();
          continue;
        }
        if (liveEv !== null) {
          const staleness = Math.abs(livePct - bet.rsPct);
          if (staleness > 0.5) console.log('ev-poster: live RS update', bet.betKey, '| cached', bet.rsPct + '% → live', livePct + '%');
          bet.rsPct = livePct;
          bet.ev    = Math.round(liveEv * 10) / 10;
          bet.units = unitsEV(liveEv, fdFair);
        }
        // Fetch exact payout via WebSocket — uses actual stake size so slippage is included
        if (marketId && outcomeId) {
          const stakeRax = Math.round(bet.units * STAKE_RAX);
          const payout   = await fetchExactPayout(marketId, outcomeId, stakeRax);
          if (payout != null) {
            const exactEv = calcExactEV(fdFair, payout, stakeRax);
            if (exactEv !== null) {
              if (exactEv < MIN_EV) {
                console.log('ev-poster: skip', bet.betKey, '— slippage-adjusted EV', exactEv.toFixed(1) + '% < min');
                postedEv.set(bet.betKey, { ev: bet.ev, postedAt: Date.now() });
                saveState();
                continue;
              }
              console.log('ev-poster: exact payout', payout, 'Rax for', stakeRax, '(' + bet.units + 'u) | EV', exactEv.toFixed(1) + '% (was', bet.ev + '%)');
              bet.ev    = Math.round(exactEv * 10) / 10;
              bet.units = unitsEV(exactEv, fdFair);
            }
          }
          // gameUrl already contains the correct RS market URL from the API response
        }
      }

      if (bet.units <= 0) { console.log('ev-poster: skip', bet.betKey, '— 0 units after live update'); continue; }

      const text = formatPost(bet);
      try {
        const res = await fetch(`${RS_BASE}/comments/groups/${RS_GROUP_ID}`, {
          method:  'POST',
          headers: rsHeaders(),
          body:    JSON.stringify({ text, content: { nodes: [{ text }] } }),
          signal:  AbortSignal.timeout(10000),
          dispatcher: rsDispatcher,
        });

        if (res.ok) {
          console.log('ev-poster: posted', bet.betKey, '| EV', bet.ev + '%');
          const now = Date.now();
          // Store backendEv (pre-mutation) so next run's evJump comparison
          // stays on the same scale. Storing exact-payout EV (lower due to
          // slippage) would always produce a 5%+ jump on the next run.
          postedEv.set(bet.betKey, { ev: backendEv, postedAt: now });
          dailyPosts.push({
            betKey: bet.betKey, side: bet.side, market: bet.market,
            sport: bet.sport,   game: bet.game,  pt: bet.pt ?? null,
            ev: bet.ev,         rsPct: bet.rsPct, units: bet.units,
            rsGameId: bet.rsGameId || null, rsSport: bet.rsSport || null,
            postedAt: now,
          });
          saveState();
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

// ── Result checking ────────────────────────────────────

function isSubseq(abbr, full) {
  let i = 0;
  for (const c of full) { if (c === abbr[i]) i++; if (i === abbr.length) return true; }
  return false;
}

function resolveResult(post, markets) {
  const labels  = RS_MARKET_MAP[post.market] || RS_ML_LABELS;
  const mkt     = markets.find(m => labels.includes(m.label));
  if (!mkt) return null;
  const outcomes  = mkt.outcomes || [];
  const normSide  = normName(post.side);
  const outcome   = outcomes.find(o => {
    const norm = normName(o.label).replace(/\d/g, ''); // strip digits — RS spread labels include spread value e.g. "OKC +3.5"
    return norm === normSide || normSide.includes(norm) || norm.includes(normSide) || isSubseq(norm, normSide);
  });
  if (!outcome) return null;
  if (outcome.isWinner === true)  return 'win';
  if (outcome.isWinner === false) return 'loss';
  const maxProb = Math.max(...outcomes.map(o => o.probability || 0));
  if (maxProb < 0.90) return null;
  return outcome.probability >= 0.90 ? 'win' : 'loss';
}

async function fetchGameMarkets(rsSport, rsGameId) {
  try {
    const res = await fetch(
      `${RS_BASE}/predictions/game/${rsSport}/${rsGameId}/markets`,
      { headers: rsHeaders(), signal: AbortSignal.timeout(8000), dispatcher: rsDispatcher }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (data.statusCode) return null;
    return data.markets || [];
  } catch(e) { return null; }
}

// ── Daily summary ──────────────────────────────────────

async function postDailySummary() {
  if (!dailyPosts.length) { console.log('ev-poster: no posts today, skipping summary'); return; }

  // Deduplicate by betKey — keep last post per key (highest EV repost)
  const byKey = new Map();
  for (const p of dailyPosts) byKey.set(p.betKey, p);
  const posts = Array.from(byKey.values());

  // Fetch markets per unique game (avoids 429 rate limit from 18+ sequential calls)
  const gameCache = new Map();
  const uniqueGames = [...new Set(posts.filter(p => p.rsGameId).map(p => `${p.rsSport}:${p.rsGameId}`))];
  console.log('ev-poster: checking results —', posts.length, 'bets across', uniqueGames.length, 'games');
  for (const key of uniqueGames) {
    const [sport, id] = key.split(':');
    const markets = await fetchGameMarkets(sport, id);
    gameCache.set(key, markets || []);
    if (uniqueGames.indexOf(key) < uniqueGames.length - 1) await new Promise(r => setTimeout(r, 800));
  }
  const results = posts.map(post => ({
    ...post,
    result: post.rsGameId ? resolveResult(post, gameCache.get(`${post.rsSport}:${post.rsGameId}`) || []) : null,
  }));

  const wins    = results.filter(r => r.result === 'win').length;
  const losses  = results.filter(r => r.result === 'loss').length;
  const pending = results.filter(r => r.result === null).length;

  // Update weekly record
  const ws = currentWeekStart();
  if (weeklyRecord.weekStart !== ws) weeklyRecord = { w: 0, l: 0, weekStart: ws };
  weeklyRecord.w += wins;
  weeklyRecord.l += losses;

  const hitRate  = (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : 0;
  const weekTot  = weeklyRecord.w + weeklyRecord.l;
  const weekRate = weekTot > 0 ? Math.round(weeklyRecord.w / weekTot * 100) : 0;

  // Expected profit = sum of (EV% × units) across all picks
  const expectedU = posts.reduce((sum, p) => {
    const u = p.units ?? unitsEV(p.ev, p.rsPct != null ? p.rsPct / 100 : null);
    return sum + (p.ev / 100) * (u || 0);
  }, 0);
  const expectedStr = (expectedU >= 0 ? '+' : '') + expectedU.toFixed(2) + 'u expected';

  const etDate  = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric' });

  function teamNickname(name) {
    const words = (name || '').split(' ');
    const last = words[words.length - 1];
    // Multi-word nicknames (Red Sox, White Sox, Blue Jays, etc.)
    return (last === 'Sox' || last === 'Jays') ? words.slice(-2).join(' ') : last;
  }
  function abbrevGame(game) {
    return (game || '').split(' @ ').map(teamNickname).join(' @ ');
  }
  function betLine(r) {
    const isML     = r.market === 'ML';
    const isRFI    = r.market === 'RFI';
    const isTotal  = r.market === 'Total';
    const isSpread = r.market === 'Spread';
    // No + prefix for totals (219.5 not +219.5); + is correct for spreads
    const ptStr    = r.pt != null ? ' ' + (r.pt > 0 && !isTotal ? '+' : '') + r.pt : '';
    const display  = isML ? teamNickname(r.side)
                   : isRFI ? r.side
                   : teamNickname(r.side) + ptStr;
    const mktTag   = isML ? ' ML' : (isRFI ? '' : ` · ${r.market}`);
    const gameTag  = (isRFI || (isSpread && r.sport !== 'NBA') || isTotal) && r.game ? ` · ${abbrevGame(r.game)}` : '';
    return `${display}${mktTag}${gameTag} · +${r.ev.toFixed(1)}%`;
  }

  const SPORT_ORDER  = ['NBA', 'NHL', 'MLB', 'WNBA', 'FC'];
  const MARKET_ORDER = ['ML', 'Spread', 'Total', 'RFI'];
  const sportSort = (a, b) => {
    const is = SPORT_ORDER.indexOf(a.sport),  js = SPORT_ORDER.indexOf(b.sport);
    const sd = (is === -1 ? 99 : is) - (js === -1 ? 99 : js);
    if (sd !== 0) return sd;
    const im = MARKET_ORDER.indexOf(a.market), jm = MARKET_ORDER.indexOf(b.market);
    return (im === -1 ? 99 : im) - (jm === -1 ? 99 : jm);
  };
  const winList     = results.filter(r => r.result === 'win').sort(sportSort);
  const lossList    = results.filter(r => r.result === 'loss').sort(sportSort);
  const pendingList = results.filter(r => r.result === null).sort(sportSort);

  const lines = [
    `📊 RaxEdge Daily Summary — ${etDate}`,
    '-',
    `${posts.length} pick${posts.length !== 1 ? 's' : ''} · ${wins}W ${losses}L${pending ? ` · ${pending} pending` : ''} · ${hitRate}% hit rate · ${expectedStr}`,
    `Week: ${weeklyRecord.w}W ${weeklyRecord.l}L · ${weekRate}%`,
  ];

  if (winList.length) {
    lines.push('-', `✅ Wins (${winList.length})`);
    winList.forEach(r => lines.push(betLine(r)));
  }
  if (lossList.length) {
    lines.push('-', `❌ Losses (${lossList.length})`);
    lossList.forEach(r => lines.push(betLine(r)));
  }
  if (pendingList.length) {
    lines.push('-', `⏳ Pending (${pendingList.length})`);
    pendingList.forEach(r => lines.push(betLine(r)));
  }

  const text = lines.join('\n');
  try {
    const res = await fetch(`${RS_BASE}/comments/groups/${RS_GROUP_ID}`, {
      method: 'POST', headers: rsHeaders(),
      body: JSON.stringify({ text, content: { nodes: [{ text }] } }),
      signal: AbortSignal.timeout(10000), dispatcher: rsDispatcher,
    });
    if (res.ok) console.log('ev-poster: daily summary posted');
    else console.error('ev-poster: summary post failed', res.status, await res.text().catch(() => ''));
  } catch(e) { console.error('ev-poster: summary post error', e.message); }
}

// ── Midnight ET reset ──────────────────────────────────

function scheduleMidnightReset() {
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et    = new Date(etStr);
  const next  = new Date(et);
  next.setHours(24, 0, 30, 0);
  const msUntil = next - et;
  setTimeout(async () => {
    console.log('ev-poster: midnight ET — posting summary then clearing', postedEv.size, 'posted bets');
    await postDailySummary();
    postedEv.clear();
    dailyPosts = [];
    saveState();
    scheduleMidnightReset();
  }, Math.max(msUntil, 60_000));
}

// ── Payout proxy HTTP server ───────────────────────────
// CF Workers can't WebSocket to web.realsports.io (Cloudflare loopback block).
// This endpoint lets the CF payout.js call the VPS instead, which uses the
// residential proxy to reach RS WebSocket and return the exact expectedPayout.
//
// GET /payout?marketId=X&outcomeKey=SAS&rsGameId=Y&rsSport=nba&amount=Z&key=PAYOUT_PROXY_KEY

import { createServer } from 'http';

const PAYOUT_PROXY_PORT = parseInt(process.env.PAYOUT_PROXY_PORT || '3002');
const PAYOUT_PROXY_KEY  = process.env.PAYOUT_PROXY_KEY || EV_POSTER_KEY;

function normNameLocal(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

const payoutServer = createServer(async (req, res) => {
  const url    = new URL(req.url, `http://localhost:${PAYOUT_PROXY_PORT}`);
  if (url.pathname !== '/payout') { res.writeHead(404); res.end('Not found'); return; }

  const key = url.searchParams.get('key');
  if (key !== PAYOUT_PROXY_KEY) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }

  const marketId   = parseInt(url.searchParams.get('marketId'));
  const outcomeKey = (url.searchParams.get('outcomeKey') || '').trim();
  const rsGameId   = url.searchParams.get('rsGameId');
  const rsSport    = url.searchParams.get('rsSport');
  const amount     = Math.min(Math.max(parseInt(url.searchParams.get('amount') || '700'), 1), 100000);

  if (!marketId || !outcomeKey || !rsGameId || !rsSport) {
    res.writeHead(400); res.end(JSON.stringify({ error: 'Missing params' })); return;
  }

  try {
    // Resolve outcomeId from RS game markets API (via residential proxy)
    const marketsRes = await fetch(
      `${RS_BASE}/predictions/game/${rsSport}/${rsGameId}/markets`,
      { headers: rsHeaders(), signal: AbortSignal.timeout(6000), dispatcher: rsDispatcher }
    );
    if (!marketsRes.ok) {
      res.writeHead(502); res.end(JSON.stringify({ error: 'RS markets API ' + marketsRes.status })); return;
    }
    const data    = await marketsRes.json();
    const markets = data.markets || [];
    const mkt     = markets.find(m => m.id === marketId);
    if (!mkt) {
      res.writeHead(404); res.end(JSON.stringify({ error: 'Market ' + marketId + ' not found', marketIds: markets.map(m => m.id) })); return;
    }
    const normTarget = normNameLocal(outcomeKey);
    const outcome = (mkt.outcomes || []).find(o => {
      const normLabel = normNameLocal(o.label).replace(/\d/g, '');
      const normOKey  = normNameLocal(o.key).replace(/\d/g, '');
      return normLabel === normTarget || normOKey === normTarget
          || normTarget.includes(normLabel) || normLabel.includes(normTarget);
    });
    if (!outcome) {
      res.writeHead(404); res.end(JSON.stringify({ error: 'Outcome ' + outcomeKey + ' not found', outcomes: (mkt.outcomes||[]).map(o=>({key:o.key,label:o.label})) })); return;
    }

    const payout = await fetchExactPayout(mkt.id, outcome.id, amount);
    if (payout == null) {
      res.writeHead(502); res.end(JSON.stringify({ error: 'WS payout returned null' })); return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, expectedPayout: payout, marketId: mkt.id, outcomeId: outcome.id, amount }));
  } catch(e) {
    res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
  }
});

// ── Boot ───────────────────────────────────────────────

if (!SITE_URL || !EV_POSTER_KEY || !RS_AUTH_INFO || !RS_GROUP_ID) {
  console.error('ev-poster: missing required env vars: SITE_URL, EV_POSTER_KEY, RS_AUTH_INFO, RS_GROUP_ID');
  process.exit(1);
}

loadState();
console.log(`ev-poster: starting | group ${RS_GROUP_ID} | min EV ${MIN_EV}% | max ${MAX_POSTS}/run | cooldown ${REPOST_COOLDOWN_MS/60000}min | urgent ≥${REPOST_URGENT_EV}%`);
payoutServer.listen(PAYOUT_PROXY_PORT, () => console.log(`ev-poster: payout proxy on port ${PAYOUT_PROXY_PORT}`));
scheduleMidnightReset();
run();
setInterval(run, 15_000);
