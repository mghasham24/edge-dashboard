// ev-group-poster/index.js
// Polls RaxEdge /api/ev/current every 60s and posts new +EV bets to an RS group.
//
// Required env vars:
//   SITE_URL      — RaxEdge URL, e.g. https://raxedge.com
//   CRON_SECRET   — Cloudflare CRON_SECRET (for /api/ev/current?_cron_key=)
//   RS_AUTH_INFO  — RS auth token: userId!deviceId!token
//   RS_GROUP_ID   — RS group ID to post to (e.g. 61979)
//
// Optional:
//   RS_DEVICE_UUID — RS device UUID
//   MIN_EV         — minimum EV% to post (default: 5)
//   MAX_POSTS      — cap posts per run (default: 5)
//   POST_DELAY_MS  — ms between consecutive posts (default: 5000)

const SITE_URL      = process.env.SITE_URL;
const CRON_SECRET   = process.env.CRON_SECRET;
const RS_AUTH_INFO  = process.env.RS_AUTH_INFO;
const RS_GROUP_ID   = process.env.RS_GROUP_ID;
const DEVICE_UUID   = process.env.RS_DEVICE_UUID || '2e0a38e2-0ee8-4f93-9a34-218ac1d10161';
const MIN_EV        = parseFloat(process.env.MIN_EV       || '5');
const MAX_POSTS     = parseInt(process.env.MAX_POSTS       || '5');
const POST_DELAY_MS = parseInt(process.env.POST_DELAY_MS  || '5000');

const RS_BASE     = 'https://web.realapp.com';
const RS_WEB_BASE = 'https://www.realsports.io';

// In-memory dedup — cleared at midnight ET each day
const postedKeys = new Set();
let running = false;

// ── RS API helpers ─────────────────────────────────────

function rsHeaders() {
  return {
    'Accept':             'application/json',
    'Content-Type':       'application/json',
    'Origin':             RS_WEB_BASE,
    'Referer':            RS_WEB_BASE + '/',
    'User-Agent':         'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-device-uuid':   DEVICE_UUID,
    'real-device-name':   '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-device-type':   'desktop_web',
    'real-version':       '31',
    'real-request-token': Math.random().toString(36).slice(2, 18),
    'real-auth-info':     RS_AUTH_INFO,
  };
}

// ── Formatting ─────────────────────────────────────────

function formatPost(bet) {
  const ptStr = bet.pt != null ? ' ' + (bet.pt > 0 ? '+' : '') + bet.pt : '';
  const line  = (bet.market === 'ML' || bet.market === 'RFI')
    ? bet.side
    : bet.side + ptStr;

  const evStr   = (bet.ev >= 0 ? '+' : '') + bet.ev.toFixed(1) + '% EV';
  const rsPct   = bet.rsPct      != null ? bet.rsPct.toFixed(1)      + '% RS'   : null;
  const fairPct = bet.adjFairPct != null ? bet.adjFairPct.toFixed(1) + '% Fair' : null;
  const dollar  = Math.round(bet.units * 100) + ' Rax';
  const statsLine = [rsPct, fairPct, evStr, bet.units + 'u · ' + dollar].filter(Boolean).join(' | ');

  const lines = [
    `+EV Pick: ${line} · ${bet.market} · ${bet.sport}`,
    bet.game,
    statsLine,
  ];
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
      const res = await fetch(`${SITE_URL}/api/ev/current?_cron_key=${CRON_SECRET}`, {
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

    // Filter: MIN_EV threshold, skip live bets, skip already posted
    const newBets = evData.bets
      .filter(b => b.ev >= MIN_EV && !b.isLive && !postedKeys.has(b.betKey))
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
        const res = await fetch(`${RS_BASE}/groups/${RS_GROUP_ID}/posts`, {
          method:  'POST',
          headers: rsHeaders(),
          body:    JSON.stringify({
            content: { nodes: [{ type: 'Paragraph', children: [{ text, type: 'Text' }] }] }
          }),
          signal: AbortSignal.timeout(10000),
        });

        if (res.ok) {
          console.log('ev-poster: posted', bet.betKey, '| EV', bet.ev + '%');
          postedKeys.add(bet.betKey);
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
    console.log('ev-poster: midnight ET — clearing', postedKeys.size, 'posted bets');
    postedKeys.clear();
    scheduleMidnightReset();
  }, Math.max(msUntil, 60_000));
}

// ── Boot ───────────────────────────────────────────────

if (!SITE_URL || !CRON_SECRET || !RS_AUTH_INFO || !RS_GROUP_ID) {
  console.error('ev-poster: missing required env vars: SITE_URL, CRON_SECRET, RS_AUTH_INFO, RS_GROUP_ID');
  process.exit(1);
}

console.log(`ev-poster: starting | group ${RS_GROUP_ID} | min EV ${MIN_EV}% | max ${MAX_POSTS}/run`);
scheduleMidnightReset();
run();
setInterval(run, 60_000);
