// auction-scanner/index.js
// Single-page approach: one Chromium page handles both marketplace polls (15s)
// and per-player global card scans (every 3 min, ~25s each).
// Marketplace polls are skipped while GC scan runs to avoid interference.

import { chromium }                               from 'playwright';
import Hashids                                     from 'hashids';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { createInterface }                         from 'readline';
import { fileURLToPath }                           from 'url';
import { dirname, join }                           from 'path';
import { randomBytes }                             from 'crypto';

const __dir           = dirname(fileURLToPath(import.meta.url));
const STATE_FILE      = join(__dir, 'auth-state.json');
const SEEN_FILE       = join(__dir, 'seen-ids.json');
const PACK_SEEN_FILE  = join(__dir, 'pack-seen-ids.json');
const ENTITY_FILE     = join(__dir, 'gc-entity-ids.json');

const HASHIDS   = new Hashids('routing', 11);
const TG_TOKEN  = '8258151239:AAEAgFjbcYdpHU8Jyd6kR6xoj5uSiOvZDeY';
const TG_CHAT   = '5439959074';

// Marketplace + pack alert targets (same list for both)
const GC_FC_TARGETS  = ['dimarco', 'mckennie', 'grimaldo', 'locatelli'];
const GC_UFC_TARGETS = ['maia'];
const TARGETS = [...GC_FC_TARGETS, ...GC_UFC_TARGETS];

// Search term overrides: "maia" would match "Maiara Amanajas dos Santos" before "Demian Maia"
const GC_SEARCH_OVERRIDES = { maia: 'demian' };

const POLL_MS        = 15 * 1000;
const GLOBAL_SCAN_MS = 3 * 60 * 1000; // every 3 minutes
const PACK_FRESH_MS  = 10 * 60 * 1000; // only alert cards pulled within 10 minutes

// ─── Seen IDs ─────────────────────────────────────────────────────────────────

function loadSeen() {
  try { return new Set(JSON.parse(readFileSync(SEEN_FILE, 'utf8'))); }
  catch (_) { return new Set(); }
}
function saveSeen(set) {
  writeFileSync(SEEN_FILE, JSON.stringify([...set].slice(-1000)));
}
const seen = loadSeen();

const packSeen = (() => {
  try { return new Set(JSON.parse(readFileSync(PACK_SEEN_FILE, 'utf8'))); }
  catch (_) { return new Set(); }
})();
function savePackSeen() {
  writeFileSync(PACK_SEEN_FILE, JSON.stringify([...packSeen].slice(-2000)));
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) console.error('auction-scanner: telegram error', await res.text());
  } catch (e) { console.error('auction-scanner: telegram error', e.message); }
}

// ─── Marketplace listing checks ───────────────────────────────────────────────

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
function cardRating(card) {
  if (!card) return null;
  const r = card.value ?? card.score ?? card.rating ?? card.overallScore ?? card.overallRating ?? null;
  const n = parseFloat(r);
  return (!isNaN(n) && n > 0) ? n : null;
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

    const price  = listingPrice(listing);
    const rating = (listing.value != null && listing.value > 0) ? listing.value : cardRating(listing.card);
    const endsAt = listing.endsAt || '';
    const endsStr = (() => {
      if (!endsAt) return '';
      const ms = new Date(endsAt) - Date.now();
      if (ms <= 0) return ' | Ends: now';
      const m = Math.floor(ms / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      return m > 0 ? ` | Ends in: ${m}m ${s}s` : ` | Ends in: ${s}s`;
    })();
    const buyNow   = listing.buyNowPrice;
    const buyStr   = buyNow ? ` | Buy Now: ${buyNow} Rax` : '';
    const priceStr = price != null ? `${price} Rax` : 'unknown';
    const ratingStr = rating != null ? `\nRating: ${rating}` : '';
    const valueStr  = (rating != null && price != null && price > 0)
      ? ` | ${(price / rating).toFixed(1)} Rax/★`
      : '';
    const numericId   = listing.id ?? listing.listingId;
    const listingCode = numericId != null ? HASHIDS.encode([30, 0, 0, numericId]) : '';
    const urlLine     = listingCode ? `\n<a href="https://www.realapp.com/${listingCode}">View Listing ↗</a>` : '';
    const msg = `🔔 <b>Auction Alert</b>\n${name}\nPrice: <b>${priceStr}</b>${buyStr}${endsStr}${ratingStr}${valueStr}${urlLine}`;
    console.log('auction-scanner: ALERT', name, price, 'Rax', rating ? `| rating ${rating}` : '');
    await sendTelegram(msg);
    found++;
  }
  saveSeen(seen);
  if (!found) console.log('auction-scanner: no matches in', listings.length, 'listing(s)');
}

// ─── Pack / global card checks ────────────────────────────────────────────────

function getPackPlayerName(card) {
  // Global cards API uses `label` and `entity` fields, not primaryPlayer
  if (card.label && card.label.includes(' ')) return card.label;
  const entity = card.entity || card.card?.entity || card.play?.entity;
  if (entity?.firstName && entity?.lastName) return `${entity.firstName} ${entity.lastName}`;
  if (entity?.displayName) return entity.displayName;
  const sources = [card.primaryPlayer, card.player, card.card?.primaryPlayer, card.play?.primaryPlayer];
  for (const p of sources) {
    if (!p) continue;
    if (p.firstName && p.lastName) return `${p.firstName} ${p.lastName}`;
    if (p.displayName) return p.displayName;
    if (p.name) return p.name;
  }
  return card.playerName || card.name || card.label || '';
}

function isPackCardFresh(card) {
  const ts = card.createdAt || card.earned || card.updatedAt
          || card.play?.createdAt || card.card?.createdAt || card.earnedAt;
  if (!ts) return true; // no timestamp → trust packSeen dedup
  return Date.now() - new Date(ts).getTime() < PACK_FRESH_MS;
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
      console.log('auction-scanner: GC card too old, skipping id:', id,
        '| createdAt:', card.createdAt || card.earned || '(none)');
      continue;
    }
    const name = getPackPlayerName(card);
    if (!name || !TARGETS.some(t => name.toLowerCase().includes(t))) continue;
    const rarity    = card.rarityLabel || card.card?.rarityLabel || '';
    const rating    = cardRating(card) ?? cardRating(card.card) ?? cardRating(card.play);
    const owner     = card.username || card.ownerUsername || card.user?.username || '';
    const ratingStr = rating != null ? ` | Rating: ${rating}` : '';
    const ownerStr  = owner ? `\nOwned by: ${owner}` : '';
    const numericId = card.id ?? card.cardId ?? card.playId;
    const cardHash  = card.hashId || (numericId != null ? HASHIDS.encode([20, 0, 0, numericId]) : '');
    const cardUrl   = cardHash ? `https://www.realapp.com/${cardHash}` : '';
    const urlLine   = cardUrl ? `\n<a href="${cardUrl}">View Card ↗</a>` : '';
    const msg = `🃏 <b>Pack Alert</b> (${sport.toUpperCase()})\n${name}${rarity ? ` (${rarity})` : ''}${ratingStr}${ownerStr}${urlLine}`;
    console.log('auction-scanner: PACK ALERT', name, rarity, sport, cardUrl || '(no url)');
    await sendTelegram(msg);
    savePackSeen(); // persist immediately so restarts don't re-alert
    found++;
  }
  if (!found && cards.length) console.log('auction-scanner: no target packs in', cards.length, sport, 'card(s)');
}

// ─── Setup mode ───────────────────────────────────────────────────────────────

async function setup() {
  console.log('\nauction-scanner: SETUP MODE');
  console.log('A browser will open. Log in to realsports.io, then press Enter.\n');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page    = await context.newPage();
  await page.goto('https://realsports.io');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => rl.question('Press Enter after logging in... ', resolve));
  rl.close();
  await context.storageState({ path: STATE_FILE });
  console.log('\nauction-scanner: auth state saved.');
  await browser.close();
}

// ─── Scanner mode ─────────────────────────────────────────────────────────────

async function scan() {
  if (!existsSync(STATE_FILE)) {
    console.error('auction-scanner: no auth state. Run: node index.js --setup');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: STATE_FILE });
  const page    = await context.newPage();

  let liveToken         = null;
  let liveDeviceUuid    = null;
  let liveCookie        = '';
  let capturedHeaders   = null; // full headers from a marketplace request
  let capturedGcHeaders = null; // auth headers captured from a successful globalcards request
  let listingsFromRoute = [];
  let gcScanning        = false;
  let pendingGcData     = null; // { cards, ts } populated by response listener
  let currentGcTarget   = null; // set while UI-filtering to learn entity IDs

  // Load entity ID cache (maps player key → { entityId, apiUrl })
  const gcEntityIds = (() => {
    try { return JSON.parse(readFileSync(ENTITY_FILE, 'utf8')); } catch(_) { return {}; }
  })();
  function saveEntityIds() {
    writeFileSync(ENTITY_FILE, JSON.stringify(gcEntityIds, null, 2));
  }

  // FIFO queue for entity ID attribution — UI search resolves ~90s after Enter,
  // so responses arrive out of sync with currentGcTarget. Queue preserves order.
  const filterQueue = [];

  // Intercept globalcards via route.fetch() — captures data even under rate limiting,
  // and gives us the exact request URL for FIFO entity ID attribution.
  await page.route('**/globalcards**', async route => {
    try {
      const origUrl = route.request().url();
      let fetchUrl = origUrl;
      if (origUrl.includes('filterEntityId')) {
        fetchUrl = fetchUrl.includes('view=') ? fetchUrl.replace(/view=[^&]+/, 'view=new') : fetchUrl + '&view=new';
        fetchUrl = fetchUrl.includes('sort=') ? fetchUrl.replace(/sort=[^&]+/, 'sort=new') : fetchUrl + '&sort=new';
        fetchUrl = fetchUrl.includes('pageSize=') ? fetchUrl.replace(/pageSize=\d+/, 'pageSize=50') : fetchUrl + '&pageSize=50';
        fetchUrl = fetchUrl.includes('limit=') ? fetchUrl.replace(/limit=\d+/, 'limit=50') : fetchUrl + '&limit=50';
      }
      // Always capture auth headers from globalcards requests (these are the correct headers for this endpoint)
      const reqHeaders = route.request().headers();
      if (reqHeaders['real-auth-info']) capturedGcHeaders = { ...reqHeaders };

      // Inject captured auth headers when making the fetch so direct API path benefits too
      const fetchOpts = { url: fetchUrl };
      if (capturedGcHeaders && !reqHeaders['real-auth-info']) {
        fetchOpts.headers = capturedGcHeaders;
      }
      const response = await route.fetch(fetchOpts);
      const status   = response.status();
      const text     = await response.text();
      if (status !== 200) {
        const url = route.request().url();
        const shortened = url.includes('filterEntityId') ? url.replace(/.*filterEntityId=(\d+).*/, 'filterEntityId=$1') : '(unfiltered)';
        console.log('auction-scanner: GC route', status, shortened);
        await route.fulfill({ response, body: text });
        return;
      }
      try {
        const data  = JSON.parse(text);
        const url   = route.request().url();
        const sport = url.includes('/ufc/') ? 'ufc' : 'soccer';
        const cards = data.cards || data.items || data.data || data.plays || [];
        console.log('auction-scanner: GC captured', sport, cards.length, 'card(s)');
        const gcTs = Date.now();
        pendingGcData = { cards, sport, ts: gcTs };

        // Process cards immediately — route handler fires even if filterByPlayer already timed out
        if (cards.length && url.includes('filterEntityId')) {
          checkPackCards(cards, sport).catch(() => {});
        }

        // FIFO attribution: match filtered responses to the player that triggered them
        if (url.includes('filterEntityId') && filterQueue.length) {
          const target = filterQueue.shift();
          if (!gcEntityIds[target]) {
            try {
              const u        = new URL(url);
              const entityId = u.searchParams.get('filterEntityId');
              const apiUrl   = u.origin + u.pathname;
              if (entityId) {
                gcEntityIds[target] = { entityId, apiUrl };
                saveEntityIds();
                console.log('auction-scanner: GC entity ID saved:', target, '=', entityId);
              }
            } catch(_) {}
          } else {
            // Already known — discard this queue slot
          }
        }
      } catch(_) {}
      await route.fulfill({ response, body: text });
    } catch(e) { await route.continue(); }
  });

  await page.route('**/cardmarketplacelistings**', async route => {
    const url = route.request().url();
    if (url.includes('/bid') || url.includes('/info') || url.includes('/bidhistory')) {
      return route.continue();
    }
    try {
      // Always refresh auth headers from marketplace requests so direct API path stays fresh
      const h = route.request().headers();
      if (h['real-auth-info']) capturedHeaders = { ...h };
      const sortedUrl = url.includes('sort=')
        ? url.replace(/sort=[^&]+/, 'sort=new')
        : url + '&sort=new';
      const response = await route.fetch({ url: sortedUrl });
      const text     = await response.text();
      try {
        const data     = JSON.parse(text);
        const listings = data.listings || data.items || data.data || [];
        if (listings.length) {
          console.log('auction-scanner: intercepted', listings.length, 'listing(s)');
          listingsFromRoute = listings;
        }
      } catch(_) {}
      await route.fulfill({ response, body: text });
    } catch(e) { await route.continue(); }
  });

  page.on('request', request => {
    const url = request.url();
    if (!url.includes('realapp.com')) return;
    const headers = request.headers();
    const auth = headers['real-auth-info'];
    if (auth && auth.split('!').length === 3 && auth !== liveToken) {
      liveToken      = auth;
      liveDeviceUuid = headers['real-device-uuid'] || liveDeviceUuid;
      liveCookie     = headers['cookie'] || liveCookie;
      console.log('auction-scanner: session alive, prefix:', auth.split('!')[0]);
    }
  });

  // ── Navigation helpers ────────────────────────────────────────────────────────

  let marketplaceY = null;

  async function clickTab(label) {
    try {
      await page.evaluate((lbl) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while ((node = walker.nextNode())) {
          if (node.nodeValue.trim() === lbl) {
            const el = node.parentElement;
            if (el?.offsetParent) { el.click(); return; }
          }
        }
      }, label);
      await page.waitForTimeout(800);
    } catch(e) {}
  }

  async function isOnMarketplace() {
    try {
      return await page.evaluate(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while ((node = walker.nextNode())) {
          if (node.nodeValue.trim() === 'Marketplace') return true;
        }
        return false;
      });
    } catch(e) { return false; }
  }

  async function tryNavigateToMarketplace() {
    if (marketplaceY !== null) {
      try { await page.mouse.click(140, marketplaceY); await page.waitForTimeout(1500); } catch(e) {}
      await clickTab('FC');
      return;
    }
    const ys = [40,60,80,100,120,140,160,180,200,225,250,275,300,325,350,380,415,450,490,530,570];
    for (const y of ys) {
      try { await page.mouse.click(140, y); } catch(e) { continue; }
      await page.waitForTimeout(500);
      if (await isOnMarketplace()) {
        console.log('auction-scanner: marketplace found at y=' + y);
        marketplaceY = y;
        await clickTab('FC');
        return;
      }
    }
    console.log('auction-scanner: marketplace not found — retry next poll');
  }

  async function loadPage() {
    liveToken = null;
    try {
      await page.goto('https://realsports.io', { waitUntil: 'networkidle', timeout: 30_000 });
    } catch(e) { console.log('auction-scanner: load timeout'); }
  }

  // Navigate to Cards sidebar → sport → Plays → Owned → Global
  async function navigateToGlobalView(sport) {
    const sportLabel = sport === 'soccer' ? 'FC' : 'UFC';
    // Return to marketplace first to reset page state before switching sports
    await tryNavigateToMarketplace().catch(() => {});
    await page.mouse.click(140, 128); // Cards sidebar icon
    await page.waitForTimeout(1000);
    await clickTab(sportLabel);
    await clickTab(sport === 'soccer' ? 'Plays' : 'Rounds');
    await clickTab('Owned');
    await clickTab('Global');
    await page.waitForTimeout(800);;
  }

  // Open the player/fighter filter modal and select by search term.
  // Flow: click filter button → dropdown opens → click "Player"/"Fighter" → search modal
  //       → click input → type → click autocomplete result → route intercept fires
  async function filterByPlayer(searchTerm) {
    const typeTerm = GC_SEARCH_OVERRIDES[searchTerm] || searchTerm;
    try {
      // Step 1: click the filter button to open the Player/Fighter dropdown.
      // If an active player chip is present (second+ scan cycle), DOM-click it directly
      // because its position shifts with the player name width.
      // If no chip, use coordinate click — "Player ▼" or "All ▼" is at (369,112).
      const chipText = await page.evaluate(() => {
        const knownFragments = ['dimarco', 'mckennie', 'grimaldo', 'locatelli', 'maia',
                                'alejandro', 'weston', 'federico', 'manuel', 'demian'];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while ((node = walker.nextNode())) {
          const val = node.nodeValue.trim().toLowerCase();
          if (!knownFragments.some(f => val.includes(f))) continue;
          const el = node.parentElement;
          if (!el?.offsetParent) continue;
          const rect = el.getBoundingClientRect();
          if (rect.y > 95 && rect.y < 130 && rect.x > 150 && rect.x < 700) {
            el.click();
            return node.nodeValue.trim();
          }
        }
        return null;
      });
      if (!chipText) await page.mouse.click(369, 112);
      console.log('auction-scanner: GC open-filter:', chipText ?? 'coord-click', 'for', searchTerm);
      await page.waitForTimeout(600);

      await page.screenshot({ path: `/tmp/gc-dropdown-${searchTerm}.png` }).catch(() => {});

      // If we clicked the same player chip that's already the active filter, re-selecting it
      // is a no-op for the SPA (no new API call). Click "Clear" first to reset to All,
      // then reopen the dropdown fresh so the next selection triggers a real API call.
      const isSameChip = chipText && (
        chipText.toLowerCase().includes(searchTerm.toLowerCase()) ||
        chipText.toLowerCase().includes(typeTerm.toLowerCase())
      );
      if (isSameChip) {
        const cleared = await page.evaluate(() => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
          let node;
          while ((node = walker.nextNode())) {
            if (node.nodeValue.trim() !== 'Clear') continue;
            const el = node.parentElement;
            if (!el?.offsetParent) continue;
            el.click();
            return true;
          }
          return false;
        });
        console.log('auction-scanner: GC clear-filter:', cleared, 'for', searchTerm);
        await page.waitForTimeout(800);
        await page.mouse.click(369, 112); // reopen dropdown now that filter is "All"
        await page.waitForTimeout(600);
      }

      // Step 2: click "Player" (FC) or "Fighter" (UFC) in the now-open dropdown
      const findPlayerFighter = async () => page.evaluate(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while ((node = walker.nextNode())) {
          const val = node.nodeValue.trim();
          if (val === 'Player' || val === 'Fighter') {
            const el = node.parentElement;
            if (el?.offsetParent) {
              const rect = el.getBoundingClientRect();
              if (rect.y > 80 && rect.y < 700 && rect.x < 900) { el.click(); return true; }
            }
          }
        }
        return false;
      });
      let playerClicked = await findPlayerFighter();

      // Fallback: if Player/Fighter not in dropdown yet, DOM-click "All" in filter bar
      // (handles UFC where coordinate click misses the "All ▼" button)
      if (!playerClicked) {
        const allClicked = await page.evaluate(() => {
          let best = null;
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
          let node;
          while ((node = walker.nextNode())) {
            if (node.nodeValue.trim() !== 'All') continue;
            const el = node.parentElement;
            if (!el?.offsetParent) continue;
            const rect = el.getBoundingClientRect();
            if (rect.y > 95 && rect.y < 130 && rect.x > 150 && rect.x < 700) {
              if (!best || rect.x > best.x) { best = { el, x: rect.x }; }
            }
          }
          if (best) { best.el.click(); return true; }
          return false;
        });
        if (allClicked) {
          await page.waitForTimeout(600);
          playerClicked = await findPlayerFighter();
        }
      }

      console.log('auction-scanner: GC player-clicked:', playerClicked, 'for', searchTerm);
      await page.waitForTimeout(500);

      // Find the search input and mouse-click it at its actual coordinates
      const inputPos = await page.evaluate(() => {
        for (const input of document.querySelectorAll('input')) {
          if (!input.offsetParent) continue;
          const rect = input.getBoundingClientRect();
          if (rect.width > 80 && rect.height > 16) {
            return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
          }
        }
        return null;
      });
      console.log('auction-scanner: GC input-pos:', inputPos ? `${inputPos.x},${inputPos.y}` : 'null', 'for', searchTerm);
      if (inputPos) {
        await page.mouse.click(inputPos.x, inputPos.y);
        await page.waitForTimeout(200);
      }

      await page.keyboard.press('Control+a');
      await page.keyboard.press('Delete');
      await page.keyboard.type(typeTerm);
      await page.waitForTimeout(2500);

      await page.screenshot({ path: `/tmp/gc-filter-${searchTerm}.png` }).catch(() => {});

      const hasAC = await page.evaluate((term) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while ((node = walker.nextNode())) {
          if (node.nodeValue.toLowerCase().includes(term.toLowerCase())) {
            const rect = node.parentElement?.getBoundingClientRect();
            if (rect && rect.y > 100 && rect.y < 700) return true;
          }
        }
        return false;
      }, typeTerm);
      console.log('auction-scanner: GC autocomplete:', hasAC, 'for', searchTerm);

      pendingGcData = null;
      filterQueue.push(searchTerm);
      const t0 = Date.now();

      // Click the autocomplete result. Walk up ancestors to find the clickable row (width > 150).
      // Needed because UFC highlights the typed portion in a narrow child span.
      const resultClicked = await page.evaluate((term) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while ((node = walker.nextNode())) {
          if (node.nodeValue.trim().toLowerCase().includes(term.toLowerCase())) {
            let el = node.parentElement;
            while (el && el !== document.body) {
              const rect = el.getBoundingClientRect();
              if (rect.y > 100 && rect.y < 700 && rect.width > 150) {
                el.click();
                return node.nodeValue.trim();
              }
              el = el.parentElement;
            }
          }
        }
        return null;
      }, typeTerm);

      if (!resultClicked) {
        // Fallback: mouse.click at screen coords of the matching text node's ancestor
        const acPos = await page.evaluate((term) => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
          let node;
          while ((node = walker.nextNode())) {
            if (node.nodeValue.toLowerCase().includes(term.toLowerCase())) {
              let el = node.parentElement;
              while (el && el !== document.body) {
                const rect = el.getBoundingClientRect();
                if (rect.y > 100 && rect.y < 700 && rect.width > 150) {
                  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
                }
                el = el.parentElement;
              }
            }
          }
          return null;
        }, typeTerm);
        if (acPos) {
          console.log('auction-scanner: GC mouse-ac:', JSON.stringify(acPos), 'for', searchTerm);
          await page.mouse.click(acPos.x, acPos.y);
        } else {
          console.log('auction-scanner: GC no-result for', searchTerm);
          if (filterQueue.length > 0 && filterQueue[0] === searchTerm) filterQueue.shift();
          return null;
        }
      } else {
        console.log('auction-scanner: GC result-clicked:', resultClicked, 'for', searchTerm);
      }

      const maxWait = 12000;
      while (Date.now() - t0 < maxWait) {
        await page.waitForTimeout(300);
        if (pendingGcData && pendingGcData.ts > t0) return pendingGcData.cards;
      }
      if (pendingGcData && pendingGcData.ts > t0) return pendingGcData.cards;

      console.log('auction-scanner: GC poll timeout for', searchTerm);
      if (filterQueue.length > 0 && filterQueue[0] === searchTerm) filterQueue.shift();
      return null;
    } catch(e) {
      console.log('auction-scanner: filter error for', searchTerm, ':', e.message);
      return null;
    }
  }

  // ── Direct API globalcards fetch via browser context (uses session cookies) ─────

  async function fetchPlayerGlobalCardsAPI(target) {
    const info = gcEntityIds[target];
    if (!info) return null;
    const { entityId, apiUrl } = info;
    const url = `${apiUrl}?filterEntityId=${entityId}&filterEntityType=player&rarity=all&view=new&sort=new&pageSize=50&limit=50`;
    try {
      // Run fetch inside browser context so session cookies/auth are included automatically
      const result = await page.evaluate(async (fetchUrl) => {
        const res = await fetch(fetchUrl);
        if (!res.ok) return { error: res.status };
        return await res.json();
      }, url);
      if (result?.error) {
        console.log('auction-scanner: GC API error for', target, result.error);
        return null;
      }
      const cards = result?.cards || result?.items || result?.data || result?.plays || [];
      console.log('auction-scanner: GC API', target, '→', cards.length, 'card(s)');
      return cards;
    } catch(e) {
      console.log('auction-scanner: GC API error for', target, ':', e.message);
      return null;
    }
  }

  // ── Global cards scan (single-page, serialized with poll) ─────────────────────

  async function scanGlobalCards() {
    if (gcScanning) return;
    gcScanning = true;
    try {
      console.log('auction-scanner: global card scan start');

      // Try fast API path; players with no entity ID or whose API call fails fall through to UI
      const fcNeedUI  = [];
      const ufcNeedUI = [];

      for (const target of GC_FC_TARGETS) {
        if (gcEntityIds[target] && capturedHeaders) {
          const cards = await fetchPlayerGlobalCardsAPI(target);
          if (cards !== null) {
            if (cards.length) await checkPackCards(cards, 'soccer');
            continue; // API succeeded — skip UI
          }
        }
        fcNeedUI.push(target); // no entity ID OR API failed → use UI
      }
      for (const target of GC_UFC_TARGETS) {
        if (gcEntityIds[target] && capturedHeaders) {
          const cards = await fetchPlayerGlobalCardsAPI(target);
          if (cards !== null) {
            if (cards.length) await checkPackCards(cards, 'ufc');
            continue;
          }
        }
        ufcNeedUI.push(target);
      }

      // Navigate once per sport, then click the active player chip for subsequent players.
      // If a filter times out, re-navigate before the next player to restore known page state.
      if (fcNeedUI.length) {
        await navigateToGlobalView('soccer');
        let needRenavigate = false;
        for (const target of fcNeedUI) {
          if (needRenavigate) {
            await navigateToGlobalView('soccer').catch(() => {});
            needRenavigate = false;
          }
          currentGcTarget = target;
          const cards = await filterByPlayer(target);
          currentGcTarget = null;
          if (cards === null) {
            console.log('auction-scanner: GC no response for FC:', target);
            needRenavigate = true;
            continue;
          }
          needRenavigate = false;
          console.log('auction-scanner: GC UI', target, '→', cards.length, 'card(s)');
          if (cards.length) await checkPackCards(cards, 'soccer');
        }
      }
      if (ufcNeedUI.length) {
        await navigateToGlobalView('ufc');
        let needRenavigate = false;
        for (const target of ufcNeedUI) {
          if (needRenavigate) {
            await navigateToGlobalView('ufc').catch(() => {});
            needRenavigate = false;
          }
          currentGcTarget = target;
          const cards = await filterByPlayer(target);
          currentGcTarget = null;
          if (cards === null) {
            console.log('auction-scanner: GC no response for UFC:', target);
            needRenavigate = true;
            continue;
          }
          needRenavigate = false;
          console.log('auction-scanner: GC UI', target, '→', cards.length, 'card(s)');
          if (cards.length) await checkPackCards(cards, 'ufc');
        }
      }

      console.log('auction-scanner: global card scan done');
    } catch(e) {
      console.log('auction-scanner: global scan error', e.message);
    } finally {
      gcScanning = false;
      currentGcTarget = null;
      await tryNavigateToMarketplace().catch(() => {}); // reset page state for next scan
    }
  }

  // ── Marketplace poll ──────────────────────────────────────────────────────────

  let missCount = 0;

  async function poll() {
    if (gcScanning) return; // GC scan owns the page right now

    if (!liveToken) {
      console.log('auction-scanner: session gone — reloading...');
      await loadPage();
      if (!liveToken) { console.log('auction-scanner: session expired — re-run --setup'); return; }
    }

    try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 10_000 }); } catch(e) {}

    listingsFromRoute = [];
    await tryNavigateToMarketplace();
    await page.waitForTimeout(1500);
    const fcListings = [...listingsFromRoute];

    listingsFromRoute = [];
    await clickTab('UFC');
    await page.waitForTimeout(1500);
    const ufcListings = [...listingsFromRoute];

    const allListings = [...fcListings, ...ufcListings];
    if (allListings.length) {
      missCount = 0;
      console.log('auction-scanner: processing', fcListings.length, 'FC +', ufcListings.length, 'UFC listing(s)');
      await checkListings(allListings);
    } else {
      missCount++;
      console.log('auction-scanner: no listings captured (' + missCount + ' miss)');
      if (missCount >= 3) {
        console.log('auction-scanner: 3 misses — reloading page');
        missCount = 0;
        await loadPage();
        await tryNavigateToMarketplace();
      }
    }
  }

  // ── Initialize ────────────────────────────────────────────────────────────────

  process.on('SIGTERM', async () => {
    console.log('auction-scanner: shutting down');
    await browser.close().catch(() => {});
    process.exit(0);
  });

  await loadPage();
  await tryNavigateToMarketplace(); // initializes page state and captures auth headers

  console.log(`auction-scanner: global cards every ${GLOBAL_SCAN_MS / 60000} min`);
  await sendTelegram('✅ Auction scanner started (global cards only).');

  await scanGlobalCards();
  setInterval(() => scanGlobalCards().catch(e => console.error('auction-scanner GC error:', e.message)), GLOBAL_SCAN_MS);
}

// ─── Entry ────────────────────────────────────────────────────────────────────

if (process.argv.includes('--setup')) {
  setup().catch(e => { console.error(e); process.exit(1); });
} else {
  scan().catch(e => { console.error(e); process.exit(1); });
}
