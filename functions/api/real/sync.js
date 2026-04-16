// functions/api/real/sync.js
function hashidsEncode(number) {
  const saltChars = Array.from('realwebapp');
  const minLen = 16;
  const keepUnique = c => [...new Set(c)];
  const without = (c, x) => c.filter(ch => !x.includes(ch));
  const only = (c, k) => c.filter(ch => k.includes(ch));
  function shuffle(alpha, salt) {
    if (!salt.length) return alpha;
    let int, t = [...alpha];
    for (let i = t.length-1, v=0, p=0; i>0; i--, v++) {
      v %= salt.length; p += int = salt[v].codePointAt(0);
      const j = (int+v+p) % i; [t[i],t[j]] = [t[j],t[i]];
    }
    return t;
  }
  function toAlpha(n, alpha) {
    const id=[]; let v=n;
    do { id.unshift(alpha[v%alpha.length]); v=Math.floor(v/alpha.length); } while(v>0);
    return id;
  }
  let alpha = Array.from('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890');
  let seps  = Array.from('cfhistuCFHISTU');
  const uniq = keepUnique(alpha);
  alpha = without(uniq, seps);
  seps  = shuffle(only(seps, uniq), saltChars);
  if (!seps.length || alpha.length/seps.length > 3.5) {
    const sl = Math.ceil(alpha.length/3.5);
    if (sl > seps.length) { seps.push(...alpha.slice(0,sl-seps.length)); alpha=alpha.slice(sl-seps.length); }
  }
  alpha = shuffle(alpha, saltChars);
  const gc = Math.ceil(alpha.length/12);
  let guards;
  if (alpha.length < 3) { guards=seps.slice(0,gc); seps=seps.slice(gc); }
  else { guards=alpha.slice(0,gc); alpha=alpha.slice(gc); }
  const numId = number % 100;
  let ret = [alpha[numId % alpha.length]];
  const lottery = [...ret];
  alpha = shuffle(alpha, lottery.concat(saltChars, alpha));
  ret.push(...toAlpha(number, alpha));
  if (ret.length < minLen) ret.unshift(guards[(numId+ret[0].codePointAt(0)) % guards.length]);
  if (ret.length < minLen) ret.push(guards[(numId+ret[2].codePointAt(0)) % guards.length]);
  const half = Math.floor(alpha.length/2);
  while (ret.length < minLen) {
    alpha = shuffle(alpha, alpha);
    ret.unshift(...alpha.slice(half)); ret.push(...alpha.slice(0,half));
    const ex = ret.length-minLen;
    if (ex>0) ret=ret.slice(ex/2, ex/2+minLen);
  }
  return ret.join('');
}

function buildHeaders(env) {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': 'https://realsports.io',
    'Referer': 'https://realsports.io/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-auth-info': env.REAL_AUTH_TOKEN,
    'real-device-name': '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-device-type': 'desktop_web',
    'real-device-uuid': '2e0a38e2-0ee8-4f93-9a34-218ac1d10161',
    'real-request-token': hashidsEncode(Date.now()),
    'real-version': '28'
  };
}

const SPORT_MAP = {
  'basketball_nba': 'nba',
  'icehockey_nhl': 'nhl',
  'baseball_mlb': 'mlb',
  'basketball_ncaab': 'cbb',
  'mma_mixed_martial_arts': 'ufc',
  'soccer_epl': 'epl',
  'soccer_uefa_champs_league': 'ucl',
  'soccer_fc': 'soccer'
};

// Sports not supported by Real Sports API
const UNSUPPORTED_SPORTS = new Set([]);

// Sports accessible to free-plan users (on their individual sport tabs)
const FREE_PLAN_SPORTS = new Set(['basketball_nba', 'icehockey_nhl', 'baseball_mlb']);

async function getSession(request, db) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return null;
  const now = Math.floor(Date.now()/1000);
  return db.prepare(
    'SELECT u.id as user_id, u.plan, u.is_admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(m[1], now).first();
}

function extractGames(gamesData) {
  // Collect from ALL possible locations and deduplicate by game ID.
  const seen = new Set();
  const all = [];

  const cutoff = Date.now() - 5 * 60 * 60 * 1000; // drop games that started >5h ago
  function addGame(g) {
    if (!g) return;
    const id = g.id || g.gameId;
    if (!id || seen.has(id)) return;
    // Drop settled/closed games — RS sets isClosed=true and status='final' when resolved
    if (g.isClosed === true) return;
    if (g.status === 'final' || g.status === 'closed' || g.status === 'completed') return;
    // Filter out games that started >5h ago — RS field is 'dateTime' (primary) with fallbacks
    const startRaw = g.dateTime || g.commenceTime || g.startTime || g.scheduledAt || g.gameTime || g.startDate;
    if (startRaw) {
      const ms = typeof startRaw === 'number' ? startRaw : new Date(startRaw).getTime();
      if (ms < cutoff) return; // definitely over, skip
    }
    seen.add(id);
    all.push(g);
  }

  function addGames(arr) {
    if (Array.isArray(arr)) arr.forEach(addGame);
  }

  // Direct top-level arrays
  addGames(gamesData.games);
  addGames(gamesData.data);
  addGames(gamesData.items);
  addGames(gamesData.predictions);

  // latestDayContent - today's games
  if (gamesData.latestDayContent) {
    const lcd = gamesData.latestDayContent;
    addGames(lcd.games || lcd.predictions || lcd.items || lcd.events);
  }

  // Any other day-content keys whose date is today or tomorrow UTC
  const today    = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  for (const key of Object.keys(gamesData)) {
    if (key === 'latestDayContent') continue;
    const val = gamesData[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const dayDate = val.day || val.date;
      if (dayDate === today || dayDate === tomorrow) {
        addGames(val.games || val.predictions || val.items || val.events);
      }
    }
  }

  return all;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');
  if (!env.REAL_AUTH_TOKEN) return fail(500, 'REAL_AUTH_TOKEN not set');

  const reqUrl = new URL(request.url);
  const fdKey = reqUrl.searchParams.get('sport');

  // Pro gate: non-free-sport syncs require a Pro plan (server-authoritative — not bypassable client-side)
  if (!FREE_PLAN_SPORTS.has(fdKey) && session.plan !== 'pro' && !session.is_admin) {
    return fail(403, 'Pro plan required');
  }
  const realSport = SPORT_MAP[fdKey] || fdKey;
  const debugMode = reqUrl.searchParams.get('debug');

  // Return empty markets for unsupported sports
  if (UNSUPPORTED_SPORTS.has(fdKey)) {
    return new Response(JSON.stringify({ ok: true, markets: {} }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (debugMode === '1') {
    return new Response(JSON.stringify({ fdKey, realSport, hasToken: !!env.REAL_AUTH_TOKEN }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // For soccer_fc, also fetch UCL in parallel — RS treats UCL as a separate sport
    const fetchPromises = [
      fetch(`https://web.realapp.com/home/${realSport}/next?cohort=0`, { headers: buildHeaders(env) })
    ];
    if (realSport === 'soccer') {
      fetchPromises.push(fetch('https://web.realapp.com/home/ucl/next?cohort=0', { headers: buildHeaders(env) }));
    }
    const [gamesRes, uclRes] = await Promise.all(fetchPromises);

    const gamesStatus = gamesRes.status;
    const gamesText = await gamesRes.text();

    if (debugMode === '2') {
      return new Response(JSON.stringify({ gamesStatus, gamesText: gamesText.slice(0, 8000) }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!gamesRes.ok) {
      return fail(gamesStatus, 'Games fetch failed: ' + gamesText.slice(0, 200));
    }

    const gamesData = JSON.parse(gamesText);
    const games = extractGames(gamesData);

    // Merge UCL games — tag with _rsSport so market URL uses 'ucl' not 'soccer'
    if (uclRes && uclRes.ok) {
      try {
        const uclData = await uclRes.json();
        const uclGames = extractGames(uclData);
        const seenIds = new Set(games.map(g => g.id || g.gameId));
        for (const g of uclGames) {
          const id = g.id || g.gameId;
          if (id && !seenIds.has(id)) {
            g._rsSport = 'ucl';
            games.push(g);
            seenIds.add(id);
          }
        }
      } catch(e) {}
    }

    if (debugMode === '3') {
      return new Response(JSON.stringify({
        gamesStatus,
        topKeys: Object.keys(gamesData),
        latestDayContentDay: gamesData.latestDayContent && gamesData.latestDayContent.day,
        latestDayContentGamesCount: gamesData.latestDayContent && gamesData.latestDayContent.games && gamesData.latestDayContent.games.length,
        extractedGamesCount: games.length,
        extractedGameKeys: games.map(g => ((g.awayTeam && g.awayTeam.name) || g.awayTeamKey || '?') + ' @ ' + ((g.homeTeam && g.homeTeam.name) || g.homeTeamKey || '?')),
        gameIds: games.map(g => ({ id: g.id, away: (g.awayTeam?.name || g.awayTeamKey), home: (g.homeTeam?.name || g.homeTeamKey) }))
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (debugMode === '4') {
      const lcd = gamesData.latestDayContent || {};
      return new Response(JSON.stringify({
        latestDayContentKeys: Object.keys(lcd),
        firstGame: lcd.games && lcd.games[0],
        teamsOrPlayers: lcd.teams || lcd.players || lcd.fighters || lcd.athletes || null,
        topLevelTeams: gamesData.teams || gamesData.players || gamesData.fighters || gamesData.athletes || null
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (debugMode === '5') {
      // Fetch raw markets response for first game to inspect volume fields
      const firstGame = games[0];
      if (!firstGame) return new Response(JSON.stringify({ error: 'no games' }), { headers: { 'Content-Type': 'application/json' } });
      const gameId = firstGame.id || firstGame.gameId;
      const mUrl = `https://web.realapp.com/predictions/game/${realSport}/${gameId}/markets`;
      const mRes = await fetch(mUrl, { headers: buildHeaders(env) });
      const mText = await mRes.text();
      return new Response(JSON.stringify({ gameId, rawMarkets: JSON.parse(mText) }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (debugMode === '6') {
      // Find specific game by away/home key and fetch its markets
      const targetAway = reqUrl.searchParams.get('away') || '';
      const targetHome = reqUrl.searchParams.get('home') || '';
      const targetGame = games.find(g => {
        const away = (g.awayTeam?.name || g.awayTeamKey || '').toLowerCase();
        const home = (g.homeTeam?.name || g.homeTeamKey || '').toLowerCase();
        return away.includes(targetAway.toLowerCase()) || home.includes(targetHome.toLowerCase());
      });
      if (!targetGame) return new Response(JSON.stringify({ error: 'game not found', keys: games.map(g => (g.awayTeam?.name || g.awayTeamKey) + ' @ ' + (g.homeTeam?.name || g.homeTeamKey)) }), { headers: { 'Content-Type': 'application/json' } });
      const gameId = targetGame.id || targetGame.gameId;
      const mUrl = `https://web.realapp.com/predictions/game/${realSport}/${gameId}/markets`;
      const mRes = await fetch(mUrl, { headers: buildHeaders(env) });
      const mText = await mRes.text();
      return new Response(JSON.stringify({ gameId, status: mRes.status, rawMarkets: mText.slice(0, 2000) }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (debugMode === '7') {
      const testId = reqUrl.searchParams.get('id') || '23560';
      const mUrl = `https://web.realapp.com/predictions/game/${realSport}/${testId}/markets`;
      const mRes = await fetch(mUrl, { headers: buildHeaders(env) });
      const mText = await mRes.text();
      return new Response(JSON.stringify({ status: mRes.status, body: mText.slice(0, 10000) }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (debugMode === '8') {
      // Dump raw game objects to inspect structure (including all top-level keys for start-time discovery)
      const targetId = parseInt(reqUrl.searchParams.get('id') || '0');
      const game = targetId ? games.find(g => (g.id || g.gameId) === targetId) : games[0];
      const gameObj = game ? JSON.parse(JSON.stringify(game)) : null;
      const topKeys = gameObj ? Object.keys(gameObj) : [];
      return new Response(JSON.stringify({ game: gameObj, topKeys, allIds: games.map(g => g.id || g.gameId) }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (debugMode === '10') {
      // Fetch first game + its markets, dump both raw objects to find start time field names
      const game = games[0];
      if (!game) return new Response(JSON.stringify({ error: 'no games' }), { headers: { 'Content-Type': 'application/json' } });
      const gameId = game.id || game.gameId;
      const gameSport = game._rsSport || realSport;
      const mUrl = `https://web.realapp.com/predictions/game/${gameSport}/${gameId}/markets`;
      const mRes = await fetch(mUrl, { headers: buildHeaders(env) });
      let mData = null;
      try { mData = await mRes.json(); } catch(e) {}
      const gameObj = JSON.parse(JSON.stringify(game));
      return new Response(JSON.stringify({
        gameTopKeys: Object.keys(gameObj),
        gameObj,
        marketsTopKeys: mData ? Object.keys(mData) : [],
        marketsObj: mData ? JSON.parse(JSON.stringify(mData)).game || null : null
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (debugMode === '9') {
      // Run fetchGameMarkets for a specific game — defined below, so we fall through
      // This is handled after fetchGameMarkets definition
    }

    if (!games.length) {
      return new Response(JSON.stringify({ ok: true, markets: {}, debug: 'no games', keys: Object.keys(gamesData) }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Fetch market data with retry logic — sequential to avoid rate limiting
    async function fetchGameMarkets(game, tokenOffset) {
      const gameId = game.id || game.gameId;
      // Handle fighters array (UFC/MMA) vs awayTeam/homeTeam (team sports)
      const fighters = game.fighters || game.athletes || game.players;
      const awayKey = (game.awayTeam && game.awayTeam.name) || game.awayTeamKey || game.awayTeam?.key
                   || (fighters && fighters[0] && (fighters[0].name || fighters[0].displayName));
      const homeKey = (game.homeTeam && game.homeTeam.name) || game.homeTeamKey || game.homeTeam?.key
                   || (fighters && fighters[1] && (fighters[1].name || fighters[1].displayName));
      if (!gameId || !awayKey || !homeKey) return { _err: 'no keys', gameId };
      const headers = buildHeaders(env);
      if (tokenOffset) headers['real-request-token'] = hashidsEncode(Date.now() + (tokenOffset || 0));

      const gameSport = game._rsSport || realSport;
      const url = `https://web.realapp.com/predictions/game/${gameSport}/${gameId}/markets`;
      let attempt = 0;
      let lastStatus = null;
      let lastErr = null;
      while (attempt < 3) {
        try {
          const mRes = await fetch(url, { headers: attempt === 0 ? headers : buildHeaders(env) });
          lastStatus = mRes.status;
          if (mRes.ok) {
            let mData;
            try {
              mData = await mRes.json();
            } catch(jsonErr) {
              // JSON parse failed — try text to debug
              attempt++;
              continue;
            }
            // Real Sports sometimes wraps 429 in a 200 response
            if (mData.statusCode === 429 || mData.error === 'Too Many Requests') {
              break; // Skip this game, rely on merge cache
            }
            const gameKey = awayKey + ' @ ' + homeKey;
            // Build initials -> full name map for this fight
            const keyToName = {};
            if (game.awayTeam) keyToName[game.awayTeam.key] = game.awayTeam.name;
            if (game.homeTeam) keyToName[game.homeTeam.key] = game.homeTeam.name;
            // UFC/MMA: map fighter keys to full names for outcome label resolution
            if (fighters) fighters.forEach(f => {
                if (f.key && f.name) keyToName[f.key] = f.name;
                if (f.key && f.displayName) keyToName[f.key] = f.displayName;
            });
            const markets = {};
            for (const mk of (mData.markets || [])) {
              // Parse volumeDisplay e.g. "213.7k" -> 213700, "1.9k" -> 1900
              const volStr = String(mk.volumeDisplay || '');
              const volNum = volStr.endsWith('k') ? parseFloat(volStr) * 1000
                           : volStr.endsWith('m') ? parseFloat(volStr) * 1000000
                           : parseFloat(volStr) || 0;
              markets[mk.label] = {
                volume: volNum,
                volumeDisplay: volStr,
                outcomes: (mk.outcomes || []).map(o => ({
                  key: o.key, label: keyToName[o.label] || keyToName[o.key] || o.label,
                  probability: o.probability, pct: Math.round(o.probability * 100),
                  line: (() => {
                    const m = (o.label || '').match(/([+-]?\d+\.?\d*)\s*$/);
                    return m ? parseFloat(m[1]) : null;
                  })()
                }))
              };
            }
            // Build lines from spread/total outcome labels (more accurate than game.pointSpread)
            const lines = {};
            const spreadMkt = (mData.markets || []).find(m => m.label === 'Spread');
            if (spreadMkt && spreadMkt.outcomes) {
              const awayO = spreadMkt.outcomes[0];
              const homeO = spreadMkt.outcomes[1];
              // Only extract spread if label has letters (team name like "OKC -3.5") — bare numbers like "3" are live probabilities
              const awayLine = awayO && /[a-zA-Z]/.test(awayO.label || '') && (awayO.label || '').match(/([+-]?\d+\.?\d*)\s*$/);
              const homeLine = homeO && /[a-zA-Z]/.test(homeO.label || '') && (homeO.label || '').match(/([+-]?\d+\.?\d*)\s*$/);
              if (awayLine) lines.awaySpread = parseFloat(awayLine[1]);
              if (homeLine) lines.homeSpread = parseFloat(homeLine[1]);
            }
            const totalMkt = (mData.markets || []).find(m => m.label === 'Total');
            if (totalMkt && totalMkt.outcomes && totalMkt.outcomes[0]) {
              const totalLine = (totalMkt.outcomes[0].label || '').match(/(\d+\.?\d*)\s*$/);
              if (totalLine) lines.total = parseFloat(totalLine[1]);
            }
            // Store the RS league/sport for URL generation (MLS vs EPL vs generic soccer)
            const rsSport = game.sport || (game.league && game.league.sport) || (game.league && game.league.key) || null;
            // Store game start time so client can skip preds when RS data is for a different day.
            // RS primary field is 'dateTime'; fall back to other common field names.
            const rawStart = game.dateTime || game.commenceTime || game.startTime || game.scheduledAt
                          || game.gameTime || game.startDate || game.startAt || game.startsAt
                          || game.kickoffTime || game.eventDate || game.gameDate;
            const startMs = rawStart ? (typeof rawStart === 'number' ? rawStart : new Date(rawStart).getTime()) : null;
            return { gameKey, markets, lines, gameId, rsSport, startMs };
          }
          if (mRes.status === 429) {
            // Rate limited on this specific game — skip and rely on D1 merge cache
            break;
          }
          if (mRes.status >= 500) {
            await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
            attempt++;
            continue;
          }
          // Log non-retryable failures
          return null;
        } catch(e) {
          lastErr = e.message;
          attempt++;
          await new Promise(r => setTimeout(r, 400 * attempt));
        }
      }
      return { _err: 'exhausted', lastStatus, lastErr, gameId };
    }

    // Two-phase fetch: return cached data immediately, fetch missing games in background
    const marketMap = {};
    const now = Math.floor(Date.now() / 1000);
    const cacheKey = 'real_sync_' + realSport + '_v8'; // v8: filter isClosed/final games; dateTime as primary start field
    const TTL = 15;

    // Phase 1: Load cache
    try {
      const cacheRow = await env.DB.prepare(
        'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
      ).bind(cacheKey).first();
      if (cacheRow) {
        Object.assign(marketMap, JSON.parse(cacheRow.data));
        if ((now - cacheRow.fetched_at) < TTL) {
          // Cache fresh — check for missing games or games missing __gid
          const missingGames = games.filter(g => {
            const awayKey = (g.awayTeam && g.awayTeam.name) || g.awayTeamKey;
            const homeKey = (g.homeTeam && g.homeTeam.name) || g.homeTeamKey;
            const gameKey = awayKey + ' @ ' + homeKey;
            return !marketMap[gameKey] || !marketMap[gameKey + '__gid'];
          });
          if (missingGames.length === 0) {
            return new Response(JSON.stringify({ ok: true, markets: marketMap }), {
              headers: { 'Content-Type': 'application/json' }
            });
          }
          // Fetch missing games with 3s timeout per game, then return combined result
          const bgMap = { ...marketMap };
          const bgResults = [];
          for (let i = 0; i < missingGames.length; i++) {
            const result = await Promise.race([
              fetchGameMarkets(missingGames[i], i * 100),
              new Promise(r => setTimeout(() => r({ _err: 'timeout' }), 5000))
            ]);
            bgResults.push(result);
            if (i < missingGames.length - 1) await new Promise(r => setTimeout(r, 300));
          }
          const bgDebug = bgResults.map((r, i) => {
            const g = missingGames[i];
            return { game: (g.awayTeam?.name||'?') + ' @ ' + (g.homeTeam?.name||'?'), got: !!(r && !r._err), err: r?._err, status: r?.lastStatus, lastErr: r?.lastErr };
          });
          for (const result of bgResults) {
            if (result && !result._err) {
              bgMap[result.gameKey] = result.markets;
              if (result.lines && Object.keys(result.lines).length) bgMap[result.gameKey + '__lines'] = result.lines;
              if (result.gameId) bgMap[result.gameKey + '__gid'] = result.gameId;
              if (result.rsSport) bgMap[result.gameKey + '__sport'] = result.rsSport;
              if (result.startMs) bgMap[result.gameKey + '__startMs'] = result.startMs;
            }
          }
          // Write updated cache
          try {
            await env.DB.prepare(
              'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
            ).bind(cacheKey, JSON.stringify(bgMap), now).run();
          } catch(e) {}
          return new Response(JSON.stringify({ ok: true, markets: bgMap, bgDebug }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
    } catch(e) {}

    // Phase 2: Cache stale or empty — fetch all games in parallel with 8s timeout each
    if (debugMode === '9') {
      const targetId = parseInt(reqUrl.searchParams.get('id') || '0');
      const game = targetId ? games.find(g => (g.id || g.gameId) === targetId) : games[0];
      if (!game) return new Response(JSON.stringify({ error: 'game not found' }), { headers: { 'Content-Type': 'application/json' } });
      const gameId = game.id || game.gameId;
      const url = `https://web.realapp.com/predictions/game/${realSport}/${gameId}/markets`;
      const mRes = await fetch(url, { headers: buildHeaders(env) });
      const mText = await mRes.text();
      let mData = null;
      let parseErr = null;
      try { mData = JSON.parse(mText); } catch(e) { parseErr = e.message; }
      return new Response(JSON.stringify({
        status: mRes.status,
        ok: mRes.ok,
        parseErr,
        hasMarkets: !!(mData && mData.markets),
        marketsLength: mData?.markets?.length,
        firstMarketLabel: mData?.markets?.[0]?.label,
        awayKey: (game.awayTeam?.name || game.awayTeamKey),
        homeKey: (game.homeTeam?.name || game.homeTeamKey)
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    const results = [];
    for (let i = 0; i < games.length; i++) {
      const result = await Promise.race([
        fetchGameMarkets(games[i], i * 100),
        new Promise(r => setTimeout(() => r({ _err: 'timeout' }), 5000))
      ]);
      results.push(result);
      if (i < games.length - 1) await new Promise(r => setTimeout(r, 300));
    }
    for (const result of results) {
      if (result && !result._err) {
        marketMap[result.gameKey] = result.markets;
        if (result.lines && Object.keys(result.lines).length) {
          marketMap[result.gameKey + '__lines'] = result.lines;
        }
        if (result.gameId) marketMap[result.gameKey + '__gid'] = result.gameId;
        if (result.rsSport) marketMap[result.gameKey + '__sport'] = result.rsSport;
        if (result.startMs) marketMap[result.gameKey + '__startMs'] = result.startMs;
      }
    }

    // Write back to cache
    try {
      await env.DB.prepare(
        'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
      ).bind(cacheKey, JSON.stringify(marketMap), now).run();
    } catch(e) {}

    return new Response(JSON.stringify({ ok: true, markets: marketMap }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch(e) {
    return fail(500, e.message + ' | ' + (e.stack||'').slice(0,300));
  }
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
