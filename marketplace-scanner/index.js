// marketplace-scanner/index.js
// Pure HTTP FC marketplace scanner. Polls RS card marketplace every 2 min.
// No Playwright. Sends Telegram alert when a target player card is listed
// at or below their rating × RAX_PER_RATING.
//
// Required env vars:
//   RS_AUTH_INFO   — RS auth token: userId!deviceId!token
//   RS_DEVICE_UUID — RS device UUID
//   RS_PROXY_URL   — residential proxy (required on VPS — RS blocks datacenter IPs)
//   TG_TOKEN       — Telegram bot token
//   TG_CHAT        — Telegram chat ID to send alerts to

import { ProxyAgent, fetch as uFetch } from 'undici';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const SEEN_FILE       = join(__dir, 'seen-ids.json');
const SHARED_TOKEN_FILE = '/root/raxedge/shared-token.txt';

const DEVICE_UUID    = process.env.RS_DEVICE_UUID  || '2e0a38e2-0ee8-4f93-9a34-218ac1d10161';

// Token: shared file written by pack scanner (freshest) → .env fallback
function getToken() {
  try {
    const t = readFileSync(SHARED_TOKEN_FILE, 'utf8').trim();
    if (t && t.split('!').length === 3) return t;
  } catch(_) {}
  return process.env.RS_AUTH_INFO || '';
}
const RS_PROXY_URL   = process.env.RS_PROXY_URL    || null;
const TG_TOKEN       = process.env.TG_TOKEN        || '';
const TG_CHAT        = process.env.TG_CHAT         || '';

const TARGETS        = ['guilavogui', 'ojeda', 'denkey', 'pec', 'grimaldo', 'ingvartsen', 'arfsten'];
const RAX_PER_RATING = 13;
const POLL_MS        = 2 * 60 * 1000;

const RS_API_URL = 'https://web.realapp.com/cardmarketplacelistings?sport=soccer&sort=new&offset=0';

const dispatcher = RS_PROXY_URL ? new ProxyAgent(RS_PROXY_URL) : undefined;

const RS_WEB_BASE = 'https://realsports.io';
const DEVICE_NAME = '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15';

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

// ── Seen IDs ──────────────────────────────────────────────────────────────────

let seenIds = new Set();

function loadSeen() {
  if (existsSync(SEEN_FILE)) {
    try { seenIds = new Set(JSON.parse(readFileSync(SEEN_FILE, 'utf8'))); } catch(_) {}
  }
  console.log('marketplace: loaded', seenIds.size, 'seen IDs');
}

function saveSeen() {
  writeFileSync(SEEN_FILE, JSON.stringify([...seenIds]));
}

// ── Telegram ──────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) console.error('marketplace: telegram error', await res.text());
  } catch(e) { console.error('marketplace: telegram error', e.message); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getPlayerName(listing) {
  const p = listing.card?.primaryPlayer;
  if (!p) return null;
  return [p.firstName, p.lastName].filter(Boolean).join(' ');
}

function cardRating(card) {
  if (!card) return null;
  return card.value ?? card.score ?? card.rating ?? card.overallScore ?? card.overallRating ?? null;
}

function listingPrice(listing) {
  return listing.currentBidAmount ?? listing.minBidPrice ?? listing.buyNowPrice ?? null;
}

function formatEndsAt(endsAt) {
  if (!endsAt) return '';
  const diff = new Date(endsAt) - Date.now();
  if (diff <= 0) return ' | Ended';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return h > 0 ? ` | Ends: ${h}h ${m}m` : ` | Ends: ${m}m`;
}

// ── Poll ──────────────────────────────────────────────────────────────────────

async function poll() {
  const token = getToken();
  if (!token) { console.error('marketplace: no RS token available'); return; }

  let listings;
  try {
    const res = await uFetch(RS_API_URL, {
      dispatcher,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': RS_WEB_BASE,
        'Referer': RS_WEB_BASE + '/',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
        'real-device-uuid': DEVICE_UUID,
        'real-device-name': DEVICE_NAME,
        'real-device-type': 'desktop_web',
        'real-version': '32',
        'real-request-token': hashidsEncode(Date.now()),
        'real-auth-info': token,
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) { console.error('marketplace: RS API error', res.status); return; }
    const data = await res.json();
    listings = data.listings || data.items || data.data || [];
  } catch(e) {
    console.error('marketplace: fetch error', e.message);
    return;
  }

  console.log('marketplace: poll', new Date().toISOString(), '—', listings.length, 'listing(s)');

  let found = 0;
  for (const listing of listings) {
    const id = String(listing.id ?? listing.listingId ?? '');
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);

    const name = getPlayerName(listing);
    if (!name) continue;
    if (!TARGETS.some(t => name.toLowerCase().includes(t))) continue;

    const rating   = cardRating(listing.card) ?? cardRating(listing.card?.card);
    const price    = listingPrice(listing);
    const maxPrice = rating != null ? rating * RAX_PER_RATING : null;

    if (price == null) continue;

    if (maxPrice != null && price > maxPrice) {
      console.log(`marketplace: ${name} | rating ${rating} | price ${price} > max ${maxPrice.toFixed(1)} — skip`);
      continue;
    }

    found++;

    const rarity   = listing.card?.rarityLabel || '';
    const buyNow   = listing.buyNowPrice;
    const endsStr  = formatEndsAt(listing.endsAt);
    const ratingStr = rating != null ? ` | Rating: ${rating}` : '';
    const maxStr   = maxPrice != null ? ` | Max: ${maxPrice.toFixed(0)} Rax` : '';
    const buyStr   = buyNow && buyNow !== price ? ` | Buy Now: ${buyNow} Rax` : '';
    const hash     = listing.card?.hash || listing.card?.shareHash || listing.shareHash || '';
    const cardUrl  = hash ? `\nhttps://www.realapp.com/${hash}` : '';

    const msg = `🛒 <b>Marketplace Alert</b>\n${name}${rarity ? ` (${rarity})` : ''}${ratingStr}${maxStr}\nPrice: <b>${price} Rax</b>${buyStr}${endsStr}${cardUrl}`;
    console.log(`marketplace: ALERT ${name} | ${rarity} | rating ${rating} | price ${price} / max ${maxPrice?.toFixed(0)}`);
    await sendTelegram(msg);
  }

  if (!found) console.log('marketplace: no matches');
  saveSeen();
}

// ── Start ─────────────────────────────────────────────────────────────────────

loadSeen();
await sendTelegram('✅ Marketplace scanner started. Targets: ' + TARGETS.join(', '));
await poll();
setInterval(poll, POLL_MS);
