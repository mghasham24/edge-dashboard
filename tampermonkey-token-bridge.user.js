// ==UserScript==
// @name         RS Token Bridge
// @namespace    raxedge
// @version      2.1
// @description  Pushes RS auth token every 30s + full market data every 4min to RaxEdge
// @match        https://realsports.io/*
// @match        https://www.realsports.io/*
// @match        https://www.realapp.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      raxedge.com
// @connect      web.realapp.com
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';

  var TOKEN_URL = 'https://raxedge.com/api/admin/rs-token?key=rax-bridge-9w2k5j7n';
  var SYNC_URL  = 'https://raxedge.com/api/real/sync?_tm_key=rax-bridge-9w2k5j7n';
  var RS_BASE   = 'https://web.realapp.com';

  // [fdKey, rsSport] — fdKey is what our endpoint expects, rsSport is the RS API slug
  var SPORTS = [
    ['basketball_nba',         'nba'],
    ['icehockey_nhl',          'nhl'],
    ['baseball_mlb',           'mlb'],
    ['mma_mixed_martial_arts', 'ufc'],
    ['basketball_wnba',        'wnba'],
    ['soccer_fc',              'soccer'],
  ];

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

  function makeHeaders(tokenStr) {
    return {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Origin': 'https://realsports.io',
      'Referer': 'https://realsports.io/',
      'real-auth-info': tokenStr,
      'real-device-name': '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
      'real-device-type': 'desktop_web',
      'real-device-uuid': '2e0a38e2-0ee8-4f93-9a34-218ac1d10161',
      'real-request-token': String(Date.now()),
      'real-version': '31',
    };
  }

  function gmFetch(url, headers) {
    return new Promise(function(resolve, reject) {
      GM_xmlhttpRequest({
        method: 'GET', url: url, headers: headers, timeout: 12000,
        onload: function(r) { resolve(r); },
        onerror: function() { reject(new Error('net')); },
        ontimeout: function() { reject(new Error('timeout')); },
      });
    });
  }

  function extractGames(data) {
    var seen = {}, games = [];
    function add(g) {
      if (!g) return;
      var id = g.id || g.gameId;
      if (!id || seen[id]) return;
      if (g.isClosed) return;
      var s = g.status;
      if (s === 'final' || s === 'closed' || s === 'completed') return;
      seen[id] = true; games.push(g);
    }
    function addArr(arr) { if (Array.isArray(arr)) arr.forEach(add); }
    addArr(data.games); addArr(data.data); addArr(data.items); addArr(data.predictions);
    if (data.latestDayContent) {
      var lcd = data.latestDayContent;
      addArr(lcd.games || lcd.predictions || lcd.items || lcd.events);
    }
    return games;
  }

  function buildGameKey(game) {
    var fighters = game.fighters || game.athletes || game.players;
    var away = (game.awayTeam && game.awayTeam.name) || game.awayTeamKey
            || (fighters && fighters[0] && (fighters[0].name || fighters[0].displayName));
    var home = (game.homeTeam && game.homeTeam.name) || game.homeTeamKey
            || (fighters && fighters[1] && (fighters[1].name || fighters[1].displayName));
    return (away && home) ? (away + ' @ ' + home) : null;
  }

  function parseMarkets(game, mData) {
    var fighters = game.fighters || game.athletes || game.players;
    var keyToName = {};
    if (game.awayTeam) keyToName[game.awayTeam.key] = game.awayTeam.name;
    if (game.homeTeam) keyToName[game.homeTeam.key] = game.homeTeam.name;
    if (fighters) fighters.forEach(function(f) {
      if (f.key && (f.name || f.displayName)) keyToName[f.key] = f.name || f.displayName;
    });
    var markets = {};
    (mData.markets || []).forEach(function(mk) {
      var volStr = String(mk.volumeDisplay || '');
      var volNum = volStr.endsWith('k') ? parseFloat(volStr) * 1000
                 : volStr.endsWith('m') ? parseFloat(volStr) * 1000000
                 : parseFloat(volStr) || 0;
      markets[mk.label] = {
        volume: volNum, volumeDisplay: volStr,
        outcomes: (mk.outcomes || []).map(function(o) {
          var m = (o.label || '').match(/([+-]?\d+\.?\d*)\s*$/);
          return {
            key: o.key, label: keyToName[o.label] || keyToName[o.key] || o.label,
            probability: o.probability, pct: Math.round(o.probability * 100),
            line: m ? parseFloat(m[1]) : null,
          };
        }),
      };
    });
    return markets;
  }

  function extractLines(mData) {
    var lines = {};
    var spreadMkt = (mData.markets || []).find(function(m) { return m.label === 'Spread'; });
    if (spreadMkt && spreadMkt.outcomes) {
      var a = spreadMkt.outcomes[0], h = spreadMkt.outcomes[1];
      var al = a && /[a-zA-Z]/.test(a.label || '') && (a.label || '').match(/([+-]?\d+\.?\d*)\s*$/);
      var hl = h && /[a-zA-Z]/.test(h.label || '') && (h.label || '').match(/([+-]?\d+\.?\d*)\s*$/);
      if (al) lines.awaySpread = parseFloat(al[1]);
      if (hl) lines.homeSpread = parseFloat(hl[1]);
    }
    var totalMkt = (mData.markets || []).find(function(m) { return m.label === 'Total'; });
    if (totalMkt && totalMkt.outcomes && totalMkt.outcomes[0]) {
      var tl = (totalMkt.outcomes[0].label || '').match(/(\d+\.?\d*)\s*$/);
      if (tl) lines.total = parseFloat(tl[1]);
    }
    return lines;
  }

  async function syncSport(fdKey, rsSport, tokenStr) {
    var headers = makeHeaders(tokenStr);
    var gamesRes;
    try { gamesRes = await gmFetch(RS_BASE + '/home/' + rsSport + '/next?cohort=0', headers); }
    catch(e) { return; }
    if (gamesRes.status !== 200) return;
    var gamesData;
    try { gamesData = JSON.parse(gamesRes.responseText); } catch(e) { return; }
    var games = extractGames(gamesData);

    if (rsSport === 'soccer') {
      try {
        var uclRes = await gmFetch(RS_BASE + '/home/ucl/next?cohort=0', headers);
        if (uclRes.status === 200) {
          var uclGames = extractGames(JSON.parse(uclRes.responseText));
          var seen = {}; games.forEach(function(g) { seen[g.id || g.gameId] = true; });
          uclGames.forEach(function(g) {
            var id = g.id || g.gameId;
            if (id && !seen[id]) { g._rsSport = 'ucl'; games.push(g); seen[id] = true; }
          });
        }
      } catch(e) {}
    }

    if (!games.length) return;

    var freshMap = {};
    for (var i = 0; i < games.length; i += 4) {
      await Promise.all(games.slice(i, i + 4).map(async function(game) {
        var gameKey = buildGameKey(game);
        if (!gameKey) return;
        var gameId = game.id || game.gameId;
        var sport = game._rsSport || rsSport;
        try {
          var mRes = await gmFetch(RS_BASE + '/predictions/game/' + sport + '/' + gameId + '/markets', makeHeaders(tokenStr));
          if (mRes.status !== 200) return;
          var mData = JSON.parse(mRes.responseText);
          if (mData.statusCode === 429 || mData.error === 'Too Many Requests') return;
          freshMap[gameKey] = parseMarkets(game, mData);
          var lines = extractLines(mData);
          if (Object.keys(lines).length) freshMap[gameKey + '__lines'] = lines;
          freshMap[gameKey + '__gid'] = gameId;
          var rsSportTag = game.sport || (game.league && (game.league.sport || game.league.key)) || null;
          if (rsSportTag) freshMap[gameKey + '__sport'] = rsSportTag;
          var rawStart = game.dateTime || game.commenceTime || game.startTime || game.scheduledAt || game.gameTime;
          if (rawStart) freshMap[gameKey + '__startMs'] = typeof rawStart === 'number' ? rawStart : new Date(rawStart).getTime();
        } catch(e) {}
      }));
      if (i + 4 < games.length) await new Promise(function(r) { setTimeout(r, 400); });
    }

    if (!Object.keys(freshMap).length) return;
    GM_xmlhttpRequest({
      method: 'POST', url: SYNC_URL,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ sport: fdKey, markets: freshMap }),
      onerror: function() {}, ontimeout: function() {},
    });
  }

  function pushToken() {
    var info = getTokenInfo();
    if (!info) return;
    GM_xmlhttpRequest({
      method: 'POST', url: 'http://127.0.0.1:27182/token',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ token: info.token }),
      onerror: function() {}, ontimeout: function() {},
    });
    GM_xmlhttpRequest({
      method: 'POST', url: TOKEN_URL,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ token: info.token, deviceUuid: info.deviceUuid }),
      onerror: function() {}, ontimeout: function() {},
    });
  }

  async function pushMarkets() {
    var info = getTokenInfo();
    if (!info) return;
    for (var i = 0; i < SPORTS.length; i++) {
      await syncSport(SPORTS[i][0], SPORTS[i][1], info.token);
    }
  }

  pushToken();
  setInterval(pushToken, 30000);

  pushMarkets();
  setInterval(pushMarkets, 4 * 60 * 1000);

})();
