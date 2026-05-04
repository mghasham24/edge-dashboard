// ==UserScript==
// @name         RS Token Bridge
// @namespace    raxedge
// @version      1.0
// @description  Pushes fresh RS auth token to rs-poster-node every 30s
// @match        https://realsports.io/*
// @match        https://www.realapp.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';

  function getToken() {
    try {
      var accounts = JSON.parse(localStorage.getItem('e-accounts') || '[]');
      var info = (accounts[0] || {}).authInfo || {};
      if (info.userId && info.deviceId && info.token) {
        return info.userId + '!' + info.deviceId + '!' + info.token;
      }
    } catch(e) {}
    return null;
  }

  function pushToken() {
    var token = getToken();
    if (!token) return;
    GM_xmlhttpRequest({
      method: 'POST',
      url: 'http://127.0.0.1:27182/token',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ token: token }),
      onerror: function() {},
      ontimeout: function() {},
    });
  }

  // Push immediately, then every 30 seconds
  pushToken();
  setInterval(pushToken, 30000);
})();
