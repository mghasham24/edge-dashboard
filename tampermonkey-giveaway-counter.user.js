// ==UserScript==
// @name         RaxEdge Giveaway Counter
// @namespace    raxedge
// @version      1.2
// @description  Counts referral @mentions on a RS giveaway post and shows a ranked leaderboard
// @match        https://realsports.io/*
// @match        https://www.realsports.io/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      raxedge.com
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';

  const GROUP_ID   = '60106'; // main 1.5k group
  const RAXEDGE    = 'https://raxedge.com';
  const TM_KEY     = 'rax-bridge-9w2k5j7n';
  const LIMIT      = 100;

  // ── Read RS token from localStorage ──────────────────────────────────────────
  function getRsToken() {
    try {
      const accounts = JSON.parse(localStorage.getItem('e-accounts') || '[]');
      const info = (accounts[0] || {}).authInfo || {};
      if (info.userId && info.deviceId && info.token)
        return info.userId + '!' + info.deviceId + '!' + info.token;
    } catch(e) {}
    return null;
  }

  // ── Fetch all replies via RaxEdge CF proxy (avoids TM/CORS/RS auth issues) ────
  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method:  'GET',
        url:     url,
        onload:  (r) => resolve({ status: r.status, text: r.responseText }),
        onerror: ()  => reject(new Error('Network error')),
      });
    });
  }

  async function fetchAllComments(postId) {
    const rsToken = getRsToken();
    const comments = [];
    let cursor = null;
    let page   = 0;

    while (true) {
      page++;
      const params = new URLSearchParams({ postId, groupId: GROUP_ID, limit: LIMIT, _tm_key: TM_KEY });
      if (rsToken) params.set('rsToken', rsToken);
      if (cursor) params.set('cursor', cursor);
      const url = `${RAXEDGE}/api/real/comments?${params}`;

      const res = await gmGet(url);
      if (res.status !== 200) {
        throw new Error(`Comments fetch failed: ${res.status} (page ${page}) — ${res.text}`);
      }

      const data = JSON.parse(res.text);
      if (!data.ok) throw new Error(data.error || 'Unknown error from proxy');
      const batch = data.comments || [];
      if (!batch.length) break;

      comments.push(...batch);
      console.log(`[Giveaway] Page ${page}: ${batch.length} replies (total: ${comments.length})`);

      cursor = data.cursor || null;
      if (!cursor || batch.length < LIMIT) break;
    }

    return comments;
  }

  // ── Count leaderboard ─────────────────────────────────────────────────────────
  function buildLeaderboard(comments) {
    const seenCommenters = new Set();
    const tally = {};

    const sorted = [...comments].sort((a, b) =>
      new Date(a.createdAt) - new Date(b.createdAt)
    );

    for (const c of sorted) {
      const commenter = c.user?.userName || c.userId;
      if (!commenter || seenCommenters.has(commenter)) continue;
      seenCommenters.add(commenter);

      let referrer = c.replyingToUserName || null;
      if (!referrer && c.plainText) {
        const m = c.plainText.match(/@([\w.]+)/);
        if (m) referrer = m[1];
      }
      if (!referrer) continue;

      tally[referrer] = (tally[referrer] || 0) + 1;
    }

    return Object.entries(tally)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count], i) => ({ rank: i + 1, name, count }));
  }

  // ── UI ────────────────────────────────────────────────────────────────────────
  GM_addStyle(`
    #rax-gc-btn {
      position: fixed; bottom: 80px; right: 16px; z-index: 99999;
      background: #7c5ef5; color: #fff; border: none; border-radius: 8px;
      padding: 10px 14px; font-size: 13px; font-weight: 700; cursor: pointer;
      box-shadow: 0 2px 12px rgba(0,0,0,0.4); letter-spacing: .04em;
    }
    #rax-gc-btn:hover { background: #6a4de0; }
    #rax-gc-modal {
      position: fixed; inset: 0; z-index: 100000;
      background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center;
    }
    #rax-gc-box {
      background: #1a1a2e; border: 1px solid #333; border-radius: 12px;
      width: 420px; max-width: 95vw; max-height: 80vh;
      display: flex; flex-direction: column; overflow: hidden;
      box-shadow: 0 8px 40px rgba(0,0,0,0.6);
    }
    #rax-gc-header {
      padding: 16px 20px; border-bottom: 1px solid #333;
      display: flex; align-items: center; justify-content: space-between;
      font-size: 15px; font-weight: 800; color: #fff; letter-spacing: .04em;
    }
    #rax-gc-close { cursor: pointer; color: #888; font-size: 18px; line-height: 1; }
    #rax-gc-close:hover { color: #fff; }
    #rax-gc-body { overflow-y: auto; padding: 12px 20px 20px; }
    #rax-gc-status { color: #aaa; font-size: 13px; padding: 20px 0; text-align: center; }
    .rax-gc-row {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 0; border-bottom: 1px solid #222; font-size: 13px; color: #eee;
    }
    .rax-gc-row:last-child { border-bottom: none; }
    .rax-gc-rank { width: 24px; text-align: center; font-weight: 800; color: #7c5ef5; flex-shrink: 0; }
    .rax-gc-name { flex: 1; font-weight: 600; }
    .rax-gc-count { font-family: monospace; color: #7c5ef5; font-weight: 700; }
    .rax-gc-medal-1 { color: #FFD700; }
    .rax-gc-medal-2 { color: #C0C0C0; }
    .rax-gc-medal-3 { color: #CD7F32; }
    #rax-gc-meta { font-size: 11px; color: #666; margin-top: 12px; text-align: center; }
  `);

  function showModal(content) {
    removeModal();
    const modal = document.createElement('div');
    modal.id = 'rax-gc-modal';
    modal.innerHTML = `
      <div id="rax-gc-box">
        <div id="rax-gc-header">
          🏆 Giveaway Leaderboard
          <span id="rax-gc-close">✕</span>
        </div>
        <div id="rax-gc-body">${content}</div>
      </div>
    `;
    modal.querySelector('#rax-gc-close').onclick = removeModal;
    modal.onclick = (e) => { if (e.target === modal) removeModal(); };
    document.body.appendChild(modal);
  }

  function removeModal() {
    const m = document.getElementById('rax-gc-modal');
    if (m) m.remove();
  }

  function renderLeaderboard(board, totalComments, uniqueCommenters) {
    if (!board.length) return '<div id="rax-gc-status">No tagged referrals found.</div>';
    const medals = ['🥇','🥈','🥉'];
    const rows = board.map(r => {
      const medal = medals[r.rank - 1] || '';
      const cls = r.rank <= 3 ? ` rax-gc-medal-${r.rank}` : '';
      return `<div class="rax-gc-row">
        <span class="rax-gc-rank${cls}">${medal || r.rank}</span>
        <span class="rax-gc-name">@${r.name}</span>
        <span class="rax-gc-count">${r.count} referral${r.count !== 1 ? 's' : ''}</span>
      </div>`;
    }).join('');
    return rows + `<div id="rax-gc-meta">${uniqueCommenters} unique entries · ${totalComments} total comments</div>`;
  }

  // ── Main ──────────────────────────────────────────────────────────────────────
  async function runCounter() {
    const postId = prompt('Paste the Giveaway Post ID (from the Network tab or post URL):');
    if (!postId || !postId.trim()) return;

    showModal('<div id="rax-gc-status">⏳ Fetching comments...</div>');

    try {
      const comments = await fetchAllComments(postId.trim());
      const board = buildLeaderboard(comments);
      const unique = new Set(comments.map(c => c.user?.userName || c.userId)).size;
      document.getElementById('rax-gc-body').innerHTML =
        renderLeaderboard(board, comments.length, unique);
    } catch(e) {
      document.getElementById('rax-gc-body').innerHTML =
        `<div id="rax-gc-status">❌ ${e.message}</div>`;
      console.error('[Giveaway Counter]', e);
    }
  }

  // ── Inject button after DOM is ready ─────────────────────────────────────────
  function injectButton() {
    if (document.getElementById('rax-gc-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'rax-gc-btn';
    btn.textContent = '🏆 Count Giveaway';
    btn.onclick = runCounter;
    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectButton);
  } else {
    injectButton();
  }

})();
