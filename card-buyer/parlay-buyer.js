#!/usr/bin/env node
// card-buyer/parlay-buyer.js — AppleScript edition
// Buys MLB 2025 10 Rax RS marketplace cards for the parlay deposit pool.
// Drives real Safari (edgebot logged in) via osascript — no browser fingerprint.
//
// Prerequisites:
//   1. Safari → Settings → Advanced → ✅ Allow JavaScript from Apple Events
//   2. System Settings → Privacy & Security → Accessibility → add your terminal app
//   3. edgebot must be logged in to realapp.com in Safari
//
// Usage:
//   node parlay-buyer.js        ← buy MLB 2025 cards (parlay pool)
//   node parlay-buyer.js --test ← dry run (finds cards, skips Place Bid)

const { exec }  = require('child_process');
const util      = require('util');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');
const execAsync = util.promisify(exec);

const DRY_RUN = process.argv.includes('--test');
const SPORT   = 'MLB';
const YEAR    = '2025';

const sleep = ms     => new Promise(r => setTimeout(r, ms));

// Scroll the RS marketplace — tries the deepest scrollable container first, falls back to window
const SCROLL_JS = (px) => `
(function() {
  var el = document.elementFromPoint(window.innerWidth/2, window.innerHeight/2);
  while (el && el !== document.body) {
    var s = window.getComputedStyle(el);
    var ov = s.overflowY;
    if ((ov === 'auto' || ov === 'scroll') && el.scrollHeight > el.clientHeight) {
      el.scrollBy(0, ${px});
      return 'container:' + el.tagName + el.className.slice(0,30);
    }
    el = el.parentElement;
  }
  window.scrollBy(0, ${px});
  return 'window';
})()
`;
const rand  = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const ts    = ()     => new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ── AppleScript / Safari helpers ───────────────────────────────────────────────

async function runOSA(script) {
  const f = path.join(os.tmpdir(), `rax-osa-${Date.now()}.applescript`);
  fs.writeFileSync(f, script, 'utf8');
  try {
    const { stdout } = await execAsync(`osascript "${f}"`);
    return stdout.trim();
  } catch { return null; }
  finally { try { fs.unlinkSync(f); } catch {} }
}

async function safariEval(js) {
  const jf = path.join(os.tmpdir(), `rax-js-${Date.now()}.js`);
  fs.writeFileSync(jf, js, 'utf8');
  // Find the realapp.com tab specifically — avoids evaluating in wrong tab
  const result = await runOSA(`
set jsCode to read POSIX file "${jf}"
tell application "Safari"
  set targetTab to missing value
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t contains "realapp.com" then
        set targetTab to t
        set current tab of w to t
        set index of w to 1
        exit repeat
      end if
    end repeat
    if targetTab is not missing value then exit repeat
  end repeat
  if targetTab is missing value then
    do JavaScript jsCode in current tab of window 1
  else
    do JavaScript jsCode in targetTab
  end if
end tell
`);
  try { fs.unlinkSync(jf); } catch {}
  return result;
}

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

async function safariCloseTab() {
  await runOSA(`tell application "Safari" to close current tab of window 1`).catch(() => {});
}

async function systemClick(x, y) {
  await runOSA(`
tell application "Safari" to activate
delay 0.1
tell application "System Events"
  click at {${Math.round(x)}, ${Math.round(y)}}
end tell
`);
}

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

async function viewportOrigin() {
  // Use AppleScript System Events to get the real window position (correct in full-screen too),
  // then add the browser chrome height from JS.
  const winPos = await runOSA(`
tell application "System Events"
  tell process "Safari"
    set p to position of window 1
    set wx to item 1 of p
    set wy to item 2 of p
    return (wx as string) & "," & (wy as string)
  end tell
end tell
`);
  const chromeH = await safariEval(`window.outerHeight - window.innerHeight`);
  const [wx, wy] = (winPos || '0,0').split(',').map(Number);
  const ch = parseInt(chromeH || '80', 10);
  return { x: wx, y: wy + ch };
}

// ── Navigation helpers ─────────────────────────────────────────────────────────

// JS text-walker click helper — finds first visible element matching text and clicks it
function jsClickText(text, opts = {}) {
  const exact    = opts.exact !== false;
  const maxY     = opts.maxY  || 9999;
  const minY     = opts.minY  || 0;
  const matchFn  = exact
    ? `n.textContent.trim() === ${JSON.stringify(text)}`
    : `n.textContent.trim().includes(${JSON.stringify(text)})`;
  return `
(function() {
  var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var n;
  while (n = w.nextNode()) {
    if (!(${matchFn})) continue;
    var el = n.parentElement;
    var r  = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.top < ${minY} || r.top > ${maxY}) continue;
    el.click();
    return 'clicked';
  }
  return null;
})()`;
}

// ── Setup: navigate to marketplace, select sport/year, apply rating filter ────

async function goToMarketplace() {
  console.log(`  Opening realapp.com...`);
  await safariOpenTab('https://www.realapp.com');
  await sleep(4000);
  console.log(`  Clicking bank icon at screen (49, 307)...`);
  await systemClick(49, 307);
  await sleep(3000);
  console.log(`  Marketplace ready.`);
}

async function selectSport() {
  console.log(`  Selecting ${SPORT} in marketplace at screen (138, 205)...`);
  await systemClick(138, 205);
  await sleep(2500);
}

async function selectYear() {
  console.log(`  Opening year dropdown at screen (119, 243)...`);
  await systemClick(119, 243);
  await sleep(800);

  console.log(`  Clicking ${YEAR} in dropdown...`);
  await safariWaitFor(jsClickText(YEAR), 5000);
  await sleep(1200);
  console.log(`  Year set to ${YEAR}.`);
}

async function applyRatingFilter() {
  // Check if filter is already set to 0-1 — RS persists filters between sessions
  const currentFilter = await safariEval(`
(function() {
  var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var n;
  while (n = w.nextNode()) {
    var t = n.textContent.trim();
    if (t === '0 - 1' || t === '0-1') {
      var r = n.parentElement.getBoundingClientRect();
      if (r.width > 0 && r.top > 60 && r.top < 300) return t;
    }
  }
  return null;
})()
`);
  if (currentFilter) {
    console.log(`  Rating filter already 0–1, skipping.`);
    return;
  }
  console.log(`  Applying rating 0–1 filter...`);

  // JS-click the rating "All" button in the filter bar (y≈85–150, right of the season dropdown)
  await sleep(1000);
  console.log(`  Clicking rating All button via JS...`);
  await safariWaitFor(`
(function() {
  var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var n;
  while (n = w.nextNode()) {
    if (n.textContent.trim() !== 'All') continue;
    var el = n.parentElement;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.top > 85 && r.top < 150) {
      el.click();
      return 'clicked-at-y' + Math.round(r.top);
    }
  }
  return null;
})()`, 6000);
  await sleep(1000);

  // Click "Rating range" in the filter menu
  await safariWaitFor(jsClickText('Rating range'), 5000);
  await sleep(700);

  // Set max slider (second range input) to 1 using native React setter
  const sliderResult = await safariWaitFor(`
(function() {
  var sliders = document.querySelectorAll('input[type="range"]');
  if (sliders.length < 2) return null;
  var maxSlider = sliders[1];
  var nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  // Set to min value of slider (lowest possible rating)
  var target = parseFloat(maxSlider.min) || 0;
  // If min is 0, step up by 1 to get rating=1 (matches "1 max" we saw in UI)
  if (target === 0 && parseFloat(maxSlider.step || 1) <= 1) target = 1;
  nativeSetter.call(maxSlider, String(target));
  maxSlider.dispatchEvent(new Event('input',  { bubbles: true }));
  maxSlider.dispatchEvent(new Event('change', { bubbles: true }));
  return 'set:' + maxSlider.value;
})()
`, 5000);
  console.log(`  Max slider → ${sliderResult}`);
  await sleep(400);

  // Click Submit
  await safariWaitFor(jsClickText('Submit'), 5000);
  await sleep(1500);
  console.log(`  Rating filter applied.`);
}

// ── Core buy loop ──────────────────────────────────────────────────────────────

// Find the first visible "Bid" button whose card container also has price text "10".
// Returns viewport-relative coords "x,y" or null if none found.
// Walk up from el to find the enclosing card container (first ancestor >= 300px tall)
const CARD_PRICE_JS = `
function getCardPrice(bidEl) {
  var r = bidEl.getBoundingClientRect();
  var container = bidEl.parentElement;
  while (container && container !== document.body) {
    if (container.getBoundingClientRect().height > 300) break;
    container = container.parentElement;
  }
  if (!container) return null;
  // Last pure-number text node above the Bid button inside the card = price
  var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  var lastNum = null; var lastEl = null; var tn;
  while (tn = walker.nextNode()) {
    var t = tn.textContent.trim();
    if (!/^\\d+$/.test(t)) continue;
    var pr = tn.parentElement.getBoundingClientRect();
    if (pr.bottom <= r.top) { lastNum = t; lastEl = tn.parentElement; }
  }
  if (!lastNum) return null;
  // Check if price is green (already highest bidder) — green = skip
  if (lastEl) {
    var col = window.getComputedStyle(lastEl).color;
    var m = col.match(/rgb\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
    if (m) {
      var rr = +m[1], gg = +m[2], bb = +m[3];
      // Green: green channel dominant and significantly higher than red/blue
      if (gg > 120 && gg > rr * 1.4 && gg > bb * 1.4) return 'GREEN:' + lastNum;
    }
  }
  return lastNum;
}
`;

const FIND_10_BID_JS = CARD_PRICE_JS + `
(function() {
  var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var n;
  while (n = w.nextNode()) {
    if (n.textContent.trim() !== 'Bid') continue;
    var bidEl = n.parentElement;
    if (bidEl.dataset.raxDone) continue;
    var r = bidEl.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.top < 0 || r.top > window.innerHeight) continue;
    if (getCardPrice(bidEl) === '10') return (r.x + r.width/2) + ',' + (r.y + r.height/2);
  }
  return null;
})()
`;

async function buyOneCard() {
  // Check if there's a 10 Rax Bid button visible
  const bidStr = await safariEval(FIND_10_BID_JS);
  if (!bidStr || bidStr === 'null') return false;

  const [bidX, bidY] = bidStr.split(',').map(Number);

  // JS-click the Bid button — mark it done first so we never re-target it
  await safariEval(CARD_PRICE_JS + `
(function() {
  var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var n;
  while (n = w.nextNode()) {
    if (n.textContent.trim() !== 'Bid') continue;
    var bidEl = n.parentElement;
    if (bidEl.dataset.raxDone) continue;
    var r = bidEl.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.top < 0 || r.top > window.innerHeight) continue;
    if (getCardPrice(bidEl) === '10') { bidEl.dataset.raxDone = '1'; bidEl.click(); return 'clicked'; }
  }
  return null;
})()
`);
  await sleep(400);

  // Wait for bid modal (Place Bid button must appear)
  await safariWaitFor(`
(function() {
  var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var n;
  while (n = w.nextNode()) {
    if (n.textContent.trim() === 'Place Bid') {
      var r = n.parentElement.getBoundingClientRect();
      if (r.width > 0) return 'ready';
    }
  }
  return null;
})()
`, 6000);

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Bid modal open — skipping Place Bid`);
    // Close modal with Escape
    await safariEval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, keyCode: 27 }))`);
    await sleep(600);
    return true;
  }

  // Click Place Bid
  await safariEval(`
(function() {
  var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var n;
  while (n = w.nextNode()) {
    if (n.textContent.trim() === 'Place Bid') {
      n.parentElement.click();
      return 'clicked';
    }
  }
})()
`);
  await sleep(700);

  // Verify success: modal should be gone
  const check = await safariEval(`
(function() {
  var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var n;
  var ERR = ['already bid', 'already have', 'insufficient', 'cannot', 'limit reached', 'failed', 'error'];
  while (n = w.nextNode()) {
    var t = n.textContent.trim();
    if (t === 'Place Bid') {
      var r = n.parentElement.getBoundingClientRect();
      if (r.width > 0) return 'modal_still_open';
    }
    var tl = t.toLowerCase();
    for (var i = 0; i < ERR.length; i++) {
      if (tl.includes(ERR[i])) {
        var r2 = n.parentElement.getBoundingClientRect();
        if (r2.width > 0) return 'error:' + t.slice(0, 120);
      }
    }
  }
  return 'success';
})()
`);

  if (check && check.startsWith('error:')) throw new Error(check.slice(6));
  if (check === 'modal_still_open') throw new Error('Bid modal did not close — possible RS error');

  return true;
}

// ── Main loop ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n Parlay Buyer  |  ${SPORT} ${YEAR}  |  ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(` Ctrl+C to stop\n`);

  await goToMarketplace();
  await selectSport();
  await selectYear();
  await applyRatingFilter();

  console.log(`\n  Scanning for 10 Rax cards...\n`);

  let total         = 0;
  let emptyScrolls  = 0;
  const MAX_SCROLLS = 20; // scroll past ~10 full screens before resetting

  while (true) {
    try {
      const bought = await buyOneCard();

      if (bought) {
        total++;
        console.log(`[${ts()}] ✓ Bought #${total}  (${SPORT} ${YEAR})`);
        emptyScrolls = 0;
        // Don't scroll — data-raxDone prevents re-targeting, so loop immediately
        // to find the next 10 Rax card still visible on screen.
        await sleep(rand(200, 400));
      } else {
        // No 10 Rax card visible — scroll down
        emptyScrolls++;

        if (emptyScrolls >= MAX_SCROLLS) {
          console.log(`[${ts()}] End of page — scrolling to top, waiting 30s for new listings...`);
          await safariEval(`
(function() {
  var el = document.elementFromPoint(window.innerWidth/2, window.innerHeight/2);
  while (el && el !== document.body) {
    var s = window.getComputedStyle(el);
    var ov = s.overflowY;
    if ((ov === 'auto' || ov === 'scroll') && el.scrollHeight > el.clientHeight) {
      el.scrollTo(0, 0); return 'top';
    }
    el = el.parentElement;
  }
  window.scrollTo(0, 0); return 'top-window';
})()`);
          emptyScrolls = 0;
          await sleep(30000);
        } else {
          await safariEval(SCROLL_JS(350));
          await sleep(300);
        }
      }
    } catch (e) {
      console.error(`[${ts()}] ✗ ${e.message}`);
      // Close any stray modal and keep going
      await safariEval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, keyCode: 27 }))`).catch(() => {});
      await sleep(2000);
    }
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
