// ==UserScript==
// @name         RS Auto-Poster
// @namespace    raxedge
// @version      2.0
// @description  Polls RS open positions every 60s and posts new ones to the group
// @match        https://realsports.io/*
// @match        https://www.realsports.io/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
  'use strict';

  const RS_GROUP_ID  = '61979';
  const RS_BASE      = 'https://web.realapp.com';
  const RS_WEB_BASE  = 'https://realsports.io';
  const POSTED_KEY   = 'rs_poster_posted_ids';
  const POLL_MS      = 60000;

  let _running = false;

  function getAuth() {
    try {
      const accounts = JSON.parse(localStorage.getItem('e-accounts') || '[]');
      const info = (accounts[0] || {}).authInfo || {};
      if (info.userId && info.deviceId && info.token) {
        return info.userId + '!' + info.deviceId + '!' + info.token;
      }
    } catch(e) {}
    return null;
  }

  function getDeviceUUID() {
    return '6d6af134-cb55-476e-b13e-16f37bc96838';
  }

  function makeHeaders(auth) {
    return {
      'Accept':             'application/json',
      'Content-Type':       'application/json',
      'Origin':             RS_WEB_BASE,
      'Referer':            RS_WEB_BASE + '/',
      'real-auth-info':     auth,
      'real-device-uuid':   getDeviceUUID(),
      'real-device-name':   navigator.userAgent,
      'real-device-type':   'desktop_web',
      'real-version':       '31',
      'real-request-token': Math.random().toString(36).slice(2, 18),
    };
  }

  function getPostedIds() {
    try { return new Set(JSON.parse(localStorage.getItem(POSTED_KEY) || '[]')); }
    catch(e) { return new Set(); }
  }

  function savePostedId(id) {
    const ids = getPostedIds();
    ids.add(id);
    localStorage.setItem(POSTED_KEY, JSON.stringify(Array.from(ids).slice(-500)));
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

  async function run() {
    if (_running) return;
    const auth = getAuth();
    if (!auth) { console.log('[RS Poster] No auth'); return; }
    _running = true;

    try {
      const posRes = await fetch(RS_BASE + '/predictions/openpositions', { headers: makeHeaders(auth) });
      if (!posRes.ok) {
        console.error('[RS Poster] openpositions', posRes.status, await posRes.text());
        return;
      }

      const positions    = (await posRes.json()).positions || [];
      const postedIds    = getPostedIds();
      const newPositions = positions.filter(p => p.sharedPositionId && !postedIds.has(p.sharedPositionId));

      if (!positions.length)    { console.log('[RS Poster] No open positions'); return; }
      if (!newPositions.length) { console.log('[RS Poster] No new positions');  return; }

      console.log('[RS Poster] Found', newPositions.length, 'new position(s)');

      for (let i = 0; i < newPositions.length; i++) {
        const pos   = newPositions[i];
        const posId = pos.sharedPositionId;
        try {
          const detailRes = await fetch(RS_BASE + '/predictions/position/' + posId, { headers: makeHeaders(auth) });
          const detail    = detailRes.ok ? await detailRes.json() : {};
          const path      = detail.position?.marketDisplay?.path;
          const shareUrl  = path ? RS_WEB_BASE + path : '';
          const text      = formatPost(pos) + (shareUrl ? '\n\n' + shareUrl : '');

          const groupRes = await fetch(RS_BASE + '/groups/' + RS_GROUP_ID + '/posts', {
            method:  'POST',
            headers: makeHeaders(auth),
            body:    JSON.stringify({ content: { nodes: [{ type: 'Paragraph', children: [{ text, type: 'Text' }] }] } }),
          });

          if (groupRes.ok) {
            console.log('[RS Poster] Posted', posId);
            savePostedId(posId);
          } else {
            console.error('[RS Poster] Post failed', posId, groupRes.status, await groupRes.text());
          }

          if (i < newPositions.length - 1) await new Promise(r => setTimeout(r, 1500));
        } catch(e) {
          console.error('[RS Poster] Error for', posId, e.message);
        }
      }
    } catch(e) {
      console.error('[RS Poster] Run error', e.message);
    } finally {
      _running = false;
    }
  }

  function start() {
    const auth = getAuth();
    if (!auth) { setTimeout(start, 3000); return; }
    console.log('[RS Poster] Started as', auth.split('!')[0]);
    run();
    setInterval(run, POLL_MS);
  }

  setTimeout(start, 3000);
})();
