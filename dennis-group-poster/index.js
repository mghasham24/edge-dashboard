// dennis-group-poster — posts daily messages to RS groups on a schedule (ET)
//
// Required env vars:
//   RS_AUTH_INFO  — RS auth string: userId!deviceId!token
//   RS_DEVICE_UUID — (optional) RS device UUID

import { writeFileSync, readFileSync } from 'fs';

const RS_AUTH_INFO  = process.env.RS_AUTH_INFO;
const DEVICE_UUID   = process.env.RS_DEVICE_UUID || '2e0a38e2-0ee8-4f93-9a34-218ac1d10161';
const STATE_FILE    = process.env.STATE_FILE || '/Users/mohamadghasham/Library/Logs/dennis-group-poster-state.json';

const RS_BASE     = 'https://web.realapp.com';
const RS_WEB_BASE = 'https://realsports.io';

if (!RS_AUTH_INFO) {
  console.error('dennis-poster: RS_AUTH_INFO env var is required');
  process.exit(1);
}

// ── Scheduled posts ───────────────────────────────────────────────────────────

const POSTS = [
  {
    name:    'morning boost',
    groupId: '60001',
    hour:    8,
    minute:  0,
    msg:     'Good Morning!\n• Reminder To Boost All Necessary Players Today!\n• Need Help? Go Visit ⬇️ https://slybot.vercel.app\n• Remember To Claim OTD',
  },
  {
    name:    'dennis boost',
    groupId: '51048',
    hour:    8,
    minute:  30,
    msg:     'For daily personalized boosts, dm @slybot $optin https://www.realapp.com/joclFa5yikR5/178224697440600001\n‍⠀⠀⠀\nClaim OTD\n‍⠀⠀⠀\nMake sure to enter giveaway https://www.realapp.com/joclFa5yikR5/178207176251200001',
  },
];

// ── Hashids encode (real-request-token, salt = 'realwebapp') ─────────────────

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
  const SEPS_RAW = Array.from('cfhistuCFHISTU');
  let ALPHA = keepUnique(without(
    Array.from('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'),
    SEPS_RAW
  ));
  let SEPS = shuffle(only(ALPHA, SEPS_RAW).concat(only(SEPS_RAW, ALPHA)), saltChars);
  ALPHA = shuffle(without(ALPHA, SEPS), saltChars);
  const GUARD_DIV = 12;
  const guardCount = Math.ceil(ALPHA.length / GUARD_DIV);
  let GUARDS;
  if (ALPHA.length < 3) { GUARDS = SEPS.slice(0, guardCount); SEPS = SEPS.slice(guardCount); }
  else { GUARDS = ALPHA.slice(0, guardCount); ALPHA = ALPHA.slice(guardCount); }
  const lottery = ALPHA[number % ALPHA.length];
  let ret = [lottery];
  const nums = [number];
  for (let i=0; i<nums.length; i++) {
    const alpha2 = shuffle([...ALPHA], [lottery, ...saltChars]);
    const last = toAlpha(nums[i], alpha2);
    ret.push(...last);
    if (i+1 < nums.length) { ret.push(SEPS[(nums[i] + ret[1].codePointAt(0)) % SEPS.length]); }
  }
  if (ret.length < minLen) {
    ret.unshift(GUARDS[(number + ret[0].codePointAt(0)) % GUARDS.length]);
    if (ret.length < minLen) ret.push(GUARDS[(number + ret[2].codePointAt(0)) % GUARDS.length]);
  }
  const halfLen = Math.floor(ALPHA.length / 2);
  while (ret.length < minLen) {
    ALPHA = shuffle(ALPHA, ALPHA);
    ret.unshift(...ALPHA.slice(halfLen));
    ret.push(...ALPHA.slice(0, halfLen));
    const excess = ret.length - minLen;
    if (excess > 0) { ret = ret.slice(Math.floor(excess/2), Math.floor(excess/2) + minLen); }
  }
  return ret.join('');
}

// ── RS headers ───────────────────────────────────────────────────────────────

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

// ── State persistence — survive restarts ─────────────────────────────────────

const firedDates = {}; // name → ET date string of last fire

function loadState() {
  try {
    const data = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    Object.assign(firedDates, data.firedDates || {});
    console.log('dennis-poster: loaded state —', JSON.stringify(firedDates));
  } catch { /* first run */ }
}

function saveState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ firedDates }));
  } catch(e) { console.error('dennis-poster: failed to save state:', e.message); }
}

// ── ET date helper ────────────────────────────────────────────────────────────

function etDateStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ── Post + schedule ───────────────────────────────────────────────────────────

async function post(p) {
  const today = etDateStr();
  if (firedDates[p.name] === today) {
    console.log(`dennis-poster: ${p.name} already fired today (${today}), skipping`);
    return;
  }
  try {
    const res = await fetch(`${RS_BASE}/comments/groups/${p.groupId}`, {
      method: 'POST',
      headers: rsHeaders(),
      body: JSON.stringify({ text: p.msg, content: { nodes: [{ text: p.msg }] } }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      firedDates[p.name] = today;
      saveState();
      console.log(`dennis-poster: ${p.name} posted (${today})`);
    } else {
      const body = await res.text().catch(() => '');
      console.error(`dennis-poster: ${p.name} failed`, res.status, body);
    }
  } catch(e) {
    console.error(`dennis-poster: ${p.name} error:`, e.message);
  }
}

function schedulePost(p) {
  const etStr  = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et     = new Date(etStr);
  const next   = new Date(et);
  next.setHours(p.hour, p.minute, 0, 0);
  if (next <= et) next.setDate(next.getDate() + 1);
  const msUntil = next - et;
  const h = Math.floor(msUntil / 3600000);
  const m = Math.floor((msUntil % 3600000) / 60000);
  console.log(`dennis-poster: ${p.name} scheduled in ${h}h ${m}m (${p.hour}:${String(p.minute).padStart(2,'0')} ET)`);
  setTimeout(async () => {
    await post(p);
    schedulePost(p);
  }, msUntil);
}

// ── Start ─────────────────────────────────────────────────────────────────────

loadState();
for (const p of POSTS) schedulePost(p);
