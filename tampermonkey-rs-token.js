// ==UserScript==
// @name         RaxEdge RS Token Sync
// @namespace    https://raxedge.com
// @version      1.0
// @description  Silently pushes your RealSports auth token to RaxEdge whenever you use RS
// @match        https://realsports.io/*
// @match        https://www.realapp.com/*
// @grant        GM_xmlhttpRequest
// @connect      raxedge.com
// @run-at       document-start
// ==/UserScript==

(function() {
  'use strict';

  const RAXEDGE_URL = 'https://raxedge.com/api/admin/rs-token?key=REPLACE_WITH_RS_TOKEN_SECRET';
  let lastPushed = 0;

  function pushToken(token, deviceUuid) {
    const now = Date.now();
    if (now - lastPushed < 5 * 60 * 1000) return; // at most once every 5 minutes
    lastPushed = now;

    GM_xmlhttpRequest({
      method: 'POST',
      url: RAXEDGE_URL,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ token, deviceUuid }),
      onerror: function() {},
      ontimeout: function() {},
    });
  }

  // Intercept fetch to capture real-auth-info header
  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    const authInfo = init?.headers?.['real-auth-info'] || (init?.headers instanceof Headers ? init.headers.get('real-auth-info') : null);
    const deviceUuid = init?.headers?.['real-device-uuid'] || (init?.headers instanceof Headers ? init.headers.get('real-device-uuid') : null);
    if (authInfo) pushToken(authInfo, deviceUuid);
    return origFetch.apply(this, arguments);
  };

  // Intercept XHR to capture real-auth-info header
  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function() {
    this._rsHeaders = {};
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (name.toLowerCase() === 'real-auth-info') this._rsAuthInfo = value;
    if (name.toLowerCase() === 'real-device-uuid') this._rsDeviceUuid = value;
    return origSetHeader.apply(this, arguments);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function() {
    if (this._rsAuthInfo) pushToken(this._rsAuthInfo, this._rsDeviceUuid);
    return origSend.apply(this, arguments);
  };
})();
