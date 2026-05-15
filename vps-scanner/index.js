// vps-scanner/index.js
// Pure Node.js auction + pack alert scanner for Hetzner VPS.
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

const __dir           = dirname(fileURLToPath(import.meta.url));
const SEEN_FILE       = join(__dir, 'seen-ids.json');
const PACK_SEEN_FILE  = join(__dir, 'pack-seen-ids.json');
const TOKEN_FILE      = join(__dir, 'auth-token.json');

const TG_TOKEN    = process.env.TG_TOKEN  || '';
const TG_CHAT     = process.env.TG_CHAT   || '5439959074';
const MAX_PRICE   = 100;
const TARGETS     = ['dimarco', 'mckennie', 'locatelli', 'grimaldo', 'maia'];
const POLL_MS     = 2 * 60 * 1000;       // auction poll: every 2 min
const PACK_POLL_MS = 3 * 60 * 1000;      // pack poll: every 3 min
const PACK_FRESH_MS = 10 * 60 * 1000;    // ignore pack cards older than 10 min
const PORT        = 3001;
const PUSH_SECRET = process.env.PUSH_SECRET || 'raxedge-vps-2026';
const CF_LISTINGS_URL   = `https://raxedge.com/api/auction/listings?key=${PUSH_SECRET}`;
const CF_GLOBALCARDS_URL = (sport) => `https://raxedge.com/api/auction/globalcards?key=${PUSH_SECRET}&sport=${sport}`;

// ─── Token state (pushed from Tampermonkey) ───────────────────────────────────

let authInfo   = null;
let deviceUuid = process.env.DEVICE_UUID || null;
let cookieStr  = '';
let tokenStale = false;

if (process.env.AUTH_INFO) {
  authInfo   = process.env.AUTH_INFO;
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

// ─── Auction seen IDs ─────────────────────────────────────────────────────────

function loadSeen() {
  try { return new Set(JSON.parse(readFileSync(SEEN_FILE, 'utf8'))); }
  catch (_) { return new Set(); }
}
function saveSeen(set) {
  writeFileSync(SEEN_FILE, JSON.stringify([...set].slice(-1000)));
}

const seen = loadSeen();

// ─── Pack seen IDs ────────────────────────────────────────────────────────────

const packSeen = (() => {
  try { return new Set(JSON.parse(readFileSync(PACK_SEEN_FILE, 'utf8'))); }
  catch (_) { return new Set(); }
})();
function savePackSeen() {
  writeFileSync(PACK_SEEN_FILE, JSON.stringify([...packSeen].slice(-3000)));
}

// ─── Auction listing checks ───────────────────────────────────────────────────

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
    console.log('vps-scanner: AUCTION ALERT', name, price, 'Rax');
    await sendTelegram(msg);
    found++;
  }
  saveSeen(seen);
  if (!found) console.log('vps-scanner: no auction matches in', listings.length, 'listing(s)');
}

// ─── Pack / global card checks ────────────────────────────────────────────────

function getPackPlayerName(card) {
  if (card.label && /\s/.test(card.label) && !/^\d/.test(card.label)) return card.label;
  const entity = card.entity || card.card?.entity || card.play?.entity;
  if (entity) {
    if (entity.firstName && entity.lastName) return `${entity.firstName} ${entity.lastName}`;
    if (entity.displayName) return entity.displayName;
  }
  const sources = [card.primaryPlayer, card.player, card.card?.primaryPlayer, card.play?.primaryPlayer];
  for (const p of sources) {
    if (!p) continue;
    if (p.firstName && p.lastName) return `${p.firstName} ${p.lastName}`;
    if (p.displayName) return p.displayName;
    if (p.name) return p.name;
  }
  return card.playerName || card.name || '';
}

function isPackCardFresh(card) {
  const ts = card.createdAt || card.earned || card.updatedAt
          || card.play?.createdAt || card.card?.createdAt || card.earnedAt;
  if (!ts) return true;
  return Date.now() - new Date(ts).getTime() < PACK_FRESH_MS;
}

function cardRating(obj) {
  if (!obj) return null;
  const v = obj.value ?? obj.score ?? obj.rating ?? obj.overallScore ?? null;
  const n = parseFloat(v);
  return (!isNaN(n) && n > 0) ? n : null;
}

async function checkPackCards(cards, sport) {
  let found = 0;
  for (const card of cards) {
    const id = String(card.id || card.cardId || card.playId || '');
    if (!id) continue;
    const alreadySeen = packSeen.has(id);
    packSeen.add(id);
    if (alreadySeen) continue;
    if (!isPackCardFresh(card)) {
      console.log('vps-scanner: pack card too old, skipping id:', id);
      continue;
    }
    const name = getPackPlayerName(card);
    if (!name || !TARGETS.some(t => name.toLowerCase().includes(t))) continue;
    const rarity    = card.rarityLabel || card.card?.rarityLabel || '';
    const rating    = cardRating(card) ?? cardRating(card.card) ?? cardRating(card.play);
    const owner     = card.username || card.ownerUsername || card.user?.username || '';
    const label     = sport === 'ufc' ? 'UFC' : 'FC';
    const ratingStr = rating != null ? ` | Rating: ${rating}` : '';
    const ownerStr  = owner ? `\nOwned by: ${owner}` : '';
    const msg = `🃏 <b>Pack Alert</b> (${label})\n${name}${rarity ? ` (${rarity})` : ''}${ratingStr}${ownerStr}`;
    console.log('vps-scanner: PACK ALERT', name, rarity, sport);
    await sendTelegram(msg);
    found++;
  }
  savePackSeen();
  if (!found && cards.length) console.log('vps-scanner: no target packs in', cards.length, sport, 'card(s)');
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchListings() {
  const res = await fetch(CF_LISTINGS_URL);
  if (res.status === 401) { tokenStale = true; return null; }
  if (!res.ok) { console.error('vps-scanner: listings error', res.status); return null; }
  return res.json();
}

async function fetchGlobalCards(sport) {
  const res = await fetch(CF_GLOBALCARDS_URL(sport));
  if (res.status === 401) { tokenStale = true; return null; }
  if (!res.ok) { console.error('vps-scanner: globalcards error', sport, res.status); return null; }
  try { return await res.json(); }
  catch (e) { console.error('vps-scanner: globalcards parse error', sport, e.message); return null; }
}

// ─── Poll loops ───────────────────────────────────────────────────────────────

async function poll() {
  if (tokenStale) { console.log('vps-scanner: token stale, skipping auction poll'); return; }
  console.log('vps-scanner: auction poll', new Date().toISOString());
  const data = await fetchListings();
  if (!data) return;
  const listings = data.listings || data.items || data.data || [];
  console.log('vps-scanner: got', listings.length, 'listing(s)');
  if (listings.length) await checkListings(listings);
  else console.log('vps-scanner: empty auction response');
}

async function pollPackAlerts() {
  if (tokenStale) { console.log('vps-scanner: token stale, skipping pack poll'); return; }
  console.log('vps-scanner: pack poll', new Date().toISOString());
  for (const sport of ['soccer', 'ufc']) {
    const data = await fetchGlobalCards(sport);
    if (!data) continue;
    const cards = data.cards || data.items || data.data || data.plays || [];
    console.log('vps-scanner: got', cards.length, sport, 'global card(s)');
    if (cards.length) await checkPackCards(cards, sport);
    else console.log('vps-scanner: empty globalcards response for', sport);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
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
  await sendTelegram('✅ VPS scanner started (auction + pack alerts). Targets: ' + TARGETS.join(', '));

  await poll();
  await pollPackAlerts();

  setInterval(() => poll().catch(e => console.error('vps-scanner: poll error:', e.message)), POLL_MS);
  setInterval(() => pollPackAlerts().catch(e => console.error('vps-scanner: pack poll error:', e.message)), PACK_POLL_MS);
}

main().catch(e => { console.error(e); process.exit(1); });
