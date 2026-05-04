// ==UserScript==
// @name         RaxEdge RS Auto-Poster
// @namespace    https://raxedge.com
// @version      1.3
// @description  Posts new RS open positions to the RS group every minute, directly from your browser session
// @match        https://www.realapp.com/*
// @match        https://realsports.io/*
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      web.realapp.com
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';

  const GROUP_ID         = 61979;
  const RS_API_BASE      = 'https://web.realapp.com';
  const RS_WEB_BASE      = 'https://realsports.io';
  const POSTED_KEY       = 'rs_auto_posted_ids';
  const POLL_INTERVAL_MS = 60 * 1000;

  function getAuth() {
    try {
      const accounts = JSON.parse(localStorage.getItem('e-accounts') || '[]');
      const info = accounts[0]?.authInfo;
      if (!info?.userId || !info?.token) return null;
      const authHeader = `${info.userId}!${info.deviceId || ''}!${info.token}`;
      const deviceUuid = localStorage.getItem('realdeviceuuid') || '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';
      return { authHeader, deviceUuid };
    } catch {
      return null;
    }
  }

  function getPostedIds() {
    try { return new Set(JSON.parse(GM_getValue(POSTED_KEY, '[]'))); } catch { return new Set(); }
  }

  function savePostedId(id) {
    const ids = getPostedIds();
    ids.add(id);
    GM_setValue(POSTED_KEY, JSON.stringify([...ids].slice(-1000)));
  }

  function rsHeaders(authHeader, deviceUuid) {
    return {
      'Content-Type':       'application/json',
      'Accept':             'application/json',
      'Accept-Language':    'en-US,en;q=0.9',
      'real-device-uuid':   deviceUuid,
      'real-device-name':   '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
      'real-device-type':   'desktop_web',
      'real-version':       '31',
      'real-request-token': Math.random().toString(36).slice(2, 18),
      'real-auth-info':     authHeader,
    };
  }

  function formatPost(pos) {
    const game    = pos.marketDisplay?.display || '';
    const label   = pos.headerLabel  || '';
    const outcome = pos.outcomeLabel || '';
    const details = (pos.details || []).reduce((acc, d) => { acc[d.label] = d.display; return acc; }, {});
    const avg  = details['Avg']  || '—';
    const cost = details['Cost'] || '—';
    const pays = details['Pays'] || '—';
    return `New Pick: ${game}\n${label} — ${outcome}\nAvg: ${avg} | Cost: ${cost} | Pays: ${pays}`;
  }

  // Use the page's own fetch (via unsafeWindow) so requests are indistinguishable
  // from the React app's own calls — same TLS fingerprint, same origin headers.
  const pageFetch = unsafeWindow.fetch.bind(unsafeWindow);

  async function poll() {
    console.log('[RS Auto-Poster] polling…');
    const auth = getAuth();
    if (!auth) {
      console.warn('[RS Auto-Poster] no auth in localStorage — are you logged in?');
      return;
    }
    const { authHeader, deviceUuid } = auth;

    let posRes;
    try {
      posRes = await pageFetch(RS_API_BASE + '/predictions/openpositions', {
        headers: rsHeaders(authHeader, deviceUuid),
      });
    } catch (e) {
      console.error('[RS Auto-Poster] openpositions error:', e.message);
      return;
    }

    if (!posRes.ok) {
      console.warn('[RS Auto-Poster] openpositions', posRes.status, (await posRes.text()).slice(0, 300));
      return;
    }

    const positions    = (await posRes.json()).positions || [];
    const postedIds    = getPostedIds();
    const newPositions = positions.filter(p => p.sharedPositionId && !postedIds.has(p.sharedPositionId));

    if (!newPositions.length) { console.log('[RS Auto-Poster] no new positions'); return; }

    console.log('[RS Auto-Poster] found', newPositions.length, 'new position(s)');

    for (let i = 0; i < newPositions.length; i++) {
      const pos   = newPositions[i];
      const posId = pos.sharedPositionId;
      try {
        const detailRes = await pageFetch(RS_API_BASE + '/predictions/position/' + posId, {
          headers: rsHeaders(authHeader, deviceUuid),
        });
        const detail   = detailRes.ok ? await detailRes.json() : {};
        const path     = detail.position?.marketDisplay?.path;
        const shareUrl = path ? RS_WEB_BASE + path : '';
        const text     = formatPost(pos) + (shareUrl ? '\n\n' + shareUrl : '');

        const groupRes = await pageFetch(RS_API_BASE + '/comments/groups/' + GROUP_ID, {
          method:  'POST',
          headers: rsHeaders(authHeader, deviceUuid),
          body:    JSON.stringify({ groupId: GROUP_ID, text, parentCommentId: null }),
        });

        if (groupRes.ok) {
          console.log('[RS Auto-Poster] posted', posId);
          savePostedId(posId);
        } else {
          console.error('[RS Auto-Poster] group post failed', posId, groupRes.status, (await groupRes.text()).slice(0, 300));
        }

        if (i < newPositions.length - 1) await new Promise(r => setTimeout(r, 1000));
      } catch (e) {
        console.error('[RS Auto-Poster] error for', posId, e.message);
      }
    }
  }

  poll();
  setInterval(poll, POLL_INTERVAL_MS);

})();
