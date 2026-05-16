// auction-scanner/index.js — pack alert scanner
// Playwright headless Chromium. Logs into RS via saved auth-state.json.
// Navigates the RS global cards UI, filters by each target player, checks for
// recent packs. Runs every 60s (scans take ~40-50s).
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
const ENTITY_FILE    = join(__dir, 'gc-entity-ids.json');

const HASHIDS        = new Hashids('routing', 11);
const TG_TOKEN       = '8258151239:AAFYPbSM5N0KJ8Fns40EVOWLeuoOYTaxsLw';
const TG_CHAT        = '5439959074';

const GC_FC_TARGETS  = ['dimarco', 'mckennie', 'grimaldo', 'locatelli', 'guilavogui', 'ojeda'];
const GC_UFC_TARGETS = ['maia'];
const TARGETS        = [...GC_FC_TARGETS, ...GC_UFC_TARGETS];

const GC_SEARCH_OVERRIDES = { maia: 'demian' };

const GLOBAL_SCAN_MS = 60 * 1000;

// Seeding: true on first-ever run (empty packSeen) to avoid alerting on all
// existing global cards. After the first scan completes, set to false.
let seeding = false;

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
    if (seeding) continue; // First scan: populate seen list silently, no alerts
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
  if (!seeding && !found && cards.length) console.log('pack-scanner: no new target packs in', cards.length, sport, 'card(s)');
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

  let liveToken         = null;
  let capturedGcHeaders = null;
  let gcScanning        = false;
  let pendingGcData     = null;

  const gcEntityIds = (() => {
    try { return JSON.parse(readFileSync(ENTITY_FILE, 'utf8')); } catch(_) { return {}; }
  })();
  function saveEntityIds() {
    writeFileSync(ENTITY_FILE, JSON.stringify(gcEntityIds, null, 2));
  }

  const filterQueue = [];

  // Intercept globalcards — force sort=new, pageSize=50, capture card data
  await page.route('**/globalcards**', async route => {
    try {
      const origUrl = route.request().url();
      let fetchUrl = origUrl;
      if (origUrl.includes('filterEntityId')) {
        fetchUrl = fetchUrl.includes('view=')     ? fetchUrl.replace(/view=[^&]+/,   'view=new')    : fetchUrl + '&view=new';
        fetchUrl = fetchUrl.includes('sort=')     ? fetchUrl.replace(/sort=[^&]+/,   'sort=new')    : fetchUrl + '&sort=new';
        fetchUrl = fetchUrl.includes('pageSize=') ? fetchUrl.replace(/pageSize=\d+/, 'pageSize=50') : fetchUrl + '&pageSize=50';
        fetchUrl = fetchUrl.includes('limit=')    ? fetchUrl.replace(/limit=\d+/,    'limit=50')    : fetchUrl + '&limit=50';
      }
      const reqHeaders = route.request().headers();
      if (reqHeaders['real-auth-info']) capturedGcHeaders = { ...reqHeaders };
      const fetchOpts = { url: fetchUrl };
      if (capturedGcHeaders && !reqHeaders['real-auth-info']) fetchOpts.headers = capturedGcHeaders;
      const response = await route.fetch(fetchOpts);
      const status   = response.status();
      const text     = await response.text();
      if (status !== 200) {
        const shortened = origUrl.includes('filterEntityId') ? origUrl.replace(/.*filterEntityId=(\d+).*/, 'filterEntityId=$1') : '(unfiltered)';
        console.log('pack-scanner: GC route', status, shortened);
        await route.fulfill({ response, body: text });
        return;
      }
      try {
        const data  = JSON.parse(text);
        const sport = origUrl.includes('/ufc/') ? 'ufc' : 'soccer';
        const cards = data.cards || data.items || data.data || data.plays || [];
        if (origUrl.includes('filterEntityId')) {
          console.log('pack-scanner: GC captured', sport, cards.length, 'card(s)');
          pendingGcData = { cards, sport, ts: Date.now() };
          if (cards.length) checkPackCards(cards, sport).catch(() => {});
          if (filterQueue.length) {
            const target = filterQueue.shift();
            if (!gcEntityIds[target]) {
              try {
                const u        = new URL(origUrl);
                const entityId = u.searchParams.get('filterEntityId');
                const apiUrl   = u.origin + u.pathname;
                if (entityId) {
                  gcEntityIds[target] = { entityId, apiUrl };
                  saveEntityIds();
                  console.log('pack-scanner: GC entity ID saved:', target, '=', entityId);
                }
              } catch(_) {}
            }
          }
        }
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

  // ── Navigation helpers ────────────────────────────────────────────────────────

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
      await page.waitForTimeout(600);
    } catch(e) {}
  }

  async function navigateToGlobalView(sport, cardType = 'plays') {
    const sportLabel = sport === 'soccer' ? 'FC' : 'UFC';
    const typeLabel  = cardType === 'performances' ? 'Performances'
                     : sport === 'soccer' ? 'Plays' : 'Rounds';
    await page.goto('https://realsports.io', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    await page.mouse.click(140, 128); // Cards sidebar icon
    await page.waitForTimeout(800);
    await clickTab(sportLabel);
    await clickTab(typeLabel);
    await clickTab('Owned');
    await clickTab('Global');
    await page.waitForTimeout(600);
  }

  async function filterByPlayer(searchTerm) {
    const typeTerm = GC_SEARCH_OVERRIDES[searchTerm] || searchTerm;
    try {
      const knownFragments = ['dimarco', 'mckennie', 'grimaldo', 'locatelli', 'maia',
                              'guilavogui', 'ojeda', 'alejandro', 'weston', 'federico',
                              'manuel', 'demian', 'morgan', 'martin'];
      const chipText = await page.evaluate((frags) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while ((node = walker.nextNode())) {
          const val = node.nodeValue.trim().toLowerCase();
          if (!frags.some(f => val.includes(f))) continue;
          const el = node.parentElement;
          if (!el?.offsetParent) continue;
          const rect = el.getBoundingClientRect();
          if (rect.y > 95 && rect.y < 130 && rect.x > 150 && rect.x < 700) {
            el.click();
            return node.nodeValue.trim();
          }
        }
        return null;
      }, knownFragments);
      if (!chipText) await page.mouse.click(369, 112);
      console.log('pack-scanner: GC open-filter:', chipText ?? 'coord-click', 'for', searchTerm);
      await page.waitForTimeout(400);

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
        console.log('pack-scanner: GC clear-filter:', cleared, 'for', searchTerm);
        await page.waitForTimeout(600);
        await page.mouse.click(369, 112);
        await page.waitForTimeout(400);
      }

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
          await page.waitForTimeout(400);
          playerClicked = await findPlayerFighter();
        }
      }

      console.log('pack-scanner: GC player-clicked:', playerClicked, 'for', searchTerm);
      await page.waitForTimeout(400);

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
      if (inputPos) {
        await page.mouse.click(inputPos.x, inputPos.y);
        await page.waitForTimeout(150);
      }

      await page.keyboard.press('Control+a');
      await page.keyboard.press('Delete');
      await page.keyboard.type(typeTerm);
      await page.waitForTimeout(1500);

      pendingGcData = null;
      filterQueue.push(searchTerm);
      const t0 = Date.now();

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
          console.log('pack-scanner: GC mouse-ac:', JSON.stringify(acPos), 'for', searchTerm);
          await page.mouse.click(acPos.x, acPos.y);
        } else {
          console.log('pack-scanner: GC no-result for', searchTerm);
          if (filterQueue.length > 0 && filterQueue[0] === searchTerm) filterQueue.shift();
          return null;
        }
      } else {
        console.log('pack-scanner: GC result-clicked:', resultClicked, 'for', searchTerm);
      }

      const maxWait = 10000;
      while (Date.now() - t0 < maxWait) {
        await page.waitForTimeout(250);
        if (pendingGcData && pendingGcData.ts > t0) return pendingGcData.cards;
      }
      if (pendingGcData && pendingGcData.ts > t0) return pendingGcData.cards;

      console.log('pack-scanner: GC poll timeout for', searchTerm);
      if (filterQueue.length > 0 && filterQueue[0] === searchTerm) filterQueue.shift();
      return null;
    } catch(e) {
      console.log('pack-scanner: filter error for', searchTerm, ':', e.message);
      return null;
    }
  }

  async function fetchPlayerGlobalCardsAPI(target) {
    const info = gcEntityIds[target];
    if (!info) return null;
    const { entityId, apiUrl } = info;
    const url = `${apiUrl}?filterEntityId=${entityId}&filterEntityType=player&rarity=all&view=new&sort=new&pageSize=50&limit=50`;
    try {
      const result = await page.evaluate(async (fetchUrl) => {
        const res = await fetch(fetchUrl);
        if (!res.ok) return { error: res.status };
        return await res.json();
      }, url);
      if (result?.error) {
        console.log('pack-scanner: GC API error for', target, result.error);
        return null;
      }
      const cards = result?.cards || result?.items || result?.data || result?.plays || [];
      console.log('pack-scanner: GC API', target, '→', cards.length, 'card(s)');
      return cards;
    } catch(e) {
      console.log('pack-scanner: GC API error for', target, ':', e.message);
      return null;
    }
  }

  // ── Global cards scan ─────────────────────────────────────────────────────────

  async function scanGlobalCards() {
    if (gcScanning) return;
    gcScanning = true;
    try {
      console.log('pack-scanner: scan start');

      const fcNeedUI  = [];
      const ufcNeedUI = [];

      for (const target of GC_FC_TARGETS) {
        if (gcEntityIds[target]) {
          const cards = await fetchPlayerGlobalCardsAPI(target);
          if (cards !== null) {
            if (cards.length) await checkPackCards(cards, 'soccer');
            continue;
          }
        }
        fcNeedUI.push(target);
      }
      for (const target of GC_UFC_TARGETS) {
        if (gcEntityIds[target]) {
          const cards = await fetchPlayerGlobalCardsAPI(target);
          if (cards !== null) {
            if (cards.length) await checkPackCards(cards, 'ufc');
            continue;
          }
        }
        ufcNeedUI.push(target);
      }

      // FC Plays
      if (fcNeedUI.length) {
        await navigateToGlobalView('soccer', 'plays');
        let needRenavigate = false;
        for (const target of fcNeedUI) {
          if (needRenavigate) { await navigateToGlobalView('soccer', 'plays').catch(() => {}); needRenavigate = false; }
          const cards = await filterByPlayer(target);
          if (cards === null) { console.log('pack-scanner: Plays no response:', target); needRenavigate = true; continue; }
          console.log('pack-scanner: Plays', target, '→', cards.length, 'card(s)');
          if (cards.length) await checkPackCards(cards, 'soccer');
        }
      }

      // FC Performances (always UI — same targets, separate card type)
      await navigateToGlobalView('soccer', 'performances');
      let needRenavPerf = false;
      for (const target of GC_FC_TARGETS) {
        if (needRenavPerf) { await navigateToGlobalView('soccer', 'performances').catch(() => {}); needRenavPerf = false; }
        const cards = await filterByPlayer(target);
        if (cards === null) { console.log('pack-scanner: Perf no response:', target); needRenavPerf = true; continue; }
        console.log('pack-scanner: Perf', target, '→', cards.length, 'card(s)');
        if (cards.length) await checkPackCards(cards, 'soccer');
      }

      // UFC Rounds
      if (ufcNeedUI.length) {
        await navigateToGlobalView('ufc', 'rounds');
        let needRenavigate = false;
        for (const target of ufcNeedUI) {
          if (needRenavigate) { await navigateToGlobalView('ufc', 'rounds').catch(() => {}); needRenavigate = false; }
          const cards = await filterByPlayer(target);
          if (cards === null) { console.log('pack-scanner: Rounds no response:', target); needRenavigate = true; continue; }
          console.log('pack-scanner: Rounds', target, '→', cards.length, 'card(s)');
          if (cards.length) await checkPackCards(cards, 'ufc');
        }
      }

      console.log('pack-scanner: scan done');
    } catch(e) {
      console.log('pack-scanner: scan error', e.message);
      // Browser crash — exit immediately so systemd restarts clean (10s) instead of
      // waiting 5min for the watchdog while every scan throws the same error.
      if (e.message.includes('Target crashed') || e.message.includes('browser has been closed')) {
        console.log('pack-scanner: browser crash detected, exiting for fast restart');
        process.exit(1);
      }
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

  seeding = packSeen.size === 0;
  console.log(`pack-scanner: scanning every ${GLOBAL_SCAN_MS / 1000}s, targets: ${TARGETS.join(', ')}${seeding ? ' (seeding)' : ''}`);
  await sendTelegram('✅ Pack alert scanner started (60s). Targets: ' + TARGETS.join(', '));

  // Watchdog: if no scan completes within 7 min, exit so systemd restarts fresh
  let lastScanDone = Date.now();
  setInterval(() => {
    if (Date.now() - lastScanDone > 7 * 60 * 1000) {
      console.log('pack-scanner: watchdog — scan stuck >7min, exiting for restart');
      process.exit(1);
    }
  }, 60 * 1000);

  let scanCount = 0;
  const wrappedScan = async () => {
    await scanGlobalCards();
    if (seeding) {
      seeding = false;
      savePackSeen();
      console.log('pack-scanner: seed done,', packSeen.size, 'cards known. Alerting live.');
      await sendTelegram('✅ Seeded (' + packSeen.size + ' cards). Alerting live now.');
    }
    lastScanDone = Date.now();
    // Proactive restart every 50 scans (~50min) to shed accumulated memory
    if (++scanCount >= 50) {
      console.log('pack-scanner: proactive restart after 50 scans');
      process.exit(0);
    }
  };

  await wrappedScan();
  setInterval(() => wrappedScan().catch(e => console.error('pack-scanner error:', e.message)), GLOBAL_SCAN_MS);
}

// ─── Entry ────────────────────────────────────────────────────────────────────

if (process.argv.includes('--setup')) {
  setup().catch(e => { console.error(e); process.exit(1); });
} else {
  scan().catch(e => { console.error(e); process.exit(1); });
}
