// marketplace-scanner/index.js
// Polls RS marketplace every 2 min for player PASS listings (listingType=userpassfull).
// Alerts via Telegram when a new pass is listed for any target player.
// No price filter — alert on every new listing.
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
const SEEN_FILE         = join(__dir, 'seen-ids.json');
const SHARED_TOKEN_FILE = '/root/raxedge/shared-token.txt';

const DEVICE_UUID = process.env.RS_DEVICE_UUID || '2e0a38e2-0ee8-4f93-9a34-218ac1d10161';

function getToken() {
  try {
    const t = readFileSync(SHARED_TOKEN_FILE, 'utf8').trim();
    if (t && t.split('!').length === 3) return t;
  } catch(_) {}
  return process.env.RS_AUTH_INFO || '';
}

const RS_PROXY_URL = process.env.RS_PROXY_URL || null;
const TG_TOKEN     = process.env.TG_TOKEN     || '';
const TG_CHAT      = process.env.TG_CHAT      || '';

const POLL_MS = 2 * 60 * 1000;

const TARGETS = [
  // Golf 2026
  { name: 'Scheffler',          entityId: '46046',   sport: 'golf', season: 2026 },
  // Golf 2025
  { name: 'Scheffler',          entityId: '46046',   sport: 'golf', season: 2025 },
  { name: 'Ben Griffin',        entityId: '54591',   sport: 'golf', season: 2025 },
  // Golf 2024
  { name: 'Scheffler',          entityId: '46046',   sport: 'golf', season: 2024 },
  { name: 'Schauffele',         entityId: '48081',   sport: 'golf', season: 2024 },
  // Golf 2023
  { name: 'Scheffler',          entityId: '46046',   sport: 'golf', season: 2023 },
  { name: 'Viktor Hovland',     entityId: '46717',   sport: 'golf', season: 2023 },
  // Golf 2022
  { name: 'Scheffler',          entityId: '46046',   sport: 'golf', season: 2022 },
  // Golf 2021
  { name: 'Jon Rahm',           entityId: '46970',   sport: 'golf', season: 2021 },
  { name: 'Sungjae Im',         entityId: '39971',   sport: 'golf', season: 2021 },
  // Golf 2018
  { name: 'Tony Finau',         entityId: '29725',   sport: 'golf', season: 2018 },
  { name: 'Dustin Johnson',     entityId: '30925',   sport: 'golf', season: 2018 },
  // Golf 2016
  { name: 'Dustin Johnson',     entityId: '30925',   sport: 'golf', season: 2016 },
  // Golf 2015
  { name: 'Spieth',             entityId: '34046',   sport: 'golf', season: 2015 },
  // Soccer 2025
  { name: 'Messi',            entityId: '2337496', sport: 'soccer', season: 2025 },
  { name: 'Haaland',         entityId: '461',     sport: 'soccer', season: 2025 },
  { name: 'Olise',           entityId: '733199',  sport: 'soccer', season: 2025 },
  { name: 'Luis Diaz',       entityId: '397',     sport: 'soccer', season: 2025 },
  { name: 'Vinicius Jr',     entityId: '735023',  sport: 'soccer', season: 2025 },
  { name: 'Enzo Fernandez',  entityId: '184',     sport: 'soccer', season: 2025 },
  { name: 'Mbappe',          entityId: '735009',  sport: 'soccer', season: 2025 },
  { name: 'Kane',            entityId: '733187',  sport: 'soccer', season: 2025 },
  { name: 'Yamal',           entityId: '733142',  sport: 'soccer', season: 2025 },
  { name: 'Bruno Fernandes', entityId: '485',     sport: 'soccer', season: 2025 },
  { name: 'Van Dijk',        entityId: '421',     sport: 'soccer', season: 2025 },
  { name: 'Bellingham',      entityId: '735030',  sport: 'soccer', season: 2025 },
  { name: 'McKennie',        entityId: '734301',  sport: 'soccer', season: 2025 },
  { name: 'Ingvartsen',      entityId: '2338416', sport: 'soccer', season: 2025 },
  // NFL 2025
  { name: 'McCaffrey',       entityId: '18877',   sport: 'nfl', season: 2025 },
  // NFL 2024
  { name: 'Derrick Henry',   entityId: '17959',   sport: 'nfl', season: 2024 },
  // NFL 2023
  { name: 'McCaffrey',       entityId: '18877',   sport: 'nfl', season: 2023 },
  { name: 'Mahomes',         entityId: '18890',   sport: 'nfl', season: 2023 },
];

function buildUrl(sport, entityId, season, offset, beforeEndsAt) {
  let url = `https://web.realapp.com/cardmarketplacelistings?cohort=all&filterEntityType=player&listingType=userpassfull&prestige=all&rarity=all&season=${season}&sport=${sport}&filterEntityId=${entityId}`;
  if (offset) url += `&offset=${offset}`;
  if (beforeEndsAt) url += `&beforeEndsAt=${encodeURIComponent(beforeEndsAt)}`;
  return url;
}

const dispatcher = RS_PROXY_URL ? new ProxyAgent(RS_PROXY_URL) : undefined;

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
  console.log('pass-scanner: loaded', seenIds.size, 'seen IDs');
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
    if (!res.ok) console.error('pass-scanner: telegram error', await res.text());
  } catch(e) { console.error('pass-scanner: telegram error', e.message); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatEndsAt(endsAt) {
  if (!endsAt) return '';
  const diff = new Date(endsAt) - Date.now();
  if (diff <= 0) return ' | Ended';
  const totalHours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (totalHours >= 24) {
    const days = Math.floor(totalHours / 24);
    const hrs  = totalHours % 24;
    return ` | Ends: ${days}d ${hrs}h`;
  }
  return totalHours > 0 ? ` | Ends: ${totalHours}h ${mins}m` : ` | Ends: ${mins}m`;
}

// ── Fetch pass listings for one player ────────────────────────────────────────

async function fetchOnePage(entityId, sport, season, token, offset, beforeEndsAt) {
  const res = await uFetch(buildUrl(sport, entityId, season, offset, beforeEndsAt), {
    dispatcher,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Origin': 'https://realsports.io',
      'Referer': 'https://realsports.io/',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
      'real-device-uuid': DEVICE_UUID,
      'real-device-type': 'desktop_web',
      'real-version': '34',
      'real-request-token': hashidsEncode(Date.now()),
      'real-auth-info': token,
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    console.error('pass-scanner: RS API error', res.status, 'for entity', entityId);
    return [];
  }
  const data = await res.json();
  return data.listings || [];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchListings(entityId, sport, season, token) {
  const PAGE_SIZE = 10;
  const MAX_PAGES = 5;
  const all = [];
  let offset = 0;
  let beforeEndsAt = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await sleep(400); // avoid 429 between pages
    const listings = await fetchOnePage(entityId, sport, season, token, page > 0 ? offset : null, beforeEndsAt);
    all.push(...listings);
    if (listings.length < PAGE_SIZE) break;
    beforeEndsAt = listings[listings.length - 1].endsAt;
    offset += PAGE_SIZE;
  }

  return all;
}

// ── Poll ──────────────────────────────────────────────────────────────────────

async function poll() {
  const token = getToken();
  if (!token) { console.error('pass-scanner: no RS token available'); return; }

  console.log('pass-scanner: poll', new Date().toISOString());

  for (const target of TARGETS) {
    await sleep(300); // 300ms between targets to stay under RS rate limit
    let listings;
    try {
      listings = await fetchListings(target.entityId, target.sport, target.season, token);
    } catch(e) {
      console.error('pass-scanner: fetch error for', target.name, e.message);
      continue;
    }

    console.log('pass-scanner:', target.name, '→', listings.length, 'pass listing(s)');

    for (const listing of listings) {
      const id = String(listing.id || '');
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);

      const name      = listing.card?.label || listing.card?.entity?.firstName + ' ' + listing.card?.entity?.lastName || target.name;
      const rarity    = listing.card?.boostInfo?.rarityLabel || '';
      const rating    = listing.value || listing.card?.boostValue || '';
      const serial    = listing.mintNumber ? `#${listing.mintNumber}` : '';
      const curBid    = listing.currentBidAmount;
      const buyNow    = listing.buyNowPrice;
      const numBids   = listing.numBids || 0;
      const endsStr   = formatEndsAt(listing.endsAt);

      const priceStr  = curBid != null ? `Current bid: <b>${curBid.toLocaleString()} Rax</b>` : '';
      const buyStr    = buyNow && buyNow !== curBid ? ` | Buy Now: ${buyNow.toLocaleString()} Rax` : (buyNow ? ` | Buy Now: ${buyNow.toLocaleString()} Rax` : '');
      const bidsStr   = numBids > 0 ? ` | ${numBids} bid${numBids !== 1 ? 's' : ''}` : '';
      const link      = `https://realapp.com/cards?sport=${target.sport}&filterEntityId=${target.entityId}&listingType=userpassfull&sort=new`;

      const seasonTag = target.sport !== 'soccer' ? ` (${target.season})` : '';
      const priceForAvg = buyNow || curBid;
      const avgRaw    = (priceForAvg && rating) ? Math.round(priceForAvg / rating) : null;
      const avgVal    = avgRaw != null ? avgRaw.toLocaleString() : null;
      const sportEmoji = { golf: '⛳', soccer: '⚽', nfl: '🏈', nba: '🏀', nhl: '🏒', baseball: '⚾' }[target.sport] || '🎮';
      const isDeal    = avgRaw != null && avgRaw <= 20;
      if (target.sport === 'golf' && !isDeal) continue;
      const header    = isDeal ? `🔥 <b>Deal Alert</b>` : `${sportEmoji} <b>Pass Listed</b>`;
      const line1     = `${name}${seasonTag}${rarity ? ` · ${rarity}` : ''}${avgVal ? ` · ${avgVal} Rax/pt` : ''}`;
      const line2     = [rating ? `${rating} rated` : '', serial].filter(Boolean).join(' · ');
      const line3     = `${priceStr}${buyStr}${bidsStr}${endsStr}`;
      const msg = `${header}\n${line1}${line2 ? '\n' + line2 : ''}\n${line3}\n<a href="${link}">View on RS ↗</a>`;

      console.log(`pass-scanner: ALERT ${target.name} | ${rarity} | ${rating} | bid ${curBid} | buy ${buyNow}`);
      await sendTelegram(msg);
    }
  }

  saveSeen();
}

// ── Start ─────────────────────────────────────────────────────────────────────

loadSeen();
await sendTelegram('✅ Pass scanner started. Targets: ' + TARGETS.map(t => t.name).join(', '));
await poll();
setInterval(poll, POLL_MS);
