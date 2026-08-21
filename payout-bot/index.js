#!/usr/bin/env node
// payout-bot/index.js — AppleScript edition
// Drives real Safari (where edgebot is already logged in) via osascript.
// No Playwright, no CDP fingerprint, Turnstile passes naturally.
//
// Prerequisites:
//   1. Safari → Settings → Advanced → ✅ Allow JavaScript from Apple Events
//   2. System Settings → Privacy & Security → Accessibility → add your terminal app
//   3. edgebot must be logged in to realapp.com in Safari
//
// Usage:
//   node index.js --test <cardUrl> <amount>   ← dry run (skips final submit)
//   node index.js                              ← process payout queue

require('dotenv').config();
const { exec }  = require('child_process');
const util      = require('util');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');
const execAsync = util.promisify(exec);

const RAXEDGE_URL = (process.env.RAXEDGE_URL || 'https://raxedge.com').replace(/\/$/, '');
const CRON_SECRET = process.env.CRON_SECRET;
const MAX_PER_RUN = parseInt(process.env.MAX_PER_RUN || '12', 10);

if (!CRON_SECRET) { console.error('CRON_SECRET not set in .env'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand  = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

// ── API helpers ────────────────────────────────────────────────────────────────
async function api(p, method = 'GET') {
  const sep = p.includes('?') ? '&' : '?';
  const res  = await fetch(`${RAXEDGE_URL}${p}${sep}_cron_key=${CRON_SECRET}`, { method });
  return res.json();
}
async function fetchQueue() {
  const d = await api('/api/parlays/payout-queue?action=list');
  if (!d.ok) throw new Error('Queue fetch failed: ' + JSON.stringify(d));
  return (d.queue || [])
    .filter(e => e.status === 'pending' && (e.attempts || 0) < 3)
    .sort((a, b) => (a.attempts || 0) - (b.attempts || 0))
    .slice(0, MAX_PER_RUN);
}
async function markAttempt(id) {
  await api(`/api/parlays/payout-queue?action=mark_attempt&id=${id}`, 'POST').catch(() => {});
}
async function prepareEntry(id) {
  const d = await api(`/api/parlays/payout-queue?action=prepare&id=${id}`, 'POST');
  if (!d.ok) throw new Error(d.error || 'prepare failed');
  return d;
}
async function markSent(id) {
  const d = await api(`/api/parlays/payout-queue?action=mark_sent&id=${id}`, 'POST');
  return d.ok;
}

// ── AppleScript / Safari helpers ───────────────────────────────────────────────

// Run an AppleScript file via osascript (avoids all shell-escaping of the script body)
async function runOSA(script) {
  const f = path.join(os.tmpdir(), `rax-osa-${Date.now()}.applescript`);
  fs.writeFileSync(f, script, 'utf8');
  try {
    const { stdout } = await execAsync(`osascript "${f}"`);
    return stdout.trim();
  } catch { return null; }
  finally { try { fs.unlinkSync(f); } catch {} }
}

// Execute JS in Safari's current tab — JS is written to a temp file to avoid escaping
async function safariEval(js) {
  const jf = path.join(os.tmpdir(), `rax-js-${Date.now()}.js`);
  fs.writeFileSync(jf, js, 'utf8');
  const result = await runOSA(`
set jsCode to read POSIX file "${jf}"
tell application "Safari"
  do JavaScript jsCode in current tab of window 1
end tell
`);
  try { fs.unlinkSync(jf); } catch {}
  return result;
}

// Open a new Safari tab, navigate to url, make it active
async function safariOpenTab(url) {
  await runOSA(`
tell application "Safari"
  activate
  tell window 1
    set newTab to make new tab
    set URL of newTab to "${url}"
    set current tab to newTab
  end tell
end tell
`);
}

// Close Safari's current tab
async function safariCloseTab() {
  await runOSA(`tell application "Safari" to close current tab of window 1`).catch(() => {});
}

// Click at absolute screen coordinates using System Events
async function systemClick(x, y) {
  await runOSA(`
tell application "Safari" to activate
delay 0.1
tell application "System Events"
  click at {${Math.round(x)}, ${Math.round(y)}}
end tell
`);
}

// Poll until a JS expression returns a truthy, non-null string
async function safariWaitFor(jsExpr, timeout = 12000) {
  const wrapped = `(function(){try{var r=(${jsExpr});return(r!==null&&r!==undefined&&r!==false&&r!=='')?String(r):null}catch(e){return null}})()`;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const r = await safariEval(wrapped);
    if (r && r !== 'null' && r !== 'false' && r !== 'undefined' && r !== '') return r;
    await sleep(400);
  }
  throw new Error(`Timeout (${timeout}ms) waiting for: ${jsExpr.slice(0, 100)}`);
}

// Returns the screen coordinate of the viewport top-left corner
// (window.screenX/Y give the window position; toolbar height = outerHeight - innerHeight)
async function viewportOrigin() {
  const r = await safariEval(`window.screenX + ',' + (window.screenY + window.outerHeight - window.innerHeight)`);
  const [x, y] = (r || '0,0').split(',').map(Number);
  return { x, y };
}

// ── Card-finding JS (reused in waitFor) ───────────────────────────────────────
const FIND_CARD_JS = `
(function() {
  var vw = window.innerWidth, vh = window.innerHeight;
  for (var xp = 0.20; xp <= 0.75; xp += 0.05) {
    for (var yp = 0.35; yp <= 0.85; yp += 0.05) {
      var x = Math.round(vw * xp), y = Math.round(vh * yp);
      var el = document.elementFromPoint(x, y);
      for (var i = 0; i < 10; i++) {
        if (!el || el === document.body) break;
        var r = el.getBoundingClientRect();
        if (r.width >= 180 && r.width <= 700 && r.height >= 250 && r.height <= 900 &&
            r.left >= 0 && r.right <= vw * 0.9)
          return (r.x + r.width / 2) + ',' + (r.y + r.height / 2);
        el = el.parentElement;
      }
    }
  }
  return null;
})()
`;

const FIND_TEXT_JS = (text) => `
(function() {
  var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var n;
  while (n = w.nextNode()) {
    if (n.textContent.trim() === '${text}') {
      var r = n.parentElement.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return r.x + r.width / 2 + ',' + (r.y + r.height / 2);
    }
  }
  return null;
})()
`;

// Find "Offer" only when the context menu is confirmed open (Market data also visible)
const FIND_OFFER_IN_MENU_JS = `
(function() {
  var nodes = [];
  var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var n;
  while (n = w.nextNode()) {
    var t = n.textContent.trim();
    if (t === 'Offer' || t === 'Market data') {
      var r = n.parentElement.getBoundingClientRect();
      nodes.push({ text: t, r: r });
    }
  }
  var hasMenu = nodes.some(function(x) { return x.text === 'Market data' && x.r.width > 0; });
  if (!hasMenu) return null;
  var offer = nodes.find(function(x) { return x.text === 'Offer' && x.r.width > 0; });
  if (!offer) return null;
  return offer.r.x + offer.r.width / 2 + ',' + (offer.r.y + offer.r.height / 2);
})()
`;

// ── Core offer flow ────────────────────────────────────────────────────────────
async function processOffer(cardUrl, offerAmount, dryRun = false) {
  console.log(`  Opening: ${cardUrl}`);
  await safariOpenTab(cardUrl);
  await sleep(rand(1000, 1500));

  // Scroll down so card is visible
  await safariEval(`window.scrollBy(0, ${rand(150, 280)})`);
  await sleep(200);

  // Find card and click it to open context menu
  const cardStr = await safariWaitFor(FIND_CARD_JS);
  const [cardX, cardY] = cardStr.split(',').map(Number);
  const origin = await viewportOrigin();

  await systemClick(origin.x + cardX, origin.y + cardY);
  await sleep(400);

  // Wait for context menu to open (Market data visible = menu is open), then JS-click "Offer"
  await safariWaitFor(`
(function() {
  var nodes = [];
  var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var n;
  while (n = w.nextNode()) {
    var t = n.textContent.trim();
    nodes.push({ text: t, el: n.parentElement, r: n.parentElement.getBoundingClientRect() });
  }
  var menuOpen = nodes.some(function(x) { return x.text === 'Market data' && x.r.width > 0; });
  if (!menuOpen) return null;
  var offer = nodes.find(function(x) { return x.text === 'Offer' && x.r.width > 0; });
  if (!offer) return null;
  offer.el.click();
  return 'clicked';
})()
`);
  await sleep(300);

  // Wait for slider modal
  await safariWaitFor(`document.querySelector('input[type="range"]')`);

  // Set slider value via native setter (React-compatible)
  const sliderRes = await safariEval(`
(function() {
  var s = document.querySelector('input[type="range"]');
  if (!s) return 'no-slider';
  var max = parseFloat(s.max) || 9999999, min = parseFloat(s.min) || 0;
  var v = Math.min(Math.max(${offerAmount}, min), max);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(s, v);
  s.dispatchEvent(new Event('input',  { bubbles: true }));
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return v + ',' + max;
})()
`);

  if (!sliderRes || sliderRes === 'no-slider') throw new Error('Slider not found');
  const [setVal, maxVal] = sliderRes.split(',').map(Number);
  if (setVal < offerAmount) {
    console.log(`  ⚠  Slider max is ${maxVal} Rax — card value too low, skipping.`);
    await safariCloseTab();
    return false;
  }

  // JS-click 48h duration pill
  await safariEval(`
(function() {
  var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var n;
  while (n = w.nextNode()) {
    if (n.textContent.trim() === '48h') { n.parentElement.click(); return; }
  }
})()
`);
  await sleep(150);

  if (dryRun) {
    console.log('  [DRY RUN] Offer ready — slider set, 48h selected. Pausing 5s to verify.');
    await sleep(5000);
    await safariCloseTab();
    return true;
  }

  await sleep(300);

  // Exact same pattern as 48h: find the last text node "Offer", click its parent.
  // No button-tag check — element may be a div with click handler, not <button>.
  await safariEval(`
(function() {
  var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var n, last = null;
  while (n = w.nextNode()) {
    if (n.textContent.trim() === 'Offer') last = n;
  }
  if (last) last.parentElement.click();
})()
`);
  await sleep(1500);

  await safariCloseTab();
  return true;
}

// ── Test mode ──────────────────────────────────────────────────────────────────
async function runTest(cardUrl, amount) {
  console.log('\n TEST MODE — dry run, no offer submitted');
  console.log(` Card:   ${cardUrl}`);
  console.log(` Amount: ${Number(amount).toLocaleString()} Rax\n`);
  try {
    const ok = await processOffer(cardUrl, amount, true);
    console.log(ok ? '\n✓ Test passed.' : '\n✗ Slider max too low.');
  } catch (e) {
    console.error('\n✗ Error:', e.message);
  }
}

const LOCK_FILE    = path.join(__dirname, '.daemon.lock');
const CHECK_EVERY  = 5 * 60 * 1000; // 5 minutes between queue checks

const ts = () => new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ── Shared queue processing (used by main + daemon) ────────────────────────────
async function processQueue() {
  let queue;
  try { queue = await fetchQueue(); }
  catch (e) { console.error(`[${ts()}] Queue error:`, e.message); return 0; }

  if (!queue.length) { console.log(`[${ts()}] No pending payouts.`); return 0; }

  console.log(`[${ts()}] ${queue.length} pending payout(s):\n`);
  queue.forEach(e => console.log(`  #${e.id}  @${e.rs_username}  ${Number(e.offer_amount).toLocaleString()} Rax`));

  let sent = 0;
  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    console.log(`\n[${ts()}] [${i + 1}/${queue.length}] #${entry.id} — @${entry.rs_username} — ${Number(entry.offer_amount).toLocaleString()} Rax`);

    let cardUrl = entry.card_url, offerAmount = entry.offer_amount;
    if (!cardUrl) {
      try {
        const p = await prepareEntry(entry.id);
        cardUrl = p.cardUrl; offerAmount = p.offerAmount;
        console.log(`  Card: ${cardUrl}`);
      } catch (e) { console.error('  ✗ No card:', e.message); continue; }
    } else {
      console.log(`  Card: ${cardUrl}`);
    }

    try {
      const ok = await processOffer(cardUrl, offerAmount);
      if (ok) { await markSent(entry.id); console.log('  ✓ Offer sent'); sent++; }
      else { await markAttempt(entry.id); console.log('  ✗ Skipped (card value too low)'); }
    } catch (e) {
      console.error('  ✗ Error:', e.message);
      await markAttempt(entry.id);
      await safariCloseTab();
    }

    if (i < queue.length - 1) {
      const wait = rand(30, 90);
      console.log(`  Waiting ${wait}s before next offer...`);
      await sleep(wait * 1000);
    }
  }

  console.log(`\n[${ts()}] ✓ Done — ${sent}/${queue.length} offers sent.`);
  return sent;
}

// ── One-shot main ──────────────────────────────────────────────────────────────
async function main() {
  await processQueue();
}

// ── Daemon mode: run forever, check every 5 minutes ───────────────────────────
async function runDaemon() {
  // Stale-safe lock: check if prior PID is still alive
  if (fs.existsSync(LOCK_FILE)) {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    try {
      process.kill(pid, 0); // throws if process doesn't exist
      console.error(`Daemon already running (PID ${pid}). Exiting.`);
      process.exit(0);
    } catch {
      fs.unlinkSync(LOCK_FILE); // stale lock — clean up
    }
  }

  fs.writeFileSync(LOCK_FILE, String(process.pid));
  const cleanup = () => { try { fs.unlinkSync(LOCK_FILE); } catch {} process.exit(0); };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  console.log(`\n Payout bot daemon started (PID ${process.pid})`);
  console.log(` Checking every ${CHECK_EVERY / 60000} minutes. Ctrl+C to stop.\n`);

  while (true) {
    console.log(`[${ts()}] Checking queue...`);
    await processQueue();
    console.log(`[${ts()}] Sleeping ${CHECK_EVERY / 60000} min...\n`);
    await sleep(CHECK_EVERY);
  }
}

// ── Entry point ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args[0] === '--test') {
  const cardUrl = args[1], amount = parseFloat(args[2]);
  if (!cardUrl || isNaN(amount)) {
    console.error('Usage: node index.js --test <cardUrl> <amount>');
    process.exit(1);
  }
  runTest(cardUrl, amount).catch(e => { console.error('Fatal:', e.message); process.exit(1); });
} else if (args[0] === '--daemon') {
  runDaemon().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
} else {
  main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}
