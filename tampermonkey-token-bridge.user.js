// ==UserScript==
// @name         RS Token Bridge
// @namespace    raxedge
// @version      1.1
// @description  Pushes fresh RS auth token to rs-poster-node and RaxEdge site every 30s
// @match        https://realsports.io/*
// @match        https://www.realapp.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      raxedge.com
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';

  var SITE_PUSH_URL = 'https://raxedge.com/api/admin/rs-token?key=rax-bridge-9w2k5j7n';

  function getTokenInfo() {
    try {
      var accounts = JSON.parse(localStorage.getItem('e-accounts') || '[]');
      var info = (accounts[0] || {}).authInfo || {};
      if (info.userId && info.deviceId && info.token) {
        return {
          token: info.userId + '!' + info.deviceId + '!' + info.token,
          deviceUuid: info.deviceId,
        };
      }
    } catch(e) {}
    return null;
  }

  function pushToken() {
    var info = getTokenInfo();
    if (!info) return;

    // Push to local rs-poster-node
    GM_xmlhttpRequest({
      method: 'POST',
      url: 'http://127.0.0.1:27182/token',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ token: info.token }),
      onerror: function() {},
      ontimeout: function() {},
    });

    // Push to RaxEdge site so RS sync stays fresh
    GM_xmlhttpRequest({
      method: 'POST',
      url: SITE_PUSH_URL,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ token: info.token, deviceUuid: info.deviceUuid }),
      onerror: function() {},
      ontimeout: function() {},
    });
  }

  // Push immediately, then every 30 seconds
  pushToken();
  setInterval(pushToken, 30000);
})();
