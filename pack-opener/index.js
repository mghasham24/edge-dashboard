#!/usr/bin/env node
// pack-opener/index.js — opens RS player packs via Safari UI clicks
// Usage: node --env-file=.env index.js

import { readFileSync } from 'fs';
import fs               from 'fs';
import { join, dirname } from 'path';
import path              from 'path';
import { fileURLToPath } from 'url';
import { exec }          from 'child_process';
import util              from 'util';
import os                from 'os';
import { hashidsEncode } from '../functions/_lib/hashids.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execAsync = util.promisify(exec);

const AUTH_INFO     = process.env.RS_AUTH_INFO;
const SESSION_TOKEN = process.env.RS_SESSION_TOKEN;
const DEVICE_UUID   = process.env.RS_DEVICE_UUID || '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';

if (!AUTH_INFO || !SESSION_TOKEN) {
  console.error('RS_AUTH_INFO and RS_SESSION_TOKEN required in .env');
  process.exit(1);
}

const packs = JSON.parse(readFileSync(join(__dirname, 'packs.json'), 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand  = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const ts    = () => new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ── Safari helpers ────────────────────────────────────────────────────────────

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
  const result = await runOSA(`
set jsCode to read POSIX file "${jf}"
tell application "Safari"
  do JavaScript jsCode in current tab of window 1
end tell
`);
  try { fs.unlinkSync(jf); } catch {}
  return result;
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

// Returns the screen coordinate of the viewport top-left corner
async function viewportOrigin() {
  const r = await safariEval(`window.screenX + ',' + (window.screenY + window.outerHeight - window.innerHeight)`);
  const [x, y] = (r || '0,0').split(',').map(Number);
  return { x, y };
}

// Open a new Safari tab and navigate to url
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

// ── DOM helpers ───────────────────────────────────────────────────────────────

async function hasVisible(text) {
  const r = await safariEval(`
(function() {
  return Array.from(document.querySelectorAll('*')).some(function(e) {
    return e.offsetParent !== null && e.childElementCount === 0 && e.textContent.trim().includes(${JSON.stringify(text)});
  }) ? 'yes' : 'no';
})()
`);
  return r === 'yes';
}

async function waitForText(text, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await hasVisible(text)) return true;
    await sleep(500);
  }
  return false;
}

async function waitForTextGone(text, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!(await hasVisible(text))) return true;
    await sleep(400);
  }
  return false;
}

// Shared tap helper — inlined into safariEval calls that need to fire touch events
const TAP_FN = `
function tap(el) {
  var r = el.getBoundingClientRect(), x = r.left + r.width/2, y = r.top + r.height/2;
  try {
    var t = new Touch({identifier: Date.now(), target: el, clientX: x, clientY: y, radiusX: 2, radiusY: 2, rotationAngle: 0, force: 1});
    el.dispatchEvent(new TouchEvent('touchstart', {bubbles:true, cancelable:true, touches:[t], targetTouches:[t], changedTouches:[t]}));
    el.dispatchEvent(new TouchEvent('touchend',   {bubbles:true, cancelable:true, touches:[],  targetTouches:[],  changedTouches:[t]}));
  } catch(e) {}
  el.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, cancelable:true, pointerId:1, pointerType:'touch', isPrimary:true, clientX:x, clientY:y}));
  el.dispatchEvent(new PointerEvent('pointerup',   {bubbles:true, cancelable:true, pointerId:1, pointerType:'touch', isPrimary:true, clientX:x, clientY:y}));
  el.dispatchEvent(new MouseEvent('click',         {bubbles:true, cancelable:true, clientX:x, clientY:y}));
}
`;

async function clickText(text, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const r = await safariEval(`
(function() {
  ${TAP_FN}
  var t = ${JSON.stringify(text)};
  var el = Array.from(document.querySelectorAll('button, a, [role="button"], span, div')).find(function(e) {
    return e.offsetParent !== null && e.textContent.trim() === t;
  });
  if (!el) return 'not-found';
  var r = el.getBoundingClientRect();
  var x = r.left + r.width/2, y = r.top + r.height/2;
  var top = document.elementFromPoint(x, y) || el;
  tap(top);
  return 'ok:' + top.tagName + ':' + (top.className||'').slice(0,20);
})()
`);
    if (r && r.startsWith('ok')) return true;
    await sleep(500);
  }
  return false;
}

// ── API (GET only — read-only) ────────────────────────────────────────────────

function buildHeaders() {
  return {
    'Accept':             'application/json',
    'Content-Type':       'application/json',
    'Origin':             'https://www.realapp.com',
    'Referer':            'https://www.realapp.com/',
    'User-Agent':         'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
    'real-auth-info':     AUTH_INFO,
    'real-session-token': SESSION_TOKEN,
    'real-device-uuid':   DEVICE_UUID,
    'real-device-type':   'desktop_web',
    'real-device-name':   '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
    'real-version':       '36',
    'real-request-token': hashidsEncode(Date.now()),
  };
}

async function getPackInfo(pack) {
  const url = `https://web.realapp.com/collectingpacks/player` +
    `?entityId=${pack.entityId}&season=${pack.season}&sport=${pack.sport}`;
  const res = await fetch(url, { headers: buildHeaders(), signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Navigation ────────────────────────────────────────────────────────────────

async function navigateTo(url) {
  await runOSA(`
tell application "Safari"
  activate
  if (count of windows) = 0 then make new document
  set URL of current tab of window 1 to "${url}"
end tell
`);
  await sleep(3500);
}

// On the player page, select the correct season year from the dropdown
async function selectSeason(season) {
  // season is the display string from pack.label, e.g. "2023-24" or "2026"
  // yearShort is the first part (before '-'), used as prefix to open the dropdown
  const yearShort = season.split('-')[0]; // "2023" from "2023-24", "2026" from "2026"

  // Find the season pill — top-left pill that shows a year (e.g. "2026") OR "Career"
  const current = await safariEval(`
(function() {
  var cands = Array.from(document.querySelectorAll('*')).filter(function(e) {
    if (!e.offsetParent) return false;
    var r = e.getBoundingClientRect();
    if (r.top > window.innerHeight * 0.2) return false;
    if (r.left > window.innerWidth * 0.4) return false; // pill is on the left side
    var t = e.textContent.trim();
    return (t === 'Career' || /20\\d\\d/.test(t)) && t.length < 25;
  });
  cands.sort(function(a,b) {
    var ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
    return (ra.width*ra.height)-(rb.width*rb.height);
  });
  return cands[0] ? cands[0].textContent.trim() : '';
})()
`);

  // Already correct if the pill text matches the target season exactly or starts with yearShort
  // (for single-year sports "2026" === "2026"; for multi-year "2023-24" starts with "2023")
  if (current && (current === season || current.startsWith(yearShort + '-'))) return 'already-correct';

  // Tap the season pill via elementFromPoint to open the dropdown
  await safariEval(`
(function() {
  ${TAP_FN}
  var cands = Array.from(document.querySelectorAll('*')).filter(function(e) {
    if (!e.offsetParent) return false;
    var r = e.getBoundingClientRect();
    if (r.top > window.innerHeight * 0.2) return false;
    if (r.left > window.innerWidth * 0.4) return false;
    var t = e.textContent.trim();
    return (t === 'Career' || /20\\d\\d/.test(t)) && t.length < 25;
  });
  cands.sort(function(a,b) {
    var ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
    return (ra.width*ra.height)-(rb.width*rb.height);
  });
  if (!cands[0]) return;
  var r = cands[0].getBoundingClientRect();
  var x = r.left + r.width/2, y = r.top + r.height/2;
  var el = document.elementFromPoint(x, y) || cands[0];
  tap(el);
})()
`);
  await sleep(1200);

  // Select the target season option from the dropdown.
  // The dropdown can be a horizontal carousel (MLB) or vertical list (NBA/NFL/etc).
  // Use elementFromPoint at the found element's center to hit the correct React target.
  const clicked = await safariEval(`
(function(season, yearShort) {
  ${TAP_FN}
  var vw = window.innerWidth, vh = window.innerHeight;

  // isOnScreen: use getBoundingClientRect only — do NOT check offsetParent,
  // because fixed-position dropdown modals have offsetParent===null in RS.
  function isOnScreen(e) {
    var r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0;
  }

  // Exact match on the full display season (e.g. "2023-24" or "2026")
  var exactEls = Array.from(document.querySelectorAll('*')).filter(function(e) {
    return isOnScreen(e) && e.textContent.trim() === season;
  });

  // Fallback: elements starting with "YYYY-" (hyphen enforces it's a season, not a stat label)
  var prefixEls = Array.from(document.querySelectorAll('*')).filter(function(e) {
    if (!isOnScreen(e) || e.childElementCount > 1) return false;
    var t = e.textContent.trim();
    return t.startsWith(yearShort + '-') && t.length < 12;
  });

  var pool = exactEls.length ? exactEls : prefixEls;
  // Sort: fewest children first (leaf nodes), then by y position (topmost list item first)
  pool.sort(function(a, b) {
    if (a.childElementCount !== b.childElementCount) return a.childElementCount - b.childElementCount;
    return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
  });

  if (!pool[0]) {
    var debug = Array.from(document.querySelectorAll('*')).filter(function(e) {
      return isOnScreen(e) && e.textContent.trim().startsWith(yearShort) && e.textContent.trim().length < 15;
    }).map(function(e) {
      var r = e.getBoundingClientRect();
      return '"' + e.textContent.trim() + '"[' + e.tagName + '] @y' + Math.round(r.top) + ' ch=' + e.childElementCount;
    }).join(' | ');
    return 'not-found | saw:' + debug;
  }

  var r = pool[0].getBoundingClientRect();
  var x = r.left + r.width / 2, y = r.top + r.height / 2;
  var top = document.elementFromPoint(x, y) || pool[0];
  tap(top);
  return 'ok:tapped:"' + pool[0].textContent.trim() + '":via-efp="' + top.textContent.trim().slice(0,20) + '"';
})(${JSON.stringify(season)}, ${JSON.stringify(yearShort)})
`);
  await sleep(1000);
  return clicked;
}

// Click the card/pass icon button — immediately to the right of the year dropdown.
// Uses elementFromPoint + touch event dispatch (RS is a mobile web app).
async function clickCardIconButton() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await safariEval(`
(function() {
  // Find the smallest element in the top 20% of the page that contains a year (the year pill)
  var yearCandidates = Array.from(document.querySelectorAll('*')).filter(function(e) {
    if (!e.offsetParent) return false;
    var r = e.getBoundingClientRect();
    if (r.top > window.innerHeight * 0.2) return false;
    return /20\\d\\d/.test(e.textContent.trim()) && e.textContent.trim().length < 20;
  });
  yearCandidates.sort(function(a, b) {
    var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return (ra.width * ra.height) - (rb.width * rb.height);
  });
  var yearBtn = yearCandidates[0];
  if (!yearBtn) return 'no-year';

  var yr = yearBtn.getBoundingClientRect();
  var yCtr = yr.top + yr.height / 2;

  // Look for small icon-like elements to the right of the year pill (width 15–80px).
  // These are candidate icon buttons. We want the FIRST one to the right.
  var topBound = yr.top - 10;
  var botBound = yr.bottom + 10;
  // First try: find the known-working card icon class directly (anywhere in top nav area)
  var direct = document.querySelector('[class*="r-1i6wzkk"]');
  if (direct) {
    var dr = direct.getBoundingClientRect();
    if (dr.top < window.innerHeight * 0.2 && dr.left > yr.right - 10) {
      var cx2 = dr.left + dr.width/2, cy2 = dr.top + dr.height/2;
      try {
        var t2 = new Touch({identifier: Date.now(), target: direct, clientX: cx2, clientY: cy2, radiusX: 2, radiusY: 2, rotationAngle: 0, force: 1});
        direct.dispatchEvent(new TouchEvent('touchstart', {bubbles:true, cancelable:true, touches:[t2], targetTouches:[t2], changedTouches:[t2]}));
        direct.dispatchEvent(new TouchEvent('touchend',   {bubbles:true, cancelable:true, touches:[],   targetTouches:[],   changedTouches:[t2]}));
      } catch(e3) {}
      direct.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, cancelable:true, pointerId:1, pointerType:'touch', isPrimary:true, clientX:cx2, clientY:cy2}));
      direct.dispatchEvent(new PointerEvent('pointerup',   {bubbles:true, cancelable:true, pointerId:1, pointerType:'touch', isPrimary:true, clientX:cx2, clientY:cy2}));
      direct.dispatchEvent(new MouseEvent('click',         {bubbles:true, cancelable:true, clientX:cx2, clientY:cy2}));
      return 'ok:direct:r-1i6wzkk:' + (direct.className || '').slice(0,30);
    }
  }

  var icons = Array.from(document.querySelectorAll('*')).filter(function(e) {
    if (!e.offsetParent) return false;
    var r = e.getBoundingClientRect();
    if (r.left < yr.right + 5) return false;        // must be right of year pill
    if (r.top < topBound || r.bottom > botBound) return false; // same row
    if (r.width < 15 || r.width > 80) return false; // icon-sized
    if (e.children.length > 3) return false;        // not a complex container
    return true;
  });
  icons.sort(function(a, b) {
    return a.getBoundingClientRect().left - b.getBoundingClientRect().left;
  });

  var el = icons[0];
  if (!el) {
    // Fallback: probe 60px right of year pill
    var x = yr.right + 60, y = yCtr;
    el = document.elementFromPoint(x, y);
  }
  if (!el || el === document.body || el === document.documentElement) return 'no-el';

  var r2 = el.getBoundingClientRect();
  var cx = r2.left + r2.width / 2, cy = r2.top + r2.height / 2;
  try {
    var touch = new Touch({ identifier: Date.now(), target: el, clientX: cx, clientY: cy, radiusX: 2, radiusY: 2, rotationAngle: 0, force: 1 });
    el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] }));
    el.dispatchEvent(new TouchEvent('touchend',   { bubbles: true, cancelable: true, touches: [],      targetTouches: [],      changedTouches: [touch] }));
  } catch(e2) {}
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: cx, clientY: cy }));
  el.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: cx, clientY: cy }));
  el.dispatchEvent(new MouseEvent('click',         { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));

  return 'ok:tapped:' + (el.tagName || '?') + ':' + (el.className || '').slice(0, 30);
})()
    `);
    if (result && result.startsWith('ok:')) return result;
    await sleep(600);
  }
  return 'timeout';
}

// On the Player Card screen, tap the player card via elementFromPoint (gets topmost React element)
async function clickPlayerCard() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await safariEval(`
(function() {
  ${TAP_FN}
  // Find the largest visible image (the player card graphic)
  var imgs = Array.from(document.querySelectorAll('img')).filter(function(img) {
    if (!img.offsetParent) return false;
    var r = img.getBoundingClientRect();
    return r.width > 80 && r.height > 80;
  });
  imgs.sort(function(a, b) {
    var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return (rb.width * rb.height) - (ra.width * ra.height);
  });

  var src, x, y;
  if (imgs.length) {
    var r = imgs[0].getBoundingClientRect();
    x = r.left + r.width / 2;
    y = r.top + r.height / 2;
    src = imgs[0].src ? imgs[0].src.slice(-30) : 'img';
  } else {
    // Fallback: canvas
    var cvs = Array.from(document.querySelectorAll('canvas')).filter(function(c) {
      return c.offsetParent !== null && c.width > 60;
    });
    if (!cvs.length) return 'not-found';
    var r = cvs[0].getBoundingClientRect();
    x = r.left + r.width / 2;
    y = r.top + r.height / 2;
    src = 'canvas';
  }

  if (!x || !y) return 'no-rect';
  var el = document.elementFromPoint(x, y);
  if (!el || el === document.body || el === document.documentElement) return 'no-el';
  tap(el);
  return 'ok:' + src + ':' + (el.tagName || '?') + ':' + (el.className || '').slice(0, 25);
})()
    `);
    if (result && result.startsWith('ok:')) return result;
    await sleep(600);
  }
  return 'timeout';
}

// Click the pack bag image inside the card modal.
// The modal shows the player card (card bg image) + a pack bag icon.
// We skip card background images (/cards/bg/) and prefer pack-related assets.
async function clickPackImageInModal() {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const result = await safariEval(`
(function() {
  ${TAP_FN}
  var vhMid = window.innerHeight * 0.6;

  function isCardBg(src) {
    return !src || src.includes('/cards/bg/') || src.includes('/cards/thumbnail/');
  }

  // 1. First try: find an img whose src looks like a pack (contains "pack")
  var packImgs = Array.from(document.querySelectorAll('img')).filter(function(img) {
    var r = img.getBoundingClientRect();
    return img.offsetParent !== null && r.width > 40 && r.height > 40
      && r.bottom < vhMid && (img.src || '').toLowerCase().includes('pack');
  });
  if (packImgs.length) {
    packImgs.sort(function(a,b){ return (b.width*b.height)-(a.width*a.height); });
    tap(packImgs[0]);
    return 'ok:pack-img:' + packImgs[0].src.slice(-40);
  }

  // 2. Try: any img in upper viewport that is NOT a card background
  var nonCardImgs = Array.from(document.querySelectorAll('img')).filter(function(img) {
    var r = img.getBoundingClientRect();
    return img.offsetParent !== null && r.width > 40 && r.height > 40
      && r.bottom < vhMid && !isCardBg(img.src);
  });
  if (nonCardImgs.length) {
    nonCardImgs.sort(function(a,b){
      var ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
      return (rb.width*rb.height)-(ra.width*ra.height);
    });
    tap(nonCardImgs[0]);
    return 'ok:noncard:' + nonCardImgs[0].src.slice(-40);
  }

  // 3. Fallback: canvas in upper viewport
  var cvs = Array.from(document.querySelectorAll('canvas')).filter(function(c) {
    var r = c.getBoundingClientRect();
    return c.offsetParent !== null && r.width > 40 && r.bottom < vhMid;
  });
  if (cvs.length) { tap(cvs[0]); return 'ok:canvas'; }

  // 4. Last resort: card bg image (old behaviour)
  var all = Array.from(document.querySelectorAll('img')).filter(function(img) {
    var r = img.getBoundingClientRect();
    return img.offsetParent !== null && r.width > 60 && r.bottom < vhMid;
  });
  all.sort(function(a,b){ return (b.width*b.height)-(a.width*a.height); });
  if (all[0]) { tap(all[0]); return 'ok:fallback:' + all[0].src.slice(-40); }

  return 'not-found';
})()
    `);
    if (result && result.startsWith('ok:')) return result;
    await sleep(700);
  }
  return 'timeout';
}

// Click the pack image to open it (after Activate pack disappears)
async function clickPackToOpen() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await safariEval(`
(function() {
  ${TAP_FN}
  // Try imgs (any size)
  var imgs = Array.from(document.querySelectorAll('img')).filter(function(img) {
    var r = img.getBoundingClientRect();
    return img.offsetParent !== null && r.width > 30 && r.height > 30;
  });
  imgs.sort(function(a, b) {
    var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return (rb.width * rb.height) - (ra.width * ra.height);
  });
  if (imgs.length) {
    var r0 = imgs[0].getBoundingClientRect();
    var x0 = r0.left + r0.width/2, y0 = r0.top + r0.height/2;
    var top0 = document.elementFromPoint(x0, y0) || imgs[0];
    tap(top0);
    return 'ok:img:' + (top0.tagName||'?') + ':' + imgs[0].src.slice(-30);
  }

  // Try canvas
  var cvs = Array.from(document.querySelectorAll('canvas')).filter(function(c) {
    return c.offsetParent !== null && c.width > 30;
  });
  if (cvs.length) {
    var rc = cvs[0].getBoundingClientRect();
    var xc = rc.left + rc.width/2, yc = rc.top + rc.height/2;
    var topc = document.elementFromPoint(xc, yc) || cvs[0];
    tap(topc);
    return 'ok:canvas:' + (topc.tagName||'?');
  }

  // Fallback: tap center of screen via elementFromPoint
  var x = window.innerWidth / 2, y = window.innerHeight * 0.4;
  var el = document.elementFromPoint(x, y);
  if (el && el !== document.body && el !== document.documentElement) {
    tap(el);
    return 'ok:center:' + (el.tagName || '?');
  }

  return 'not-found';
})()
    `);
    if (result && result.startsWith('ok:')) return result;
    await sleep(600);
  }
  return 'timeout';
}

// Jump ahead through card reveals until Done appears
async function skipToSummary() {
  const deadline = Date.now() + 60000;
  let iter = 0;
  while (Date.now() < deadline) {
    // Broad "Done" check — any visible element with text "Done"
    const hasDone = await safariEval(`
(function() {
  return Array.from(document.querySelectorAll('*')).some(function(e) {
    return e.offsetParent !== null && e.textContent.trim() === 'Done';
  }) ? 'yes' : 'no';
})()
`);
    if (hasDone === 'yes') return true;

    // On first 3 iterations, log what buttons/texts are visible to help debug
    if (iter < 3) {
      const snapshot = await safariEval(`
(function() {
  var interesting = Array.from(document.querySelectorAll('button, [role="button"], span, div')).filter(function(e) {
    var t = e.textContent.trim();
    return e.offsetParent !== null && t.length > 0 && t.length < 40 && e.childElementCount === 0;
  });
  return interesting.slice(0,8).map(function(e){ return '"' + e.textContent.trim() + '"[' + e.tagName + ']'; }).join(', ') || 'nothing';
})()
`);
      console.log(`    [11] iter${iter} visible: ${snapshot}`);
    }

    // Try skip/advance buttons, then tap at multiple points on screen
    await safariEval(`
(function() {
  ${TAP_FN}
  var els = Array.from(document.querySelectorAll('button, a, [role="button"], span, div'));
  var skipTexts = ['Jump ahead', 'Show next card', 'Skip', 'Next', 'Continue', 'Tap to reveal'];
  for (var i = 0; i < skipTexts.length; i++) {
    var btn = els.find(function(e) { return e.offsetParent !== null && e.textContent.trim() === skipTexts[i]; });
    if (btn) { tap(btn); return; }
  }
  // No button — tap upper-center and center to advance animation
  var pts = [[window.innerWidth/2, window.innerHeight*0.3], [window.innerWidth/2, window.innerHeight*0.5]];
  pts.forEach(function(p) {
    var el = document.elementFromPoint(p[0], p[1]);
    if (el && el !== document.body && el !== document.documentElement) tap(el);
  });
})()
`);
    await sleep(1200);
    iter++;
  }
  return false;
}

async function dismissModal() {
  await safariEval(`
(function() {
  ${TAP_FN}
  var btn = Array.from(document.querySelectorAll('button, a')).find(function(e) {
    return e.offsetParent !== null && (e.textContent.trim() === 'Cancel' || e.textContent.trim() === 'Done');
  });
  if (btn) { tap(btn); return; }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
})()
`);
  await sleep(1500);
}

// ── Core pack flow ────────────────────────────────────────────────────────────

async function openOnePack(pack) {
  // Use label's last word as display season (e.g. "2023-24" from "Luka Doncic 2023-24").
  // packs.json stores season inconsistently (NBA ending year vs NFL starting year),
  // so the label is the only reliable source for what the RS dropdown actually shows.
  const displaySeason = pack.label ? pack.label.split(' ').pop() : pack.season;

  // 1. Open in a fresh tab (avoids stale DOM from previous player page)
  console.log(`    [1] Opening ${pack.playerUrl} in new tab...`);
  await safariOpenTab(pack.playerUrl);
  await sleep(2000);

  // Wait for the player page to fully load — any season year visible means the nav rendered
  console.log(`    [1] Waiting for page load...`);
  const pageLoaded = await (async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const r = await safariEval(`
(function() {
  return Array.from(document.querySelectorAll('*')).some(function(e) {
    return e.offsetParent !== null && /20\\d\\d/.test(e.textContent.trim()) && e.textContent.trim().length < 20;
  }) ? 'yes' : 'no';
})()
`);
      if (r === 'yes') return true;
      await sleep(500);
    }
    return false;
  })();
  if (!pageLoaded) throw new Error('Player page did not load');
  await sleep(500);

  // 2. Select correct season year if needed
  const yearResult = await selectSeason(displaySeason);
  console.log(`    [2] Season: ${yearResult} (target: ${displaySeason})`);
  await sleep(500);

  // 3. Click the card icon button (2nd button in top nav, next to year dropdown)
  console.log(`    [3] Clicking card icon...`);
  const cardIcon = await clickCardIconButton();
  if (!cardIcon || !cardIcon.startsWith('ok:')) {
    throw new Error(`Card icon not found: ${cardIcon}`);
  }
  console.log(`    [3] ${cardIcon}`);

  // 4. Wait for Player Card screen — "Player Card" is the page header
  await sleep(1500); // give React time to navigate
  console.log(`    [4] Waiting for Player Card screen...`);
  const cardScreen = await waitForText('Player Card', 15000);
  if (!cardScreen) throw new Error('Player Card screen did not appear');
  await sleep(600);

  // 5. Click the player card to open the pack modal
  console.log(`    [5] Clicking player card...`);
  const cardClick = await clickPlayerCard();
  console.log(`    [5] ${cardClick}`);

  // 6. Wait for card modal ("Manage card" confirms it's open)
  console.log(`    [6] Waiting for pack modal...`);
  const modal = await waitForText('Manage card', 12000);
  if (!modal) throw new Error('Pack modal did not appear');
  await sleep(500);

  // 7. Click the pack bag image in the modal → purchase screen
  console.log(`    [7] Clicking pack image...`);
  const imgClick = await clickPackImageInModal();
  if (!imgClick || imgClick === 'not-found') throw new Error('Pack image not found in modal');
  console.log(`    [7] ${imgClick}`);

  // 8. If "Activate pack" appears, click it. If not (already activated), skip to open.
  console.log(`    [8] Checking for Activate pack...`);
  const activateReady = await waitForText('Activate pack', 6000);
  if (activateReady) {
    console.log(`    [8] Activating pack...`);
    await sleep(400);
    await clickText('Activate pack', 5000);
    await waitForTextGone('Activate pack', 12000);
    await sleep(600);
  } else {
    console.log(`    [8] Pack already activated — skipping to open`);
    await sleep(500);
  }

  // 10. Click pack to open — pack is consumed on tap, no need to go through reveal
  console.log(`    [10] Clicking pack to open...`);
  const openClick = await clickPackToOpen();
  console.log(`    [10] ${openClick}`);
  if (!openClick || openClick === 'not-found') throw new Error('Could not click pack to open');

  // Pack is now opened. Close tab and move on.
  await sleep(1500);
  await safariCloseTab();
}

// ── Per-pack entry ────────────────────────────────────────────────────────────

async function processPack(pack) {
  const label = pack.label;
  console.log(`\n[${ts()}] ── ${label} ──`);

  // Check if pack is available today (read-only GET)
  let hasPackToday = true;
  try {
    const info  = await getPackInfo(pack);
    const desc  = info.info?.secondaryDescription || '';
    const match = desc.match(/(\d+) packs? remaining/i);
    const remaining = match ? parseInt(match[1]) : null;
    const cost = info.info?.cost ?? 0;
    if (remaining === 0) {
      console.log(`  No packs remaining today.`);
      return 0;
    }
    console.log(`  ${remaining ?? '?'} remaining · ${cost} Rax`);
  } catch (e) {
    console.log(`  Pack info check failed (${e.message}) — attempting anyway`);
  }

  // Open exactly 1 pack
  console.log(`\n  Opening 1 pack:`);
  try {
    await openOnePack(pack);
    console.log(`  ✓ Pack opened!`);
    return 1;
  } catch (e) {
    console.log(`  ✗ Error: ${e.message}`);
    await safariCloseTab(); // close the tab so next player starts clean
    return 0;
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const startFrom = process.env.START_FROM ? parseInt(process.env.START_FROM) : 0;
  const allReady  = packs.filter(p => p.entityId && p.playerUrl);
  const missing   = packs.filter(p => !p.entityId || !p.playerUrl);
  const ready     = startFrom > 0 ? allReady.slice(startFrom) : allReady;

  if (missing.length) {
    console.log(`\n⚠  Skipping ${missing.length} pack(s) with no entityId/URL:`);
    missing.forEach(p => console.log(`     • ${p.label}`));
  }
  if (!ready.length) { console.log('No packs ready.\n'); return; }

  console.log(`\nRS Pack Opener — ${ready.length} pack(s)`);
  console.log(`Activating Safari...`);
  await runOSA(`tell application "Safari" to activate`);
  await sleep(1000);

  let total = 0;
  for (let i = 0; i < ready.length; i++) {
    total += await processPack(ready[i]);
    if (i < ready.length - 1) await sleep(rand(1000, 2000));
  }

  console.log(`\n✓ Done — ${total} pack(s) opened.\n`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
