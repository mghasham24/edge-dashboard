#!/usr/bin/env node
// payout-bot/index.js
// Opens each winner's card in a real browser, sets the offer amount on the slider,
// clicks 48h, and presses Offer. Runs headed from your Mac — looks identical to manual.
//
// First run: log in to RS as edgebot in the window that opens, then press Enter.
// Subsequent runs: saved session is restored automatically.
//
// Usage:  node index.js
// Setup:  cp .env.example .env  (fill in CRON_SECRET)
//         npm install
//         npx playwright install chromium

require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');

const STATE_FILE  = path.join(__dirname, 'browser-state.json');
const RAXEDGE_URL = (process.env.RAXEDGE_URL || 'https://raxedge.com').replace(/\/$/, '');
const CRON_SECRET = process.env.CRON_SECRET;

if (!CRON_SECRET) { console.error('CRON_SECRET not set in .env'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ── API helpers ────────────────────────────────────────────────────────────────

async function apiGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${RAXEDGE_URL}${path}${sep}_cron_key=${CRON_SECRET}`);
  return res.json();
}

async function apiPost(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${RAXEDGE_URL}${path}${sep}_cron_key=${CRON_SECRET}`, { method: 'POST' });
  return res.json();
}

async function fetchQueue() {
  const data = await apiGet('/api/parlays/payout-queue?action=list');
  if (!data.ok) throw new Error('Queue fetch failed: ' + JSON.stringify(data));
  return (data.queue || []).filter(e => e.status === 'pending');
}

async function prepareEntry(id) {
  const data = await apiPost(`/api/parlays/payout-queue?action=prepare&id=${id}`);
  if (!data.ok) throw new Error(data.error || 'prepare failed');
  return data; // { cardId, cardUrl, offerAmount }
}

async function markSent(id) {
  const data = await apiPost(`/api/parlays/payout-queue?action=mark_sent&id=${id}`);
  return data.ok;
}

// ── Slider helper ──────────────────────────────────────────────────────────────

async function setSlider(page, amount) {
  // Try JS-based set first (works for React controlled inputs via native setter trick)
  const set = await page.evaluate((val) => {
    const s = document.querySelector('input[type="range"]');
    if (!s) return false;
    const max = parseFloat(s.max) || 9999999;
    const clamped = Math.min(val, max);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(s, clamped);
    s.dispatchEvent(new Event('input',  { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return { set: clamped, max };
  }, amount);

  if (!set) throw new Error('Slider not found in DOM');

  // If the value was clamped (card's offer max is below our payout), warn but continue
  if (set.set < amount) {
    console.log(`  ⚠  Slider max ${set.max} — clamped to ${set.set} (payout ${amount}). Consider a higher-value card.`);
  }
  return set.set;
}

// ── Core offer flow ────────────────────────────────────────────────────────────

async function processOffer(page, cardUrl, offerAmount) {
  await page.goto(cardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(rand(1800, 3000));

  // Click the Offer button on the card page to open the modal
  const openBtn = page.getByRole('button', { name: /^offer$/i }).first();
  try {
    await openBtn.waitFor({ timeout: 12000 });
  } catch {
    throw new Error('Offer button not found — not logged in or wrong card URL');
  }
  await openBtn.click();
  await sleep(rand(900, 1500));

  // Wait for the slider in the modal
  const slider = page.locator('input[type="range"]').first();
  await slider.waitFor({ timeout: 10000 });
  await sleep(rand(400, 800));

  // Set the offer amount
  const actualAmount = await setSlider(page, offerAmount);
  await sleep(rand(600, 1200));

  // Click 48h duration
  const dur48 = page.getByRole('button', { name: /^48h$/i }).first();
  await dur48.waitFor({ timeout: 5000 });
  await dur48.click();
  await sleep(rand(500, 900));

  // Submit — the modal's Offer button is the last one in the DOM
  const submitBtn = page.getByRole('button', { name: /^offer$/i }).last();
  await submitBtn.click();
  await sleep(rand(2000, 3500));

  return actualAmount;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const contextOpts = fs.existsSync(STATE_FILE)
    ? { storageState: STATE_FILE }
    : {};
  const context = await browser.newContext({
    ...contextOpts,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });

  // Mask automation flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();

  // Check RS login
  await page.goto('https://www.realapp.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  const loggedIn = await page.evaluate(() => {
    const ls = localStorage.getItem('persist:real-sports-app') || '';
    return ls.includes('token') || document.body.innerText.toLowerCase().includes('edgebot');
  });

  if (!loggedIn) {
    console.log('\n══════════════════════════════════════════════════');
    console.log(' Log in to RS as edgebot in the browser window.');
    console.log(' Press Enter here when done.');
    console.log('══════════════════════════════════════════════════\n');
    await new Promise(r => process.stdin.once('data', r));
    await context.storageState({ path: STATE_FILE });
    console.log('Session saved to browser-state.json\n');
  } else {
    console.log('Loaded saved RS session.\n');
  }

  // Fetch queue
  console.log('Fetching payout queue from RaxEdge...');
  let queue;
  try {
    queue = await fetchQueue();
  } catch (e) {
    console.error('Failed:', e.message);
    await browser.close();
    return;
  }

  if (!queue.length) {
    console.log('No pending payouts. Nothing to do.');
    await browser.close();
    return;
  }

  console.log(`${queue.length} pending payout(s):\n`);
  queue.forEach(e => console.log(`  #${e.id}  @${e.rs_username}  ${Number(e.offer_amount).toLocaleString()} Rax`));
  console.log('');

  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    console.log(`\n[${i + 1}/${queue.length}] Payout #${entry.id} — @${entry.rs_username} — ${Number(entry.offer_amount).toLocaleString()} Rax`);

    // Get card URL (use already-prepared card if available)
    let cardUrl    = entry.card_url;
    let offerAmount = entry.offer_amount;
    if (!cardUrl) {
      console.log('  Finding card in winner\'s RS inventory...');
      try {
        const p = await prepareEntry(entry.id);
        cardUrl    = p.cardUrl;
        offerAmount = p.offerAmount;
        console.log(`  Card: ${cardUrl}`);
      } catch (e) {
        console.error('  No card found:', e.message);
        continue;
      }
    } else {
      console.log(`  Card: ${cardUrl}`);
    }

    try {
      const sent = await processOffer(page, cardUrl, offerAmount);
      await markSent(entry.id);
      console.log(`  ✓ Offer sent (${Number(sent).toLocaleString()} Rax) — marked sent`);
    } catch (e) {
      console.error('  ✗ Failed:', e.message);
      await page.screenshot({ path: path.join(__dirname, `error-${entry.id}.png`) }).catch(() => {});
      console.log(`  Screenshot saved: error-${entry.id}.png`);
    }

    if (i < queue.length - 1) {
      const wait = rand(4000, 9000);
      console.log(`  Waiting ${(wait / 1000).toFixed(1)}s...`);
      await sleep(wait);
    }
  }

  await context.storageState({ path: STATE_FILE });
  console.log('\n✓ All done. Closing in 3s...');
  await sleep(3000);
  await browser.close();
}

main().catch(async e => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
