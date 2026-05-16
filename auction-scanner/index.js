// auction-scanner/index.js — pack alert scanner
// Playwright headless Chromium. Logs into RS via saved auth-state.json.
// Navigates to RS global cards (no player filter), grabs newest 50 cards,
// checks all targets client-side. Scans every 60s.
// Setup: node index.js --setup  (opens headed browser to log in, saves session)
// Run:   node index.js          (headless, runs forever, managed by systemd)

import { chromium }                               from 'playwright';
import Hashids                                     from 'hashids';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { createInterface }                         from 'readline';
import { fileURLToPath }                           from 'url';
import { dirname, join }                           from 'path';

const __dir          = dirname(fileURLToPath(import.meta.url));
const STATE_FILE     = join(__dir, 'auth-state.json');
const PACK_SEEN_FILE = join(__dir, 'pack-seen-ids.json');

const HASHIDS        = new Hashids('routing', 11);
const TG_TOKEN       = '8258151239:AAFYPbSM5N0KJ8Fns40EVOWLeuoOYTaxsLw';
const TG_CHAT        = '5439959074';

const GC_FC_TARGETS  = ['dimarco', 'mckennie', 'grimaldo', 'locatelli', 'guilavogui', 'ojeda'];
const GC_UFC_TARGETS = ['maia'];
const TARGETS        = [...GC_FC_TARGETS, ...GC_UFC_TARGETS];

const GLOBAL_SCAN_MS = 60 * 1000;
const PACK_FRESH_MS  = 10 * 60 * 1000;

// ─── Pack seen IDs ─────────────────────────────────────────────────────────────

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
    if (!res.ok) console.error('pack-scanner: telegram error', await res.text());
  } catch (e) { console.error('pack-scanner: telegram error', e.message); }
}

// ─── Pack / global card checks ────────────────────────────────────────────────

function getPackPlayerName(card) {
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
  if (!ts) return true;
  return Date.now() - new Date(ts).getTime() < PACK_FRESH_MS;
}

function cardRating(card) {
  if (!card) return null;
  const r = card.value ?? card.score ?? card.rating ?? card.overallScore ?? card.overallRating ?? null;
  const n = parseFloat(r);
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
      console.log('pack-scanner: card too old, skipping id:', id);
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
    const label     = sport === 'ufc' ? 'UFC' : 'FC';
    const msg = `🃏 <b>Pack Alert</b> (${label})\n${name}${rarity ? ` (${rarity})` : ''}${ratingStr}${ownerStr}${urlLine}`;
    console.log('pack-scanner: PACK ALERT', name, rarity, sport, cardUrl || '(no url)');
    await sendTelegram(msg);
    savePackSeen();
    found++;
  }
  if (!found && cards.length) console.log('pack-scanner: no target packs in', cards.length, sport, 'card(s)');
}

// ─── Setup mode ───────────────────────────────────────────────────────────────

async function setup() {
  console.log('\npack-scanner: SETUP MODE');
  console.log('A browser will open. Log in to realsports.io, then press Enter.\n');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page    = await context.newPage();
  await page.goto('https://realsports.io');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => rl.question('Press Enter after logging in... ', resolve));
  rl.close();
  await context.storageState({ path: STATE_FILE });
  console.log('\npack-scanner: auth state saved.');
  await browser.close();
}

// ─── Scanner mode ─────────────────────────────────────────────────────────────

async function scan() {
  if (!existsSync(STATE_FILE)) {
    console.error('pack-scanner: no auth state. Run: node index.js --setup');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: STATE_FILE });
  const page    = await context.newPage();

  let liveToken     = null;
  let gcScanning    = false;
  let pendingGcData = null;

  // Intercept globalcards — force sort=new, pageSize=50, capture card data
  await page.route('**/globalcards**', async route => {
    try {
      const origUrl = route.request().url();
      let fetchUrl = origUrl;
      fetchUrl = fetchUrl.includes('view=')     ? fetchUrl.replace(/view=[^&]+/,     'view=new')     : fetchUrl + '&view=new';
      fetchUrl = fetchUrl.includes('sort=')     ? fetchUrl.replace(/sort=[^&]+/,     'sort=new')     : fetchUrl + '&sort=new';
      fetchUrl = fetchUrl.includes('pageSize=') ? fetchUrl.replace(/pageSize=\d+/,   'pageSize=50')  : fetchUrl + '&pageSize=50';
      fetchUrl = fetchUrl.includes('limit=')    ? fetchUrl.replace(/limit=\d+/,      'limit=50')     : fetchUrl + '&limit=50';
      const response = await route.fetch({ url: fetchUrl });
      const status   = response.status();
      const text     = await response.text();
      if (status !== 200) {
        console.log('pack-scanner: GC route', status);
        await route.fulfill({ response, body: text });
        return;
      }
      try {
        const data  = JSON.parse(text);
        const sport = origUrl.includes('/ufc/') ? 'ufc' : 'soccer';
        const cards = data.cards || data.items || data.data || data.plays || [];
        console.log('pack-scanner: GC captured', sport, cards.length, 'card(s)');
        pendingGcData = { cards, sport, ts: Date.now() };
      } catch(_) {}
      await route.fulfill({ response, body: text });
    } catch(e) { await route.continue(); }
  });

  page.on('request', request => {
    if (!request.url().includes('realapp.com')) return;
    const auth = request.headers()['real-auth-info'];
    if (auth && auth.split('!').length === 3 && auth !== liveToken) {
      liveToken = auth;
      console.log('pack-scanner: session alive, prefix:', auth.split('!')[0]);
    }
  });

  // ── Navigation ────────────────────────────────────────────────────────────────

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

  async function navigateToGlobalView(sport) {
    const sportLabel = sport === 'soccer' ? 'FC' : 'UFC';
    await page.goto('https://realsports.io', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
    await page.mouse.click(140, 128); // Cards sidebar icon
    await page.waitForTimeout(1000);
    await clickTab(sportLabel);
    await clickTab(sport === 'soccer' ? 'Plays' : 'Rounds');
    await clickTab('Owned');
    await clickTab('Global');
    await page.waitForTimeout(800);
  }

  // ── Global cards scan ─────────────────────────────────────────────────────────

  async function scanGlobalCards() {
    if (gcScanning) return;
    gcScanning = true;
    try {
      console.log('pack-scanner: scan start');

      for (const sport of ['soccer', 'ufc']) {
        pendingGcData = null;
        const t0 = Date.now();
        await navigateToGlobalView(sport);
        // Wait up to 10s after navigation starts for the card data to arrive
        while (Date.now() - t0 < 20000) {
          await page.waitForTimeout(300);
          if (pendingGcData && pendingGcData.ts > t0) break;
        }
        const cards = pendingGcData?.cards ?? [];
        console.log(`pack-scanner: ${sport} → ${cards.length} card(s)`);
        if (cards.length) await checkPackCards(cards, sport);
      }

      console.log('pack-scanner: scan done');
    } catch(e) {
      console.log('pack-scanner: scan error', e.message);
    } finally {
      gcScanning = false;
    }
  }

  // ── Initialize ────────────────────────────────────────────────────────────────

  process.on('SIGTERM', async () => {
    console.log('pack-scanner: shutting down');
    await browser.close().catch(() => {});
    process.exit(0);
  });

  await page.goto('https://realsports.io', { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {
    console.log('pack-scanner: initial load timeout');
  });

  console.log(`pack-scanner: scanning every ${GLOBAL_SCAN_MS / 1000}s, targets: ${TARGETS.join(', ')}`);
  await sendTelegram('✅ Pack alert scanner started (60s). Targets: ' + TARGETS.join(', '));

  // Watchdog: if no scan completes within 4 min, exit so systemd restarts fresh
  let lastScanDone = Date.now();
  setInterval(() => {
    if (Date.now() - lastScanDone > 4 * 60 * 1000) {
      console.log('pack-scanner: watchdog — scan stuck >4min, exiting for restart');
      process.exit(1);
    }
  }, 60 * 1000);

  const wrappedScan = async () => { await scanGlobalCards(); lastScanDone = Date.now(); };

  await wrappedScan();
  setInterval(() => wrappedScan().catch(e => console.error('pack-scanner error:', e.message)), GLOBAL_SCAN_MS);
}

// ─── Entry ────────────────────────────────────────────────────────────────────

if (process.argv.includes('--setup')) {
  setup().catch(e => { console.error(e); process.exit(1); });
} else {
  scan().catch(e => { console.error(e); process.exit(1); });
}
