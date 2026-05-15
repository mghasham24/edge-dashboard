// vps-scanner/index.js
// Pure Node.js auction scanner for Hetzner VPS.
// Does NOT log in — receives the live real-auth-info token pushed by
// the Tampermonkey script running in your Mac browser every 30s.
//
// Usage: node --env-file=.env index.js
// .env:  PUSH_SECRET=<shared secret matching the TM script>

import { createServer }                              from 'http';
import { readFileSync, writeFileSync, existsSync }   from 'fs';
import { fileURLToPath }                             from 'url';
import { dirname, join }                             from 'path';
import { randomBytes }                               from 'crypto';

const __dir      = dirname(fileURLToPath(import.meta.url));
const SEEN_FILE  = join(__dir, 'seen-ids.json');
const TOKEN_FILE = join(__dir, 'auth-token.json');

const TG_TOKEN    = process.env.TG_TOKEN  || '';
const TG_CHAT     = process.env.TG_CHAT   || '5439959074';
const MAX_PRICE   = 100;
const TARGETS     = ['dimarco', 'mckennie', 'locatelli', 'grimaldo'];
const POLL_MS     = 2 * 60 * 1000;
const PORT        = 3001;
const PUSH_SECRET = process.env.PUSH_SECRET || 'raxedge-vps-2026';
const CF_LISTINGS_URL = `https://raxedge.com/api/auction/listings?key=${PUSH_SECRET}`;

// ─── Token state (pushed from Tampermonkey) ───────────────────────────────────

let authInfo   = null; // real-auth-info header value
let deviceUuid = process.env.DEVICE_UUID || null; // real-device-uuid header value
let cookieStr  = '';   // cookie header from browser session
let tokenStale = false;

// Bootstrap from env vars — no expiry, permanent fallback
if (process.env.AUTH_INFO) {
  authInfo = process.env.AUTH_INFO;
  deviceUuid = process.env.DEVICE_UUID || '2e0a38e2-0ee8-4f93-9a34-218ac1d10161';
}

function saveToken(ai, du, ck) {
  writeFileSync(TOKEN_FILE, JSON.stringify({ authInfo: ai, deviceUuid: du, cookie: ck, at: Date.now() }));
}
function loadToken() {
  try {
    const d = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
    if (d.authInfo && d.deviceUuid && Date.now() - d.at < 2 * 60 * 60 * 1000) return d;
  } catch (_) {}
  return null;
}

// ─── HTTP token receiver ──────────────────────────────────────────────────────

function startTokenReceiver() {
  createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/token') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const d = JSON.parse(body);
        if (d.secret !== PUSH_SECRET) { res.writeHead(403).end('forbidden'); return; }
        if (!d.authInfo || !d.deviceUuid) { res.writeHead(400).end('missing fields'); return; }
        if (d.authInfo !== authInfo || d.deviceUuid !== deviceUuid || d.cookie !== cookieStr) {
          authInfo   = d.authInfo;
          deviceUuid = d.deviceUuid;
          cookieStr  = d.cookie || '';
          tokenStale = false;
          saveToken(authInfo, deviceUuid, cookieStr);
          console.log('vps-scanner: token updated, prefix:', authInfo.split('!')[0]);
        }
        res.writeHead(200).end('ok');
      } catch (e) { res.writeHead(400).end('bad json'); }
    });
  }).listen(PORT, () => {
    console.log('vps-scanner: token receiver listening on port', PORT);
  });
}

// ─── RS API ───────────────────────────────────────────────────────────────────

function randomRequestToken() {
  return randomBytes(12).toString('base64').replace(/[+/=]/g, '').slice(0, 16);
}

function rsHeaders() {
  const h = {
    'real-auth-info':     authInfo,
    'real-device-uuid':   deviceUuid,
    'real-device-type':   'desktop_web',
    'real-version':       '31',
    'real-request-token': randomRequestToken(),
    'real-device-name':   '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Origin':             'https://realsports.io',
    'Referer':            'https://realsports.io/',
    'Content-Type':       'application/json',
  };
  if (cookieStr) h['cookie'] = cookieStr;
  return h;
}

async function fetchListings() {
  // Route through CF Worker — VPS IP is blocked by RS directly
  const res = await fetch(CF_LISTINGS_URL);
  if (res.status === 401) {
    console.log('vps-scanner: 401 — token stale, waiting for next push');
    tokenStale = true;
    return null;
  }
  if (!res.ok) {
    console.error('vps-scanner: listings error', res.status);
    return null;
  }
  return res.json();
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) console.error('vps-scanner: telegram error', await res.text());
  } catch (e) { console.error('vps-scanner: telegram error', e.message); }
}

// ─── Seen IDs ─────────────────────────────────────────────────────────────────

function loadSeen() {
  try { return new Set(JSON.parse(readFileSync(SEEN_FILE, 'utf8'))); }
  catch (_) { return new Set(); }
}
function saveSeen(set) {
  writeFileSync(SEEN_FILE, JSON.stringify([...set].slice(-1000)));
}

const seen = loadSeen();

// ─── Listing checks ───────────────────────────────────────────────────────────

function getPlayerName(listing) {
  const p = listing.card?.primaryPlayer;
  if (p?.firstName && p?.lastName) return `${p.firstName} ${p.lastName}`;
  if (p?.displayName) return p.displayName;
  return '';
}
function listingPrice(listing) {
  const v = listing.currentBidAmount ?? listing.minBidPrice ?? listing.buyNowPrice ?? null;
  return (v != null && v > 0) ? v : null;
}

async function checkListings(listings) {
  let found = 0;
  for (const listing of listings) {
    const id = String(listing.id ?? listing.listingId ?? '');
    if (!id) continue;
    const isNew = !seen.has(id);
    seen.add(id);
    if (!isNew) continue;
    const name = getPlayerName(listing);
    if (!name || !TARGETS.some(t => name.toLowerCase().includes(t))) continue;
    const price = listingPrice(listing);
    if (price == null || price >= MAX_PRICE) continue;
    const rarity  = listing.card?.rarityLabel || '';
    const endsAt  = listing.endsAt || '';
    const endsStr = endsAt ? ` | Ends: ${new Date(endsAt).toLocaleTimeString()}` : '';
    const buyNow  = listing.buyNowPrice;
    const buyStr  = buyNow ? ` | Buy Now: ${buyNow} Rax` : '';
    const msg = `🔔 <b>Auction Alert</b>\n${name}${rarity ? ` (${rarity})` : ''}\nPrice: <b>${price} Rax</b>${buyStr}${endsStr}`;
    console.log('vps-scanner: ALERT', name, price, 'Rax');
    await sendTelegram(msg);
    found++;
  }
  saveSeen(seen);
  if (!found) console.log('vps-scanner: no matches in', listings.length, 'listing(s)');
}

// ─── Poll loop ────────────────────────────────────────────────────────────────

async function poll() {
  if (tokenStale) { console.log('vps-scanner: token stale, skipping poll'); return; }
  console.log('vps-scanner: polling', new Date().toISOString());
  const data = await fetchListings();
  if (!data) return;
  const listings = data.listings || data.items || data.data || [];
  console.log('vps-scanner: got', listings.length, 'listing(s)');
  if (listings.length) await checkListings(listings);
  else console.log('vps-scanner: empty response');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Restore cached token if recent enough
  const cached = loadToken();
  if (cached) {
    authInfo   = cached.authInfo;
    deviceUuid = cached.deviceUuid;
    cookieStr  = cached.cookie || '';
    console.log('vps-scanner: loaded cached token, prefix:', authInfo.split('!')[0]);
  } else {
    console.log('vps-scanner: no cached token — open realsports.io in your Mac browser to push one');
  }

  startTokenReceiver();
  await sendTelegram('✅ VPS auction scanner started. Waiting for token push from browser.');

  await poll();
  setInterval(() => poll().catch(e => console.error('vps-scanner: poll error:', e.message)), POLL_MS);
}

main().catch(e => { console.error(e); process.exit(1); });
