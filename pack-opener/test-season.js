#!/usr/bin/env node
// Quick test: open Yamamoto page and debug year selection
import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execAsync = util.promisify(exec);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runOSA(script) {
  const f = path.join(os.tmpdir(), `rax-osa-${Date.now()}.applescript`);
  fs.writeFileSync(f, script, 'utf8');
  try { const { stdout } = await execAsync(`osascript "${f}"`); return stdout.trim(); }
  catch { return null; }
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

const URL = 'https://www.realapp.com/8wtbTOF2Dy0';
const TARGET = '2025';

async function main() {
  // Open tab
  await runOSA(`
tell application "Safari"
  activate
  if (count of windows) = 0 then make new document
  tell window 1
    set newTab to make new tab
    set URL of newTab to "${URL}"
    set current tab to newTab
  end tell
end tell
`);

  console.log('Opened Yamamoto page, waiting 4s for load...');
  await sleep(4000);

  // 1. What year is currently showing? (year pill is a DIV, not a button)
  const currentYear = await safariEval(`
(function() {
  var cands = Array.from(document.querySelectorAll('*')).filter(function(e) {
    if (!e.offsetParent) return false;
    var r = e.getBoundingClientRect();
    if (r.top > window.innerHeight * 0.25) return false;
    return /20\\d\\d/.test(e.textContent.trim()) && e.textContent.trim().length < 20;
  });
  cands.sort(function(a,b) {
    var ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
    return (ra.width*ra.height)-(rb.width*rb.height);
  });
  return cands[0] ? 'found:' + cands[0].textContent.trim() + ' [' + cands[0].tagName + ']' : 'not-found';
})()
`);
  console.log('Current year pill:', currentYear);

  if (currentYear && currentYear.includes(TARGET)) {
    console.log('Already on 2025 — no switching needed.');
    return;
  }

  // 2. Tap the year pill via elementFromPoint
  console.log('Tapping year pill...');
  const dropdownTap = await safariEval(`
(function() {
  ${TAP_FN}
  var cands = Array.from(document.querySelectorAll('*')).filter(function(e) {
    if (!e.offsetParent) return false;
    var r = e.getBoundingClientRect();
    if (r.top > window.innerHeight * 0.25) return false;
    return /20\\d\\d/.test(e.textContent.trim()) && e.textContent.trim().length < 20;
  });
  cands.sort(function(a,b) {
    var ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
    return (ra.width*ra.height)-(rb.width*rb.height);
  });
  if (!cands[0]) return 'no-pill';
  var r = cands[0].getBoundingClientRect();
  var x = r.left + r.width/2, y = r.top + r.height/2;
  var el = document.elementFromPoint(x, y) || cands[0];
  tap(el);
  return 'tapped:' + el.textContent.trim().slice(0,10) + ' [' + el.tagName + '] via-efp';
})()
`);
  console.log('Dropdown tap result:', dropdownTap);
  await sleep(1500);

  // 3. What's visible on screen now?
  const visibleOptions = await safariEval(`
(function() {
  var els = Array.from(document.querySelectorAll('*')).filter(function(e) {
    return e.offsetParent !== null && /20\\d\\d/.test(e.textContent.trim()) && e.textContent.trim().length < 20;
  });
  return els.map(function(e) {
    var r = e.getBoundingClientRect();
    return e.textContent.trim() + ' [' + e.tagName + '] @' + Math.round(r.top) + ',' + Math.round(r.left);
  }).join(' | ');
})()
`);
  console.log('Visible year options after tap:', visibleOptions);

  // 4. Try to tap 2025
  const select2025 = await safariEval(`
(function() {
  ${TAP_FN}
  var els = Array.from(document.querySelectorAll('*')).filter(function(e) {
    return e.offsetParent !== null && e.textContent.trim() === '2025';
  });
  if (!els.length) return 'not-found';
  els.sort(function(a,b) { return a.textContent.length - b.textContent.length; });
  tap(els[0]);
  return 'tapped:' + els[0].tagName + ':' + (els[0].className||'').slice(0,30);
})()
`);
  console.log('Select 2025 result:', select2025);
  await sleep(1500);

  // 5. What year shows now?
  const newYear = await safariEval(`
(function() {
  var cands = Array.from(document.querySelectorAll('*')).filter(function(e) {
    if (!e.offsetParent) return false;
    var r = e.getBoundingClientRect();
    if (r.top > window.innerHeight * 0.25) return false;
    return /20\\d\\d/.test(e.textContent.trim()) && e.textContent.trim().length < 20;
  });
  cands.sort(function(a,b) {
    var ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
    return (ra.width*ra.height)-(rb.width*rb.height);
  });
  return cands[0] ? cands[0].textContent.trim() : 'not-found';
})()
`);
  console.log('Year after selection:', newYear);
  console.log(newYear && newYear.includes('2025') ? '✓ Season switch WORKED' : '✗ Season switch FAILED — still showing ' + newYear);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
