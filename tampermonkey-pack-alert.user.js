// ==UserScript==
// @name         RS Pack Alert
// @namespace    raxedge
// @version      1.0
// @description  Alerts via Telegram when target FC/UFC player cards are pulled in the RS global marketplace
// @match        https://realsports.io/*
// @match        https://www.realsports.io/*
// @grant        GM_xmlhttpRequest
// @connect      api.telegram.org
// @run-at       document-start
// ==/UserScript==

var TG_BOT_TOKEN  = '8258151239:AAFYPbSM5N0KJ8Fns40EVOWLeuoOYTaxsLw';
var TG_CHAT_ID    = '5439959074';

// ─── TM context: drain alert queue + forward to Telegram ──────────────────────

setInterval(function() {
  try {
    var root = document.documentElement;
    var raw = root.getAttribute('data-raxedge-pack');
    if (!raw) return;
    root.removeAttribute('data-raxedge-pack');
    var alerts = JSON.parse(raw);
    if (alerts && alerts.length) {
      alerts.forEach(function(a) {
        GM_xmlhttpRequest({
          method:  'POST',
          url:     'https://api.telegram.org/bot' + TG_BOT_TOKEN + '/sendMessage',
          headers: { 'Content-Type': 'application/json' },
          data:    JSON.stringify({ chat_id: TG_CHAT_ID, text: a.text, parse_mode: 'HTML' }),
          onerror:   function() {},
          ontimeout: function() {},
        });
      });
    }
  } catch(e) {}
}, 2000);

// ─── Page-world injection ──────────────────────────────────────────────────────

const s = document.createElement('script');
s.textContent = `
(function() {
  'use strict';

  var TARGETS       = ['dimarco', 'mckennie', 'locatelli', 'grimaldo', 'maia'];
  var PACK_SEEN_KEY = 'rs_pack_alert_seen_v2';
  var FRESH_MS      = 10 * 60 * 1000;  // ignore cards older than 10 min
  var POLL_MS       = 3  * 60 * 1000;  // poll every 3 min
  var GC_SOCCER_URL = 'https://web.realapp.com/globalcards/soccer/?view=new&sort=new&pageSize=50&limit=50';
  var GC_UFC_URL    = 'https://web.realapp.com/globalcards/ufc/?view=new&sort=new&pageSize=50&limit=50';

  var _capturedHeaders = null;

  // ── Seen IDs ──

  function loadSeen() {
    try { return new Set(JSON.parse(localStorage.getItem(PACK_SEEN_KEY) || '[]')); }
    catch(e) { return new Set(); }
  }
  function saveSeen(set) {
    localStorage.setItem(PACK_SEEN_KEY, JSON.stringify(Array.from(set).slice(-3000)));
  }

  // ── Queue alert to TM context ──

  function queueAlert(text) {
    try {
      var root = document.documentElement;
      var q = JSON.parse(root.getAttribute('data-raxedge-pack') || '[]');
      q.push({ text: text });
      root.setAttribute('data-raxedge-pack', JSON.stringify(q));
    } catch(e) {}
  }

  // ── Extract player name from global card object ──

  function getPackPlayerName(card) {
    if (card.label && /\\s/.test(card.label) && !/^\\d/.test(card.label)) return card.label;
    var entity = card.entity || (card.card && card.card.entity) || (card.play && card.play.entity);
    if (entity) {
      if (entity.firstName && entity.lastName) return entity.firstName + ' ' + entity.lastName;
      if (entity.displayName) return entity.displayName;
    }
    var sources = [card.primaryPlayer, card.player,
                   card.card && card.card.primaryPlayer,
                   card.play && card.play.primaryPlayer];
    for (var i = 0; i < sources.length; i++) {
      var p = sources[i];
      if (!p) continue;
      if (p.firstName && p.lastName) return p.firstName + ' ' + p.lastName;
      if (p.displayName) return p.displayName;
      if (p.name) return p.name;
    }
    return card.playerName || card.name || '';
  }

  function isFresh(card) {
    var ts = card.createdAt || card.earned || card.updatedAt ||
             (card.play && card.play.createdAt) ||
             (card.card && card.card.createdAt) || card.earnedAt;
    if (!ts) return true;
    return Date.now() - new Date(ts).getTime() < FRESH_MS;
  }

  function cardRating(obj) {
    if (!obj) return null;
    var v = obj.value != null ? obj.value : (obj.score != null ? obj.score : (obj.rating != null ? obj.rating : null));
    var n = parseFloat(v);
    return (!isNaN(n) && n > 0) ? n : null;
  }

  // ── Check cards for target players ──

  function checkCards(cards, sport) {
    if (!cards || !cards.length) return;
    var seen    = loadSeen();
    var changed = false;
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var id = String(card.id || card.cardId || card.playId || '');
      if (!id) continue;
      var alreadySeen = seen.has(id);
      seen.add(id);
      changed = true;
      if (alreadySeen) continue;
      if (!isFresh(card)) continue;
      var name = getPackPlayerName(card);
      if (!name) continue;
      var nameLower = name.toLowerCase();
      var matched = TARGETS.some(function(t) { return nameLower.indexOf(t) !== -1; });
      if (!matched) continue;
      var rarity  = card.rarityLabel || (card.card && card.card.rarityLabel) || '';
      var rating  = cardRating(card) || cardRating(card.card) || cardRating(card.play);
      var owner   = card.username || card.ownerUsername || (card.user && card.user.username) || '';
      var label   = sport === 'ufc' ? 'UFC' : 'FC';
      var msg = '🃏 <b>Pack Alert</b> (' + label + ')\\n'
              + name + (rarity ? ' (' + rarity + ')' : '')
              + (rating != null ? ' | Rating: ' + rating : '')
              + (owner ? '\\nOwned by: ' + owner : '');
      console.log('[Pack Alert] ALERT', name, rarity, sport);
      queueAlert(msg);
    }
    if (changed) saveSeen(seen);
  }

  // ── Intercept fetch — catches globalcards as RS loads them + captures auth headers ──

  var _origFetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      var url = (typeof input === 'string' ? input : (input && input.url)) || '';
      if (url.indexOf('realapp.com') !== -1 && init && init.headers) {
        var h   = init.headers;
        var ai  = h['real-auth-info'] || h['Real-Auth-Info'];
        if (ai && !_capturedHeaders) {
          _capturedHeaders = Object.assign({}, h);
          console.log('[Pack Alert] auth captured, prefix:', ai.split('!')[0]);
        }
      }
    } catch(e) {}

    return _origFetch.apply(this, arguments).then(function(res) {
      try {
        var url = (typeof input === 'string' ? input : (input && input.url)) || '';
        if (url.indexOf('globalcards') !== -1) {
          var sport = url.indexOf('/ufc/') !== -1 ? 'ufc' : 'soccer';
          res.clone().json().then(function(data) {
            var cards = data.cards || data.items || data.data || data.plays || [];
            if (cards.length) {
              console.log('[Pack Alert] intercepted', cards.length, sport, 'card(s)');
              checkCards(cards, sport);
            }
          }).catch(function() {});
        }
      } catch(e) {}
      return res;
    });
  };

  // ── Proactive polling every 3 min (runs only when auth headers are captured) ──

  function makeHeaders() {
    var h = Object.assign({}, _capturedHeaders || {});
    h['real-request-token'] = Math.random().toString(36).slice(2, 18);
    return h;
  }

  async function pollGlobalCards() {
    if (!_capturedHeaders) return;
    var endpoints = [
      { url: GC_SOCCER_URL, sport: 'soccer' },
      { url: GC_UFC_URL,    sport: 'ufc'    },
    ];
    for (var i = 0; i < endpoints.length; i++) {
      var ep = endpoints[i];
      try {
        var res = await _origFetch(ep.url, { headers: makeHeaders() });
        if (!res.ok) { console.log('[Pack Alert] poll', ep.sport, res.status); continue; }
        var data  = await res.json();
        var cards = data.cards || data.items || data.data || data.plays || [];
        console.log('[Pack Alert] poll', ep.sport, '->', cards.length, 'card(s)');
        checkCards(cards, ep.sport);
      } catch(e) {
        console.log('[Pack Alert] poll error', ep.sport, ':', e.message);
      }
    }
  }

  setInterval(pollGlobalCards, POLL_MS);
  console.log('[Pack Alert] active v1.0, targets:', TARGETS.join(', '));

})();
`;
document.documentElement.appendChild(s);
s.remove();
