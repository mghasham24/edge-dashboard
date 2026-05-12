// ==UserScript==
// @name         RS Auction Alert
// @namespace    raxedge
// @version      6.0
// @description  Alerts via Telegram when target FC player cards are listed below threshold; pushes live token to VPS scanner
// @match        https://realsports.io/*
// @match        https://www.realsports.io/*
// @grant        GM_xmlhttpRequest
// @connect      api.telegram.org
// @connect      178.156.194.254
// @run-at       document-start
// ==/UserScript==

var VPS_URL    = 'http://178.156.194.254:3001/token';
var VPS_SECRET = 'raxedge-vps-2026';

// ─── TM context: drain Telegram queue + push token to VPS ────────────────────

setInterval(function() {
  try {
    var root = document.documentElement;
    if (!root) return;

    // Drain Telegram queue
    var rawTg = root.getAttribute('data-raxedge-tg');
    if (rawTg) {
      root.removeAttribute('data-raxedge-tg');
      var msgs = JSON.parse(rawTg);
      if (msgs && msgs.length) {
        msgs.forEach(function(m) {
          GM_xmlhttpRequest({
            method:  'POST',
            url:     'https://api.telegram.org/bot' + m.botToken + '/sendMessage',
            headers: { 'Content-Type': 'application/json' },
            data:    JSON.stringify({ chat_id: m.chatId, text: m.text, parse_mode: 'HTML' }),
            onerror:   function() {},
            ontimeout: function() {},
          });
        });
      }
    }

    // Push token to VPS
    var rawToken = root.getAttribute('data-raxedge-token');
    if (rawToken) {
      root.removeAttribute('data-raxedge-token');
      var td = JSON.parse(rawToken);
      if (td && td.authInfo && td.deviceUuid) {
        GM_xmlhttpRequest({
          method:  'POST',
          url:     VPS_URL,
          headers: { 'Content-Type': 'application/json' },
          data:    JSON.stringify({ authInfo: td.authInfo, deviceUuid: td.deviceUuid, secret: VPS_SECRET }),
          onerror:   function() {},
          ontimeout: function() {},
        });
      }
    }
  } catch(e) {}
}, 3000);

// ─── Page-world injection: fetch interception + listing checks ────────────────
const s = document.createElement('script');
s.textContent = `
(function() {
  var TG_TOKEN  = '8258151239:AAEAgFjbcYdpHU8Jyd6kR6xoj5uSiOvZDeY';
  var TG_CHAT   = '5439959074';
  var MAX_PRICE = 100;
  var TARGETS   = ['dimarco', 'mckennie', 'locatelli', 'grimaldo'];
  var SEEN_KEY  = 'rs_auction_alert_seen';

  var _lastAuthInfo   = null;
  var _lastDeviceUuid = null;

  function queueTelegram(text) {
    try {
      var root = document.documentElement;
      var q = JSON.parse(root.getAttribute('data-raxedge-tg') || '[]');
      q.push({ botToken: TG_TOKEN, chatId: TG_CHAT, text: text });
      root.setAttribute('data-raxedge-tg', JSON.stringify(q));
    } catch(e) {}
  }

  function queueTokenPush(authInfo, deviceUuid) {
    try {
      document.documentElement.setAttribute('data-raxedge-token', JSON.stringify({ authInfo: authInfo, deviceUuid: deviceUuid }));
    } catch(e) {}
  }

  function loadSeen() {
    try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); }
    catch(e) { return new Set(); }
  }
  function saveSeen(set) {
    localStorage.setItem(SEEN_KEY, JSON.stringify(Array.from(set).slice(-500)));
  }

  function getPlayerName(listing) {
    var p = listing.card && listing.card.primaryPlayer;
    if (p && p.firstName && p.lastName) return p.firstName + ' ' + p.lastName;
    if (p && p.displayName) return p.displayName;
    return '';
  }

  function matchesTarget(listing) {
    var name = getPlayerName(listing).toLowerCase();
    return name && TARGETS.some(function(t) { return name.indexOf(t) !== -1; });
  }

  function listingPrice(listing) {
    var current = listing.currentBidAmount != null ? listing.currentBidAmount : null;
    var minBid  = listing.minBidPrice      != null ? listing.minBidPrice      : null;
    var buyNow  = listing.buyNowPrice      != null ? listing.buyNowPrice      : null;
    if (current != null && current > 0) return current;
    if (minBid  != null && minBid  > 0) return minBid;
    if (buyNow  != null && buyNow  > 0) return buyNow;
    return null;
  }

  function checkListings(listings) {
    if (!listings.length) return;
    var seen    = loadSeen();
    var newSeen = new Set(seen);
    var found   = 0;
    for (var i = 0; i < listings.length; i++) {
      var listing = listings[i];
      var id = String(listing.id != null ? listing.id : (listing.listingId != null ? listing.listingId : ''));
      if (!id) continue;
      newSeen.add(id);
      if (seen.has(id)) continue;
      if (!matchesTarget(listing)) continue;
      var price = listingPrice(listing);
      if (price == null || price >= MAX_PRICE) continue;
      var name    = getPlayerName(listing) || 'Unknown';
      var rarity  = (listing.card && listing.card.rarityLabel) || '';
      var endsAt  = listing.endsAt || '';
      var endsStr = endsAt ? ' | Ends: ' + new Date(endsAt).toLocaleTimeString() : '';
      var buyNow  = listing.buyNowPrice != null ? listing.buyNowPrice : null;
      var buyStr  = buyNow ? ' | Buy Now: ' + buyNow + ' Rax' : '';
      var msg = '🔔 <b>Auction Alert</b>\\n' + name + (rarity ? ' (' + rarity + ')' : '') +
                '\\nPrice: <b>' + price + ' Rax</b>' + buyStr + endsStr;
      console.log('auction-alert: alert for', name, price);
      queueTelegram(msg);
      found++;
    }
    saveSeen(newSeen);
    if (found) console.log('auction-alert: sent', found, 'alert(s)');
  }

  var _origFetch = window.fetch;
  window.fetch = function(input, init) {
    // Capture RS auth headers from any realapp.com request
    try {
      var url = (typeof input === 'string' ? input : (input && input.url)) || '';
      if (url.indexOf('realapp.com') !== -1 && init && init.headers) {
        var h = init.headers;
        var ai = h['real-auth-info'] || h['Real-Auth-Info'];
        var du = h['real-device-uuid'] || h['Real-Device-Uuid'];
        if (ai && du && (ai !== _lastAuthInfo || du !== _lastDeviceUuid)) {
          _lastAuthInfo   = ai;
          _lastDeviceUuid = du;
          queueTokenPush(ai, du);
          console.log('auction-alert: captured token, prefix:', ai.split('!')[0]);
        }
      }
    } catch(e) {}

    return _origFetch.apply(this, arguments).then(function(res) {
      try {
        var url = (typeof input === 'string' ? input : (input && input.url)) || '';
        if (url.indexOf('cardmarketplacelistings') !== -1 &&
            url.indexOf('/bid') === -1 && url.indexOf('/info') === -1 &&
            url.indexOf('/bidinfo') === -1 && url.indexOf('/bidhistory') === -1) {
          res.clone().json().then(function(data) {
            var listings = data.listings || data.items || data.data || [];
            if (listings.length) {
              console.log('auction-alert: intercepted', listings.length, 'listing(s)');
              checkListings(listings);
            }
          }).catch(function() {});
        }
      } catch(e) {}
      return res;
    });
  };

  console.log('auction-alert: active v6, targets:', TARGETS.join(', '));
})();
`;
document.documentElement.appendChild(s);
s.remove();
