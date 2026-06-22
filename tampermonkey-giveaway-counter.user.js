// ==UserScript==
// @name         RaxEdge Giveaway Counter
// @namespace    raxedge
// @version      5.0
// @description  Auto-scrolls RS giveaway post and builds referral leaderboard
// @match        https://realsports.io/*
// @match        https://www.realsports.io/*
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';

  const entries  = {}; // commenterKey → referrer (first reply only)
  const tally    = {}; // referrer → count
  let   autoScrolling = false;

  const SKIP_MENTIONS = new Set(['moe_']);

  // ── Scan visible comment containers ──────────────────────────────────────────
  function scanComments() {
    const containers = document.querySelectorAll('div.r-1udh08x');
    let newCount = 0;

    containers.forEach(c => {
      if (c.dataset.rcDone) return;

      // @mention — try RS mention span first, then plain-text regex fallback
      let referrer = null;
      for (const span of c.querySelectorAll('span.r-1loqt21')) {
        const name = span.textContent.replace('@', '').trim();
        if (name && !SKIP_MENTIONS.has(name.toLowerCase())) { referrer = name; break; }
      }
      if (!referrer) {
        // Fallback: plain text @mention typed without using RS mention selector
        const textEl = c.querySelector('div[dir="auto"]');
        const text = textEl?.textContent || '';
        const matches = [...text.matchAll(/@([\w.]+)/g)];
        for (const m of matches) {
          if (!SKIP_MENTIONS.has(m[1].toLowerCase())) { referrer = m[1]; break; }
        }
      }
      if (!referrer) return;

      // Commenter key for deduplication
      let key = null;
      for (const a of c.querySelectorAll('a[href]')) {
        const h = a.getAttribute('href') || '';
        if (h && !h.startsWith('#') && !h.includes('groups') && !h.includes('game') && !h.includes('market')) {
          key = h; break;
        }
      }
      if (!key) key = c.querySelector('div.r-iphfwy div[dir="auto"]')?.textContent?.trim() || null;
      if (!key) key = getPath(c);

      if (entries[key] !== undefined) { c.dataset.rcDone = '1'; return; }

      entries[key] = referrer;
      tally[referrer] = (tally[referrer] || 0) + 1;
      c.dataset.rcDone = '1';
      newCount++;
    });

    if (newCount > 0) {
      const total = Object.keys(entries).length;
      console.log(`[RC] +${newCount} (total: ${total}) | leader: @${getLeader()}`);
      updateBtn(total);
    }
  }

  // ── Auto-scroll ───────────────────────────────────────────────────────────────
  async function autoScroll() {
    if (autoScrolling) return;
    autoScrolling = true;
    updateBtn('…');

    let lastCount = -1;
    let stallCount = 0;

    while (autoScrolling) {
      // Scroll window + every scrollable div (v4.3 approach — confirmed working)
      window.scrollBy(0, 400);
      document.querySelectorAll('div').forEach(el => {
        if (el.scrollHeight > el.clientHeight + 10) {
          const st = window.getComputedStyle(el);
          if (/auto|scroll/.test(st.overflow + st.overflowY)) {
            el.scrollBy(0, 400);
          }
        }
      });

      await sleep(1000);
      scanComments();

      const count = Object.keys(entries).length;
      updateBtn(count);

      // No auto-stop — keep scrolling until user clicks Stop
      // (RS has 1000+ entries; stall detection was cutting off too early)
    }

    autoScrolling = false;
    scanComments();
    const total = Object.keys(entries).length;
    updateBtn(total);
    console.log(`[RC] Stopped. ${total} entries.`);
  }

  function stopAutoScroll() { autoScrolling = false; }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function getPath(el) {
    const parts = []; let n = el;
    while (n && n !== document.body) { parts.unshift(Array.from(n.parentElement?.children||[]).indexOf(n)); n = n.parentElement; }
    return parts.join('-');
  }
  function getLeader() { const t = Object.entries(tally).sort((a,b)=>b[1]-a[1])[0]; return t?`${t[0]}(${t[1]})`:'—'; }
  function updateBtn(val) {
    const b = document.getElementById('rax-gc-btn');
    if (b) b.textContent = `🏆 Count (${val})`;
    const s = document.getElementById('rax-gc-scroll-btn');
    if (!s) return;
    if (autoScrolling) { s.textContent = '⏹ Stop'; s.style.background = '#e05555'; }
    else               { s.textContent = '▶ Auto-Scroll'; s.style.background = '#2ecc71'; }
  }

  // No auto-scan on load or navigation — user presses Scan when on replies

  // ── UI ────────────────────────────────────────────────────────────────────────
  GM_addStyle(`
    #rax-gc-btn, #rax-gc-scroll-btn {
      position: fixed; right: 16px; z-index: 99999;
      color: #fff; border: none; border-radius: 8px;
      padding: 10px 16px; font-size: 13px; font-weight: 700; cursor: pointer;
      box-shadow: 0 2px 12px rgba(0,0,0,0.4); transition: background .2s;
    }
    #rax-gc-btn        { bottom: 80px;  background: #7c5ef5; }
    #rax-gc-scroll-btn { bottom: 128px; background: #2ecc71; }
    #rax-gc-scan-btn   { bottom: 176px; background: #2980b9; }
    #rax-gc-modal {
      position: fixed; inset: 0; z-index: 100000;
      background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center;
    }
    #rax-gc-box {
      background: #1a1a2e; border: 1px solid #333; border-radius: 12px;
      width: 440px; max-width: 95vw; max-height: 80vh;
      display: flex; flex-direction: column; overflow: hidden;
      box-shadow: 0 8px 40px rgba(0,0,0,0.6);
    }
    #rax-gc-header {
      padding: 16px 20px; border-bottom: 1px solid #333;
      display: flex; align-items: center; justify-content: space-between;
      font-size: 15px; font-weight: 800; color: #fff;
    }
    #rax-gc-close { cursor: pointer; color: #888; font-size: 18px; }
    #rax-gc-close:hover { color: #fff; }
    #rax-gc-body { overflow-y: auto; padding: 12px 20px 20px; }
    .rax-gc-row {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 0; border-bottom: 1px solid #222; font-size: 13px; color: #eee;
    }
    .rax-gc-row:last-child { border-bottom: none; }
    .rax-gc-rank { width: 28px; text-align: center; font-weight: 800; flex-shrink: 0; }
    .rax-gc-name { flex: 1; font-weight: 600; }
    .rax-gc-count { font-family: monospace; color: #7c5ef5; font-weight: 700; }
    .rax-gc-m1 { color: #FFD700; } .rax-gc-m2 { color: #C0C0C0; } .rax-gc-m3 { color: #CD7F32; }
    #rax-gc-meta { font-size: 11px; color: #666; margin-top: 12px; text-align: center; }
    #rax-gc-debug { font-size: 10px; color: #444; margin-top: 8px; text-align: center; word-break: break-all; }
  `);

  function showLeaderboard() {
    const board = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    const total = Object.keys(entries).length;

    if (!total) {
      const c = document.querySelector('div.r-1udh08x');
      const dbg = c
        ? `r-1loqt21 spans found: ${c.querySelectorAll('span.r-1loqt21').length} | text: "${c.textContent?.slice(0,80)}"`
        : 'No div.r-1udh08x found — navigate to the giveaway post first';
      showModal(`<div style="color:#f88;padding:16px 0;text-align:center">
          No entries captured yet.<br><br>
          Navigate to the giveaway post then click the button to auto-scroll.
        </div><div id="rax-gc-debug">${dbg}</div>`);
      return;
    }

    const medals = ['🥇','🥈','🥉'], mCls = ['rax-gc-m1','rax-gc-m2','rax-gc-m3'];
    const rows = board.map(([name, count], i) => `
      <div class="rax-gc-row">
        <span class="rax-gc-rank ${mCls[i]||''}">${medals[i]||`#${i+1}`}</span>
        <span class="rax-gc-name">@${name}</span>
        <span class="rax-gc-count">${count} referral${count!==1?'s':''}</span>
      </div>`).join('');
    showModal(rows + `<div id="rax-gc-meta">${total} unique entries captured</div>`);
  }

  function showModal(content) {
    removeModal();
    const m = document.createElement('div');
    m.id = 'rax-gc-modal';
    m.innerHTML = `<div id="rax-gc-box">
      <div id="rax-gc-header">🏆 Giveaway Leaderboard<span id="rax-gc-close">✕</span></div>
      <div id="rax-gc-body">${content}</div>
    </div>`;
    m.querySelector('#rax-gc-close').onclick = removeModal;
    m.onclick = e => { if (e.target === m) removeModal(); };
    document.body.appendChild(m);
  }

  function removeModal() { document.getElementById('rax-gc-modal')?.remove(); }

  function injectButton() {
    if (document.getElementById('rax-gc-btn')) return;

    const countBtn = document.createElement('button');
    countBtn.id = 'rax-gc-btn';
    countBtn.textContent = '🏆 Count Giveaway';
    countBtn.onclick = showLeaderboard;
    document.body.appendChild(countBtn);

    const scanBtn = document.createElement('button');
    scanBtn.id = 'rax-gc-scan-btn';
    scanBtn.textContent = '📡 Scan';
    scanBtn.onclick = () => { scanComments(); const t = Object.keys(entries).length; updateBtn(t); };
    document.body.appendChild(scanBtn);

    const scrollBtn = document.createElement('button');
    scrollBtn.id = 'rax-gc-scroll-btn';
    scrollBtn.textContent = '▶ Auto-Scroll';
    scrollBtn.onclick = () => { autoScrolling ? stopAutoScroll() : autoScroll(); };
    document.body.appendChild(scrollBtn);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectButton);
  else injectButton();

})();
