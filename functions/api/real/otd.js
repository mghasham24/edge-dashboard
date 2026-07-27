import { getSessionOrCron } from '../../_lib/auth.js';
import { hashidsEncode, rsUrlEncode } from '../../_lib/hashids.js';

const RS_SPORT_CODE = {nba:1,nfl:2,ncaam:3,mlb:4,epl:5,ucl:6,nhl:7,mls:8,fifa:9,ufc:10,ncaaf:11,wnba:12,soccer:14,golf:15,ncaabb:16};

const RS_BASE = 'https://web.realapp.com';

function buildHeaders(env) {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': 'https://www.realapp.com',
    'Referer': 'https://www.realapp.com/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
    'real-auth-info': env.REAL_AUTH_TOKEN || '',
    'real-session-token': env.REAL_SESSION_TOKEN || '',
    'real-device-uuid': env.REAL_DEVICE_UUID || '',
    'real-device-name': '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
    'real-device-type': 'desktop_web',
    'real-request-token': hashidsEncode(Date.now()),
    'real-version': '35'
  };
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSessionOrCron(request, env);
  if (!session) return fail(401, 'Not authenticated');

  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const now = Math.floor(Date.now() / 1000);

  // No RS token required — reads from D1 only
  if (action === 'get_multipliers') {
    const row = await env.DB.prepare(
      "SELECT data FROM odds_cache WHERE cache_key='meta:otd_sport_multipliers'"
    ).first();
    if (!row) return new Response(JSON.stringify({ ok: false, error: 'not probed yet' }), { headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ ok: true, multipliers: JSON.parse(row.data) }), { headers: { 'Content-Type': 'application/json' } });
  }

  // Proxy RS card background images so browser sends Referer: realapp.com (CDN requires it)
  if (action === 'card_bg') {
    const src = (url.searchParams.get('src') || '').replace(/\.\./g, '');
    if (!/^assets\/cards\/bg\/[a-z0-9]+\.(png|jpg|webp)$/.test(src)) return fail(400, 'Invalid src');
    const imgRes = await fetch(`https://media.realapp.com/${src}`, {
      headers: { 'Referer': 'https://www.realapp.com/', 'Origin': 'https://www.realapp.com/' }
    });
    if (!imgRes.ok) return new Response('', { status: imgRes.status });
    return new Response(imgRes.body, {
      headers: {
        'Content-Type': imgRes.headers.get('content-type') || 'image/png',
        'Cache-Control': 'public, max-age=604800',
      }
    });
  }

  if (!env.REAL_AUTH_TOKEN || !env.REAL_SESSION_TOKEN) {
    return fail(503, 'REAL_AUTH_TOKEN or REAL_SESSION_TOKEN not set');
  }

  // Build token pool from env vars RS_POOL_1..N + main token
  // Per account: RS_POOL_N (real-auth-info), RS_POOL_SESSION_N (real-session-token), REAL_DEVICE_UUID_N (real-device-uuid)
  const poolTokens = [];
  if (env.REAL_AUTH_TOKEN && env.REAL_SESSION_TOKEN) {
    poolTokens.push({ auth: env.REAL_AUTH_TOKEN, session: env.REAL_SESSION_TOKEN, uuid: env.REAL_DEVICE_UUID });
  }
  for (let i = 1; i <= 20; i++) {
    const auth = env[`RS_POOL_${i}`];
    const session = env[`RS_POOL_SESSION_${i}`];
    if (!auth) break;
    if (session) poolTokens.push({ auth, session, uuid: env[`REAL_DEVICE_UUID_${i}`] || env.REAL_DEVICE_UUID });
  }

  function buildHeadersWithToken({ auth, session, uuid }) {
    return {
      ...buildHeaders(env),
      'real-auth-info': auth,
      'real-session-token': session || '',
      'real-device-uuid': uuid || env.REAL_DEVICE_UUID || '',
    };
  }
  function pickToken() { return poolTokens[Math.floor(Math.random() * poolTokens.length)]; }

  const headers = buildHeadersWithToken(pickToken());

  // Search: find players by name
  if (action === 'search') {
    const q = (url.searchParams.get('q') || '').trim();
    const sport = url.searchParams.get('sport') || 'mlb';
    if (q.length < 2) return fail(400, 'Query too short');

    const cacheKey = (sport === 'ufc' ? 'otd_search_v8_' : 'otd_search_v7_') + sport + '_' + q.toLowerCase().replace(/[^a-z0-9]/g, '_');
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < 3600) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
      }
    } catch(e) {}

    const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const queryWords = norm(q).split(/\s+/).filter(w => w.length > 1);

    // UFC: RS search never returns fighters (they are entityType=team, not player).
    // Search our D1 passes cache instead — fighters already owned by any user are indexed there.
    if (sport === 'ufc') {
      try {
        const passRows = await env.DB.prepare(
          "SELECT data FROM odds_cache WHERE cache_key LIKE 'otd_passes_all_v9_%' ORDER BY fetched_at DESC LIMIT 60"
        ).all();
        const ufcMap = {};
        for (const row of (passRows.results || [])) {
          try {
            const pd = JSON.parse(row.data);
            for (const p of (pd.passes || [])) {
              if (p.sport !== 'ufc' || ufcMap[p.playerId]) continue;
              const normName = norm(p.playerName || '');
              if (queryWords.some(w => normName.includes(w))) {
                ufcMap[p.playerId] = { id: p.playerId, name: p.playerName, sport: 'ufc', season: p.season || '2025', avatar: p.entityAvatar || p.avatar || '', entityAvatar: p.entityAvatar || '', entityType: 'team' };
              }
            }
          } catch(e) {}
        }
        const players = Object.values(ufcMap).slice(0, 15);
        return new Response(JSON.stringify({ ok: true, players }), { headers: { 'Content-Type': 'application/json' } });
      } catch(e) {
        return fail(500, e.message);
      }
    }

    // RS search API uses different slugs than our internal sport keys
    const RS_SEARCH_SPORT_MAP = { ncaabb: 'ncaam', ncaaf: 'ncaaf' };
    const searchSport = RS_SEARCH_SPORT_MAP[sport] || sport;

    try {
      const trySearch = async (sp) => {
        const sportParam = sp ? `&sport=${sp}` : '';
        const r = await fetch(`${RS_BASE}/search?query=${encodeURIComponent(q)}${sportParam}`, { headers });
        if (!r.ok) return null;
        return r.json();
      };

      const playerMap = {};
      const addPlayer = (pObj) => {
        if (!pObj || !pObj.id || playerMap[pObj.id]) return;
        const name = (pObj.name || ((pObj.firstName || '') + ' ' + (pObj.lastName || '')).trim()).trim();
        if (!name) return;
        if (!queryWords.some(w => norm(name).includes(w))) return;
        playerMap[pObj.id] = { id: pObj.id, name, sport, teamId: pObj.teamId, avatar: pObj.entityAvatar || pObj.avatar || '', entityAvatar: pObj.entityAvatar || '' };
      };
      const extractPlayers = (data) => {
        if (!data) return;
        for (const pObj of (data.players || (data.results && data.results.players) || [])) addPlayer(pObj);
        for (const e of (data.entities || (data.results && data.results.entities) || [])) addPlayer(e.entity || e.player || e);
        for (const play of (data.results && data.results.plays) || (data.plays) || []) {
          addPlayer(play.primaryPlayer); addPlayer(play.secondaryPlayer);
        }
      };

      let data = await trySearch(searchSport);
      extractPlayers(data);
      if (!Object.keys(playerMap).length) {
        const d2 = await trySearch(null);
        extractPlayers(d2);
      }

      const players = Object.values(playerMap).slice(0, 15);
      const body = JSON.stringify({ ok: true, players });
      if (players.length > 0) {
        try {
          await env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at')
            .bind(cacheKey, body, now).run();
        } catch(e) {}
      }
      return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    } catch(e) {
      return fail(500, e.message);
    }
  }

  // Admin: test all pool tokens — hits RS with each and reports which work
  if (action === 'token_pool_test') {
    if (!session.is_admin) return fail(403, 'Admin only');
    const results = await Promise.all(poolTokens.map(async ({ auth, session }, i) => {
      const label = i === 0 ? 'REAL_AUTH_TOKEN' : `RS_POOL_${i}`;
      const prefix = auth.slice(0, 12) + '…';
      const hasSession = !!session;
      try {
        const res = await fetch(`${RS_BASE}/home/nba/next?cohort=0`, {
          headers: buildHeadersWithToken({ auth, session }),
          signal: AbortSignal.timeout(5000),
        });
        return { label, prefix, hasSession, status: res.status, ok: res.ok };
      } catch(e) {
        return { label, prefix, hasSession, status: 0, ok: false, error: e.message };
      }
    }));
    return new Response(JSON.stringify({ ok: true, pool_size: poolTokens.length, max_rs_slots: poolTokens.length * 8, results }, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }

  // Admin debug: returns raw RS search response so we can see actual format
  if (action === 'search_raw') {
    if (!session.is_admin) return fail(403, 'Admin only');
    const q = (url.searchParams.get('q') || '').trim();
    const sport = url.searchParams.get('sport') || 'mlb';
    if (!q) return fail(400, 'Missing q');
    const res = await fetch(`${RS_BASE}/search?query=${encodeURIComponent(q)}&sport=${sport}`, { headers });
    const text = await res.text();
    return new Response(text, { headers: { 'Content-Type': 'application/json' } });
  }

  // Admin debug: returns raw RS earnings response — shows exact field names and structure
  if (action === 'earnings_raw') {
    if (!session.is_admin) return fail(403, 'Admin only');
    const id = url.searchParams.get('id');
    const sport = url.searchParams.get('sport') || 'mlb';
    const season = url.searchParams.get('season') || '2025';
    const level = url.searchParams.get('level') || '1';
    const entityType = url.searchParams.get('entityType') || 'player';
    if (!id) return fail(400, 'Missing id');
    const earningsUrl = `${RS_BASE}/userpassearnings/${sport}/season/${season}/entity/${entityType}/${id}?level=${level}`;
    const res = await fetch(earningsUrl, { headers });
    const text = await res.text();
    return new Response(JSON.stringify({ status: res.status, url: earningsUrl.replace(RS_BASE, ''), body: JSON.parse(text) }, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }

  // Card link: get the RS page hash for an owned pass (entity card URL)
  if (action === 'pass_url') {
    const entityId = url.searchParams.get('id');
    const sport    = url.searchParams.get('sport');
    const entityType = url.searchParams.get('entityType') || 'player';
    const season   = url.searchParams.get('season');
    if (!entityId || !sport || !season) return fail(400, 'Missing params');

    const cacheKey = `otd_pass_url_v2_${sport}_${entityType}_${entityId}_${season}`;
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < 86400) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
      }
    } catch(e) {}

    try {
      const rsUrl = `${RS_BASE}/userpasses/${encodeURIComponent(sport)}/type/${encodeURIComponent(entityType)}/entity/${encodeURIComponent(entityId)}/active?season=${season}`;
      const res = await fetch(rsUrl, { headers });
      if (!res.ok) return fail(res.status, 'RS pass_url failed: ' + res.status);
      const data = await res.json();
      const body = JSON.stringify({ ok: true, raw: data });
      try {
        await env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at')
          .bind(cacheKey, body, now).run();
      } catch(e) {}
      return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    } catch(e) {
      return fail(500, e.message);
    }
  }

  // Performance link: get the RS boxscore for a player on a specific date
  if (action === 'perf_url') {
    const entityId   = url.searchParams.get('id');
    const sport      = url.searchParams.get('sport');
    const season     = url.searchParams.get('season');
    const day        = url.searchParams.get('day'); // YYYY-MM-DD original game date
    const entityType = url.searchParams.get('entityType') || 'player';
    if (!entityId || !sport || !season || !day) return fail(400, 'Missing params');

    const cacheKey = `otd_perf_url_v4_${entityType}_${sport}_${entityId}_${season}`;
    let bsList;
    let triedUrls = [];
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < 86400) {
        bsList = JSON.parse(cached.data);
      }
    } catch(e) {}

    if (!bsList) {
      // Try multiple RS endpoint patterns — stop at first 200
      // RS API convention: sport often in path, e.g. /players/{id}/sport/{sport}/...
      const endpointsToTry = [
        `${RS_BASE}/players/${encodeURIComponent(entityId)}/sport/${encodeURIComponent(sport)}/playerboxscores?season=${encodeURIComponent(season)}`,
        `${RS_BASE}/players/${encodeURIComponent(entityId)}/sport/${encodeURIComponent(sport)}/playerboxscores`,
        `${RS_BASE}/players/${encodeURIComponent(entityId)}/playerboxscores?sport=${encodeURIComponent(sport)}&season=${encodeURIComponent(season)}`,
        `${RS_BASE}/players/${encodeURIComponent(entityId)}/playerboxscores?version=2`,
        `${RS_BASE}/players/${encodeURIComponent(entityId)}/playerboxscores`,
        `${RS_BASE}/players/${encodeURIComponent(entityId)}/gamelog?sport=${encodeURIComponent(sport)}&season=${encodeURIComponent(season)}`,
        `${RS_BASE}/players/${encodeURIComponent(entityId)}/gamelogs?sport=${encodeURIComponent(sport)}&season=${encodeURIComponent(season)}`,
        `${RS_BASE}/playerboxscores?entityId=${encodeURIComponent(entityId)}&entityType=player&sport=${encodeURIComponent(sport)}&season=${encodeURIComponent(season)}`,
        `${RS_BASE}/entities/player/${encodeURIComponent(entityId)}/playerboxscores?season=${encodeURIComponent(season)}`,
        `${RS_BASE}/players/${encodeURIComponent(entityId)}/performances?season=${encodeURIComponent(season)}`,
      ];
      for (const rsUrl of endpointsToTry) {
        try {
          const res = await fetch(rsUrl, { headers });
          const shortUrl = rsUrl.replace(RS_BASE, '');
          triedUrls.push({ url: shortUrl, status: res.status });
          if (res.ok) {
            const data = await res.json();
            bsList = data.playerBoxScores || data.boxScores || data.performances || data.items || (Array.isArray(data) ? data : []);
            try {
              await env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at')
                .bind(cacheKey, JSON.stringify(bsList), now).run();
            } catch(e) {}
            break;
          }
        } catch(e) {
          triedUrls.push({ url: rsUrl.replace(RS_BASE, ''), error: e.message });
        }
      }
    }

    if (!bsList || bsList.length === 0) {
      return new Response(JSON.stringify({ ok: false, url: null, debug: { tried: triedUrls, entityId, sport, season, day } }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const match = bsList.find(function(b) {
      const d = b.day || b.date || b.gameDate || b.scheduledAt || b.startTime || '';
      return d.startsWith(day) || d.replace('T', ' ').startsWith(day);
    });
    // Try every plausible field name RS might use for the boxscore entity ID
    const perfId = match && (
      match.playerBoxScoreId || match.playerBoxscoreId ||
      match.boxScoreId       || match.boxscoreId       ||
      match.id               || match.entityId          ||
      match.performanceId    || match.gameId            ||
      match.bsId             || match.recordId
    );
    const numPerfId = perfId ? (typeof perfId === 'number' ? perfId : parseInt(perfId, 10)) : null;
    const perfHash = numPerfId ? rsUrlEncode(14, 0, 0, numPerfId) : null;
    return new Response(JSON.stringify({
      ok: true,
      url: perfHash ? 'https://www.realapp.com/' + perfHash : null,
      debug: { tried: triedUrls, bsCount: bsList.length, day, perfId, sampleKeys: match ? Object.keys(match) : (bsList[0] ? Object.keys(bsList[0]) : []), sample: bsList[0] || null }
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  // Bundle: return all D1-cached earnings for a user's passes in one response (avoids 600 individual fetches on reload)
  if (action === 'earnings_bundle') {
    const userId = url.searchParams.get('userId');
    if (!userId) return fail(400, 'Missing userId');

    let passes = [];
    try {
      const passesRow = await env.DB.prepare('SELECT data FROM odds_cache WHERE cache_key=?')
        .bind(`otd_passes_all_v9_${userId}`).first();
      if (passesRow) {
        const pd = JSON.parse(passesRow.data);
        passes = pd.passes || [];
      }
    } catch(e) {}

    if (!passes.length) {
      return new Response(JSON.stringify({ ok: true, earnings: {}, cached: 0, total: 0 }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Map cache key → array of bundle keys (one cache entry serves all levels of same player+sport+season)
    const RS_SEASON_NORMALIZE_BUNDLE = { ufc: 'alltime', mma: 'alltime' };
    const RS_SPORT_ALIAS_BUNDLE = { mma: 'ufc' };
    const keyToIds = {};
    for (const p of passes) {
      const seasonKey = RS_SEASON_NORMALIZE_BUNDLE[p.sport] || p.season;
      const sportKey = RS_SPORT_ALIAS_BUNDLE[p.sport] || p.sport;
      const cacheKey = `otd_earnings_v10_${p.entityType || 'player'}_${sportKey}_${seasonKey}_${p.playerId}`;
      const bundleKey = `${p.playerId}|${p.sport}|${p.season}|${p.level}|${p.entityType || 'player'}`;
      if (!keyToIds[cacheKey]) keyToIds[cacheKey] = [];
      keyToIds[cacheKey].push(bundleKey);
    }
    const cacheKeys = Object.keys(keyToIds);

    // Batch query D1 in chunks of 100 (SQLite bind param limit)
    const earningsMap = {};
    const CHUNK = 100;
    for (let i = 0; i < cacheKeys.length; i += CHUNK) {
      const chunk = cacheKeys.slice(i, i + CHUNK);
      try {
        const placeholders = chunk.map(() => '?').join(',');
        const rows = await env.DB.prepare(
          `SELECT cache_key, data FROM odds_cache WHERE cache_key IN (${placeholders})`
        ).bind(...chunk).all();
        for (const row of (rows.results || [])) {
          const ids = keyToIds[row.cache_key];
          if (ids) {
            try {
              const data = JSON.parse(row.data);
              const cached = { earnings: data.earnings || [], baseTotal: data.baseTotal ?? null };
              for (const id of ids) earningsMap[id] = cached;
            } catch(e) {}
          }
        }
      } catch(e) {}
    }

    return new Response(JSON.stringify({
      ok: true,
      earnings: earningsMap,
      cached: Object.keys(earningsMap).length,
      total: cacheKeys.length
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  // Earnings: get all OTD claimable dates for a player/team at a rarity level
  if (action === 'earnings') {
    const id = url.searchParams.get('id');
    const sport = url.searchParams.get('sport') || 'mlb';
    const season = url.searchParams.get('season') || '2026';
    const level = parseInt(url.searchParams.get('level') || '1', 10);
    const entityType = url.searchParams.get('entityType') || 'player';
    if (!id) return fail(400, 'Missing id');

    const force = url.searchParams.get('force') === '1';
    const RS_SPORT_ALIAS = { ncaabb: 'ncaam', mma: 'ufc' };
    // UFC is all-time — normalize season in cache key so all seasons converge to one entry
    const RS_SEASON_NORMALIZE = { ufc: 'alltime' };
    const sportKey = RS_SPORT_ALIAS[sport] || sport;
    const seasonKey = RS_SEASON_NORMALIZE[sport] || season;
    const cacheKey = `otd_earnings_v10_${entityType}_${sportKey}_${seasonKey}_${id}`;
    const currentYear = String(new Date().getFullYear());
    const isActiveSeason = seasonKey === currentYear || seasonKey === 'alltime';
    // Active season: 1-day TTL (earnings grow daily). Past seasons: permanent.
    const earningsTTL = isActiveSeason ? 86400 : Infinity;
    if (!force) {
      try {
        const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
        if (cached && (!isActiveSeason || (now - cached.fetched_at) < earningsTTL)) {
          return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
        }
      } catch(e) {}
    }

    // Global rate limiter — cap concurrent RS calls across all CF worker instances.
    // Scales with pool size: each token supports ~8 concurrent RS calls.
    const MAX_RS = poolTokens.length * 5;
    const RATE_KEY = 'rs_rate_active';
    try { await env.DB.prepare(`INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES (?,?,0)`).bind(RATE_KEY, '0').run(); } catch(e) {}
    // Reset leaked slots: if counter > 0 but no claim has landed in >60s, a CF worker crashed
    // without releasing. Reset to 0 so new requests can proceed.
    await env.DB.prepare(
      `UPDATE odds_cache SET data='0' WHERE cache_key=? AND CAST(data AS INTEGER)>0 AND fetched_at<?`
    ).bind(RATE_KEY, now - 60).run().catch(() => {});
    const rateClaim = await env.DB.prepare(
      `UPDATE odds_cache SET data=CAST(CAST(data AS INTEGER)+1 AS TEXT),fetched_at=? WHERE cache_key=? AND CAST(data AS INTEGER)<${MAX_RS}`
    ).bind(now, RATE_KEY).run();
    if (!rateClaim.meta.changes) return fail(429, 'RS rate limit: try again shortly');

    try {
      const RS_EARN_SPORT_MAP = { ncaabb: 'ncaam', mma: 'ufc' };
      const rsSport = RS_EARN_SPORT_MAP[sport] || sport;
      const earningsUrl = `${RS_BASE}/userpassearnings/${rsSport}/season/${season}/entity/${entityType}/${id}?level=1`;

      async function rsGet(hdrs) {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 8000);
        try { return await fetch(earningsUrl, { headers: hdrs, signal: c.signal }); }
        finally { clearTimeout(t); }
      }

      let usedToken = pickToken();
      let res = await rsGet(buildHeadersWithToken(usedToken));

      // RS 429: retry up to 3 times with exponential backoff (same token — RS throttle, not auth issue)
      const retryDelays = [500, 1500, 3000];
      for (let i = 0; i < retryDelays.length && res.status === 429; i++) {
        await new Promise(r => setTimeout(r, retryDelays[i]));
        res = await rsGet(buildHeadersWithToken(usedToken));
      }

      // RS 401: token expired — try every other token in the pool before giving up
      if (res.status === 401 && poolTokens.length > 1) {
        for (const fallbackToken of poolTokens.filter(t => t !== usedToken)) {
          res = await rsGet(buildHeadersWithToken(fallbackToken));
          if (res.status !== 401) { usedToken = fallbackToken; break; }
        }
      }

      if (!res.ok) return fail(res.status, 'RS earnings failed: ' + res.status);

      const data = await res.json();
      const earnings = data.earnings || data.events || data.performances || data.playerEarnings || data.earningDays ||
        (Array.isArray(data.data) ? data.data : null) ||
        (Array.isArray(data.results) ? data.results : null) ||
        (Array.isArray(data.items) ? data.items : null) ||
        (Array.isArray(data) ? data : []);

      // RS returns info.total = "This season" base earnings (raw points, no multiplier)
      const baseTotal = (data.info && typeof data.info.total === 'number') ? data.info.total : null;

      const rawSample = earnings[0] || null;
      const rawKeys = earnings.length === 0 ? Object.keys(data) : undefined;
      const body = JSON.stringify({ ok: true, earnings, baseTotal, rawSample, rawKeys });
      if (earnings.length > 0) {
        try {
          await env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at')
            .bind(cacheKey, body, now).run();
        } catch(e) {}
      }
      return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    } finally {
      // Release slot — MAX(0,...) prevents counter going negative if a worker crashed
      await env.DB.prepare(
        `UPDATE odds_cache SET data=CAST(MAX(0,CAST(data AS INTEGER)-1) AS TEXT) WHERE cache_key=?`
      ).bind(RATE_KEY).run().catch(() => {});
    }
  }

  // Player profile: get name/team from player ID
  if (action === 'player') {
    const id = url.searchParams.get('id');
    const sport = url.searchParams.get('sport') || 'mlb';
    if (!id) return fail(400, 'Missing id');

    const cacheKey = `otd_player_${sport}_${id}`;
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < 86400) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
      }
    } catch(e) {}

    try {
      const res = await fetch(`${RS_BASE}/players/${id}/sport/${sport}`, { headers });
      if (!res.ok) return fail(res.status, 'RS player failed: ' + res.status);
      const data = await res.json();
      const p = data.player || {};
      const body = JSON.stringify({ ok: true, player: { id: p.id, name: (p.firstName || '') + ' ' + (p.lastName || ''), sport, teamId: p.teamId, position: p.position } });
      try {
        await env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at')
          .bind(cacheKey, body, now).run();
      } catch(e) {}
      return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    } catch(e) {
      return fail(500, e.message);
    }
  }

  // Search RS users by username
  if (action === 'search_users') {
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 2) return fail(400, 'Query too short');

    const cacheKey = 'otd_usersearch_v2_' + q.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < 300) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
      }
    } catch(e) {}

    try {
      const res = await fetch(`${RS_BASE}/searchusers?query=${encodeURIComponent(q)}`, { headers });
      if (!res.ok) return fail(res.status, 'RS user search failed: ' + res.status);
      const data = await res.json();

      const raw = Array.isArray(data) ? data : (data.users || data.results || []);
      const users = raw.slice(0, 10).map(u => ({
        id: u.id || u.userId,
        username: u.userName || u.username || u.handle || u.id,
        displayName: null,
        avatar: u.avatarKey || u.avatar
      })).filter(u => u.id);

      const body = JSON.stringify({ ok: true, users });
      try {
        await env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at')
          .bind(cacheKey, body, now).run();
      } catch(e) {}
      return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    } catch(e) {
      return fail(500, e.message);
    }
  }

  // Admin debug: dump first raw pass object in full so we can find card image URL fields
  if (action === 'debug_raw_pass') {
    if (!session.is_admin) return fail(403, 'Admin only');
    let userId = url.searchParams.get('userId');
    const season = url.searchParams.get('season') || String(new Date().getFullYear());
    if (!userId) return fail(400, 'Missing userId');
    // Resolve username → RS internal user ID (alphanumeric, e.g. "9JmLj7Rn")
    const srRes = await fetch(`${RS_BASE}/searchusers?query=${encodeURIComponent(userId)}`, { headers });
    if (srRes.ok) {
      const srData = await srRes.json();
      const srUsers = Array.isArray(srData) ? srData : (srData.users || srData.results || []);
      const match = srUsers.find(u => (u.userName || u.username || '').toLowerCase() === userId.toLowerCase());
      if (match) userId = match.id || match.userId || userId;
    }
    const res = await fetch(`${RS_BASE}/userpasses/${encodeURIComponent(userId)}/passes?entityType=player&season=${season}`, { headers });
    if (!res.ok) return fail(res.status, `RS error ${res.status} userId=${userId}`);
    const data = await res.json();
    const raw = Array.isArray(data) ? data : (data.passes || data.items || data.collectingCards || []);
    // Return first 2 passes in full — looking for any image/card/thumbnail URL fields
    return new Response(JSON.stringify({ count: raw.length, resolvedUserId: userId, passes: raw.slice(0, 2) }, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }

  // Debug: test whether RS accepts comma-separated seasons in one call
  if (action === 'debug_multi_season') {
    if (!session.is_admin) return fail(403, 'Admin only');
    const userId = url.searchParams.get('userId');
    const seasonParam = url.searchParams.get('seasons') || '2022,2023';
    if (!userId) return fail(400, 'Missing userId');
    const res = await fetch(`${RS_BASE}/userpasses/${encodeURIComponent(userId)}/passes?entityType=player&season=${encodeURIComponent(seasonParam)}`, { headers });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch(e) { parsed = text; }
    const count = Array.isArray(parsed) ? parsed.length : (parsed.passes || parsed.items || []).length;
    return new Response(JSON.stringify({ status: res.status, seasonParam, count, sample: Array.isArray(parsed) ? parsed.slice(0,2) : (parsed.passes||parsed.items||[]).slice(0,2) }, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }

  // Fetch ALL passes for an RS user across all sports and seasons — batched to avoid rate limiting
  // Debug: return raw RS pass fields for a user to diagnose missing passes
  if (action === 'debug_passes') {
    const userId = url.searchParams.get('userId');
    const season = url.searchParams.get('season') || String(new Date().getFullYear() - 1);
    if (!userId) return fail(400, 'Missing userId');
    try {
      const [playerRes, teamRes] = await Promise.all([
        fetch(`${RS_BASE}/userpasses/${encodeURIComponent(userId)}/passes?entityType=player&season=${season}`, { headers }),
        fetch(`${RS_BASE}/userpasses/${encodeURIComponent(userId)}/passes?entityType=team&season=${season}`, { headers })
      ]);
      const playerData = playerRes.ok ? await playerRes.json() : { error: playerRes.status };
      const teamData = teamRes.ok ? await teamRes.json() : { error: teamRes.status };
      const playerRaw = Array.isArray(playerData) ? playerData : (playerData.passes || playerData.items || playerData.collectingCards || []);
      const teamRaw = Array.isArray(teamData) ? teamData : (teamData.passes || teamData.items || teamData.collectingCards || []);
      const summarize = (arr) => arr.slice(0, 30).map(p => ({
        id: p.entityId || p.playerId || (p.entity||p.player||p.team||{}).id,
        name: p.label || ((p.entity||p.player||p.team||{}).firstName ? ((p.entity||p.player||p.team||{}).firstName+' '+(p.entity||p.player||p.team||{}).lastName).trim() : (p.entity||p.player||p.team||{}).name),
        sport: p.sport,
        entitySport: (p.entity||p.player||p.team||{}).sport,
        season: p.season,
        rarity: p.rarity || p.rarityName,
        entityRarity: (p.entity||p.player||p.team||{}).rarity || (p.entity||p.player||p.team||{}).rarityName,
        rarityLevel: p.rarityLevel || p.subLevel,
        level: p.level,
        collectingLevel: p.collectingLevel,
      }));
      return new Response(JSON.stringify({ playerCount: playerRaw.length, teamCount: teamRaw.length, players: summarize(playerRaw), teams: summarize(teamRaw) }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    } catch(e) { return fail(500, e.message); }
  }

  if (action === 'user_passes_all') {
    const userId = url.searchParams.get('userId');
    if (!userId) return fail(400, 'Missing userId');

    // Query by season only — no sport filter so RS returns all passes regardless of sport.
    // 5 seasons × 2 entity types = 10 parallel calls (vs 110 sport-filtered calls that RS rate-limits).
    const force = url.searchParams.get('force') === '1';
    const cacheKey = `otd_passes_all_v9_${userId}`;
    if (!force) {
      try {
        const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
        if (cached && (now - cached.fetched_at) < 7200) {
          return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
        }
      } catch(e) {}
    }

    const yr = new Date().getFullYear();
    // All sports only go back to 2022. Golf goes back to 2015 but is fetched separately below.
    const seasons = [];
    for (let y = yr; y >= 2022; y--) seasons.push(y);
    const golfSeasons = [];
    for (let y = 2021; y >= 2015; y--) golfSeasons.push(y);

    // Parse RS rarityLabel strings like "Iconic 1", "Mystic 3", "Legendary 2" → our level number.
    // This is the most reliable source: RS uses it in their own UI and it's unambiguous.
    function rarityLabelToLevel(label) {
      if (!label) return 0;
      const l = label.toLowerCase().trim();
      if (l === 'general')   return 0;
      if (l === 'common')    return 1;
      if (l === 'uncommon')  return 2;
      if (l === 'rare')      return 3;
      if (l === 'epic')      return 4;
      const m = l.match(/^(legendary|mystic|iconic)(?:\s+(\d+))?$/);
      if (!m) return 0;
      const n = parseInt(m[2] || '1', 10);
      if (m[1] === 'legendary') return 4 + n;
      if (m[1] === 'mystic')    return 9 + n;
      if (m[1] === 'iconic')    return 19 + n;
      return 0;
    }

    function rarityToLevelAll(rarity, rarityLevel) {
      const r = (rarity || '').toLowerCase();
      const rl = Math.max(1, parseInt(rarityLevel || 1, 10));
      if (r === 'general')   return 0;
      if (r === 'common')    return 1;
      if (r === 'uncommon')  return 2;
      if (r === 'rare')      return 3;
      if (r === 'epic')      return 4;
      if (r === 'legendary') return 4 + rl;
      if (r === 'mystic')    return 9 + rl;
      if (r === 'iconic')    return 19 + rl;
      return 0;
    }

    function extractPasses(data, entityType, fallbackSeason) {
      const raw = Array.isArray(data) ? data : (data.passes || data.items || data.collectingCards || []);
      const results = [];
      for (const p of raw) {
        const entity = p.entity || p.player || p.team || {};
        const bi = p.boostInfo || {};
        const playerId = p.entityId || p.playerId || entity.id;
        const playerName = p.label
          || (entity.firstName && entity.lastName ? (entity.firstName + ' ' + entity.lastName).trim() : null)
          || entity.name || entity.displayName || null;
        const sport = p.sport || entity.sport || null;
        const season = String(p.season || fallbackSeason);
        // RS does not expose rarity as a top-level string — it lives in boostInfo.
        // boostInfo.rarityLabel ("Iconic 1", "Mystic 3", etc.) is the most reliable source.
        // boostInfo.level is a direct numeric level (20 for Iconic 1) and matches our system.
        // boostInfo.multiplier is the ACTIVE SEASON multiplier — intentionally ignored here.
        const labelLevel = rarityLabelToLevel(bi.rarityLabel);
        const rarityStr = p.rarity || p.rarityName || entity.rarity || entity.rarityName || '';
        const raritySubLevel = p.rarityLevel || p.subLevel || entity.rarityLevel || entity.subLevel;
        const rarityStrLevel = rarityToLevelAll(rarityStr, raritySubLevel);
        const level = labelLevel > 0 ? labelLevel
          : rarityStrLevel > 0 ? rarityStrLevel
          : (typeof bi.level === 'number' && bi.level > 0) ? bi.level
          : typeof p.level === 'number' ? p.level
          : typeof p.collectingLevel === 'number' ? p.collectingLevel
          : 0;
        if (playerId && sport && level >= 1) {
          results.push({
            playerId, playerName, sport, season, level, entityType,
            passId:           p.id || null,
            avatar:           entity.avatar || null,
            entityAvatar:     p.entityAvatar || entity.entityAvatar || null,
            backgroundSource: p.backgroundSource || null,
            rarityColor:      bi.rarityColor || p.rarityColor || null,
            serialNumber:     p.serialNumber || null,
          });
        }
      }
      return results;
    }

    try {
      const passMap = {};

      const fetchSeasons = async (seasonList, sportFilter) => {
        for (const season of seasonList) {
          try {
            const sportParam = sportFilter ? `&sport=${sportFilter}` : '';
            const fetches = sportFilter
              ? [fetch(`${RS_BASE}/userpasses/${encodeURIComponent(userId)}/passes?entityType=player&season=${season}${sportParam}`, { headers })]
              : [
                  fetch(`${RS_BASE}/userpasses/${encodeURIComponent(userId)}/passes?entityType=player&season=${season}`, { headers }),
                  fetch(`${RS_BASE}/userpasses/${encodeURIComponent(userId)}/passes?entityType=team&season=${season}`, { headers })
                ];
            const entityTypes = sportFilter ? ['player'] : ['player', 'team'];
            const responses = await Promise.all(fetches);
            for (let j = 0; j < responses.length; j++) {
              const res = responses[j];
              if (!res.ok) {
                if (res.status === 429) throw new Error('429');
                continue;
              }
              try {
                const data = await res.json();
                for (const pass of extractPasses(data, entityTypes[j], season)) {
                  const key = `${pass.playerId}|${pass.sport}|${pass.season}`;
                  passMap[key] = pass;
                }
              } catch(e) {}
            }
          } catch(e) {
            if (e.message === '429') throw e;
          }
          await new Promise(r => setTimeout(r, 400));
        }
      };

      await fetchSeasons(seasons, null);         // 2022–now newest→oldest, stops on first empty season
      await fetchSeasons(golfSeasons, 'golf');   // 2015–2021 golf only, stops on first empty season

      const passes = Object.values(passMap);
      const body = JSON.stringify({ ok: true, passes });
      if (passes.length > 0) {
        try {
          await env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at')
            .bind(cacheKey, body, now).run();
        } catch(e) {}
      }
      return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    } catch(e) {
      if (e.message === '429') {
        const partial = Object.values(passMap);
        return new Response(JSON.stringify({ ok: true, passes: partial, partial: true }), { headers: { 'Content-Type': 'application/json' } });
      }
      return fail(500, e.message);
    }
  }

  // Fetch all passes for an RS user in a given sport + season
  if (action === 'user_passes') {
    const userId = url.searchParams.get('userId');
    const sport  = url.searchParams.get('sport') || 'mlb';
    const season = url.searchParams.get('season') || String(new Date().getFullYear());
    if (!userId) return fail(400, 'Missing userId');

    const cacheKey = `otd_passes_v6_${userId}_${sport}_${season}`;
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < 7200) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
      }
    } catch(e) {}

    try {
      // Fetch player passes and team passes in parallel
      const [playerRes, teamRes] = await Promise.all([
        fetch(`${RS_BASE}/userpasses/${encodeURIComponent(userId)}/passes?entityType=player&season=${season}&sport=${sport}`, { headers }),
        fetch(`${RS_BASE}/userpasses/${encodeURIComponent(userId)}/passes?entityType=team&season=${season}&sport=${sport}`, { headers })
      ]);

      function rarityLabelToLvl(label) {
        if (!label) return 0;
        const l = label.toLowerCase().trim();
        if (l === 'general')   return 0;
        if (l === 'common')    return 1;
        if (l === 'uncommon')  return 2;
        if (l === 'rare')      return 3;
        if (l === 'epic')      return 4;
        const m = l.match(/^(legendary|mystic|iconic)(?:\s+(\d+))?$/);
        if (!m) return 0;
        const n = parseInt(m[2] || '1', 10);
        if (m[1] === 'legendary') return 4 + n;
        if (m[1] === 'mystic')    return 9 + n;
        if (m[1] === 'iconic')    return 19 + n;
        return 0;
      }

      function extractPasses(res, entityType) {
        if (!res.ok) return [];
        return res.json().then(data => {
          const raw = Array.isArray(data) ? data : (data.passes || data.items || data.collectingCards || []);
          return raw.map(p => {
            const entity = p.entity || p.player || p.team || {};
            const bi = p.boostInfo || {};
            const playerId = p.entityId || p.playerId || entity.id;
            const playerName = p.label
              || (entity.firstName && entity.lastName ? (entity.firstName + ' ' + entity.lastName).trim() : null)
              || entity.name || entity.displayName || null;
            const labelLevel = rarityLabelToLvl(bi.rarityLabel);
            const level = labelLevel > 0 ? labelLevel
              : (typeof bi.level === 'number' && bi.level > 0) ? bi.level
              : typeof p.level === 'number' ? p.level
              : typeof p.collectingLevel === 'number' ? p.collectingLevel
              : 0;
            return { playerId, playerName, sport: p.sport || sport, season: String(p.season || season), level, entityType, passId: p.id || null };
          }).filter(p => p.playerId && p.level >= 1);
        }).catch(() => []);
      }

      const [playerPasses, teamPasses] = await Promise.all([
        extractPasses(playerRes, 'player'),
        extractPasses(teamRes, 'team')
      ]);

      const passes = [...playerPasses, ...teamPasses];
      const body = JSON.stringify({ ok: true, passes });
      try {
        await env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at')
          .bind(cacheKey, body, now).run();
      } catch(e) {}
      return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    } catch(e) {
      return fail(500, e.message);
    }
  }

  // All passes that earned on a given OTD day — uses the requesting user's own RS token
  // so cardhistoricalearnings returns their personal card collection, not the shared token's
  if (action === 'day_earnings') {
    const day = url.searchParams.get('day');
    if (!day) return fail(400, 'Missing day');

    // Build headers with user's own RS token if they've connected their account
    let dayHeaders = { ...buildHeaders(env) };
    const userId = session.user_id;
    const cacheUserKey = userId ? String(userId) : 'shared';
    if (userId) {
      try {
        const userAuth = await env.DB.prepare('SELECT auth_token FROM real_auth WHERE user_id=?').bind(userId).first();
        if (userAuth && userAuth.auth_token) {
          dayHeaders['real-auth-info'] = userAuth.auth_token;
        }
      } catch(e) {}
    }

    // Cache per user so different users' card collections don't collide
    const cacheKey = `otd_day_earns_v3_${cacheUserKey}_${day}`;
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < 300) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
      }
    } catch(e) {}

    try {
      const res = await fetch(`${RS_BASE}/cardhistoricalearnings?day=${encodeURIComponent(day)}`, { headers: dayHeaders });
      if (!res.ok) return fail(res.status, 'RS day_earnings failed: ' + res.status);
      const data = await res.json();

      const entries = [];
      for (const sg of (data.sportEarnings || [])) {
        for (const p of (sg.passEarnings || [])) {
          const sportCode = RS_SPORT_CODE[p.sport] || 0;
          const cardHash = p.id ? rsUrlEncode(18, sportCode, 0, p.id) : null;
          const perfId = p.performances && p.performances[0];
          const perfHash = perfId ? rsUrlEncode(14, 0, 0, perfId) : null;
          entries.push({
            entityId: p.entityId,
            entityType: p.entityType,
            sport: p.sport,
            cardUrl: cardHash ? 'https://www.realapp.com/' + cardHash : null,
            perfUrl: perfHash ? 'https://www.realapp.com/' + perfHash : null
          });
        }
      }

      const body = JSON.stringify({ ok: true, entries });
      try {
        await env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at')
          .bind(cacheKey, body, now).run();
      } catch(e) {}
      return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    } catch(e) {
      return fail(500, e.message);
    }
  }

  // Admin: probe the exact RS multiplier for every sport+level combo found in D1 pass caches.
  // Derives multiplier from RS earnings API by computing atRarityEarnings/earnings for
  // the first valid event. (UFC RS earnings returns 500 — skipped.)
  // Stores the complete table in D1 as meta:otd_sport_multipliers.
  if (action === 'probe_multipliers') {
    if (!session.is_admin) return fail(403, 'Admin only');

    const RS_EARN_SPORT_MAP = { ncaabb: 'ncaam', mma: 'ufc' };
    const RS_SEASON_NORM = { ufc: 'alltime' };

    // Collect all user pass caches
    const passRows = await env.DB.prepare(
      "SELECT data FROM odds_cache WHERE cache_key LIKE 'otd_passes_all_v9_%'"
    ).all();

    // Build map: 'sport:level' -> one representative pass
    const comboMap = {};
    for (const row of (passRows.results || [])) {
      let pd;
      try { pd = JSON.parse(row.data); } catch(e) { continue; }
      for (const p of (pd.passes || [])) {
        if (!p.playerId || !p.sport || p.level == null) continue;
        const k = `${p.sport}:${p.level}`;
        if (!comboMap[k]) comboMap[k] = p;
      }
    }

    const results = {};
    const errors = {};

    // Derive multiplier from RS earnings API for all combos.
    const needsEarnings = Object.entries(comboMap);
    for (const [key, p] of needsEarnings) {
      const rsSport = RS_EARN_SPORT_MAP[p.sport] || p.sport;
      const rsSeason = RS_SEASON_NORM[p.sport] || p.season;
      const entityType = p.entityType || 'player';
      const earningsUrl = `${RS_BASE}/userpassearnings/${rsSport}/season/${rsSeason}/entity/${entityType}/${p.playerId}?level=${p.level}`;

      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        let res;
        try { res = await fetch(earningsUrl, { headers: buildHeadersWithToken(pickToken()), signal: ctrl.signal }); }
        finally { clearTimeout(t); }

        if (!res.ok) { errors[key] = res.status; continue; }
        const data = await res.json();
        const evts = data.earnings || data.events || data.performances || data.playerEarnings ||
          (Array.isArray(data.data) ? data.data : null) ||
          (Array.isArray(data.results) ? data.results : null) ||
          (Array.isArray(data) ? data : []);

        let found = false;
        for (const ev of evts) {
          const base = ev.earnings || 0;
          const rar = ev.atRarityEarnings || 0;
          if (base > 0 && rar > 0) {
            results[key] = Math.round((rar / base) * 100) / 100;
            found = true;
            break;
          }
        }
        if (!found) errors[key] = 'no valid event';
      } catch(e) {
        errors[key] = e.message;
      }

      await new Promise(r => setTimeout(r, 200));
    }

    // Store results permanently in D1
    await env.DB.prepare(
      "INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,9999999999) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at"
    ).bind('meta:otd_sport_multipliers', JSON.stringify(results)).run();

    return new Response(JSON.stringify({ ok: true, probed: Object.keys(comboMap).length, found: Object.keys(results).length, results, errors }, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }

  if (action === 'leaderboard') {
    const sport = url.searchParams.get('sport') || 'mlb';
    const season = url.searchParams.get('season') || String(new Date().getFullYear());
    const allTime = url.searchParams.get('alltime') === '1';
    const entityType = url.searchParams.get('entityType') || 'player';
    const RS_SPORT_ALIAS_LB = { ncaabb: 'ncaam', mma: 'ufc' };
    const RS_SEASON_NORM_LB = { ufc: 'alltime', mma: 'alltime' };
    const sportKey = RS_SPORT_ALIAS_LB[sport] || sport;
    const isAlwaysAllTime = !!RS_SEASON_NORM_LB[sportKey];
    const effectiveAllTime = allTime || isAlwaysAllTime;

    const lbCacheKey = `otd_lb_v11_${entityType}_${sportKey}_${effectiveAllTime ? 'alltime' : season}`;
    if (url.searchParams.get('force') !== '1') {
      try {
        const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(lbCacheKey).first();
        if (cached && (now - cached.fetched_at) < 604800) {
          return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
        }
      } catch(e) {}
    }

    function bId(id) { return String(id).replace(/_l\d+$/, ''); }

    async function fetchShopSection(section, maxCount = 200, seasonOverride) {
      const useSeason = seasonOverride || season;
      const results = [];
      let cursor = 0;
      const maxPages = Math.ceil(maxCount / 20) + 2;
      for (let page = 0; page < maxPages && results.length < maxCount; page++) {
        try {
          const u = `${RS_BASE}/userpassshop/${sportKey}/season/${useSeason}/entity/${entityType}/section/${section}?before=${cursor}`;
          const c = new AbortController();
          const t = setTimeout(() => c.abort(), 8000);
          let res;
          try { res = await fetch(u, { headers, signal: c.signal }); }
          finally { clearTimeout(t); }
          if (!res.ok) break;
          const data = await res.json();
          const items = data.passes || data.items || data.cards || (Array.isArray(data) ? data : []);
          if (!items.length) break;
          for (const p of items) results.push(p);
          cursor = results.length; // sequential offset: before=0, before=20, before=40...
          if (data.hasMore === false) break;
          if (items.length < 3) break; // real end of data
        } catch(e) { break; }
      }
      return results;
    }

    // Fetch earningstotal (BASE RAX, primary ranking) and hotseason (OWNERS) in parallel.
    // hotseason fetches 500 items so its coverage overlaps well with earningstotal top 200
    // (the two lists rank differently — a player ranked 180 in earnings may be ranked 300 in owners).
    // For alltime: skip earningstotal (use D1 instead) but still fetch hotseason for current year so owners show.
    const currentSeasonStr = String(new Date().getFullYear());
    const [earningsPasses, ownerPasses] = effectiveAllTime
      ? [[], await fetchShopSection('hotseason', 200, currentSeasonStr)]
      : await Promise.all([fetchShopSection('earningstotal', 200), fetchShopSection('hotseason', 500)]);

    // For alltime: seed nameMap from all historically relevant seasons.
    // 3 pages for recent 3 years (top 60 each), 1 page for older years (top 20 each).
    // Golf goes back to 2015; all other sports go back to 2022.
    let allTimeNameItems = [];
    if (effectiveAllTime) {
      const currentYear = new Date().getFullYear();
      const sportMinYear = sportKey === 'golf' ? 2015 : 2022;
      const nameFetches = [];
      for (let y = currentYear; y >= sportMinYear; y--) {
        const numPages = y >= currentYear - 2 ? 3 : 1;
        for (let pg = 0; pg < numPages; pg++) {
          const before = pg * 20;
          const u = `${RS_BASE}/userpassshop/${sportKey}/season/${y}/entity/${entityType}/section/earningstotal?before=${before}`;
          const c = new AbortController();
          const t = setTimeout(() => c.abort(), 6000);
          nameFetches.push(fetch(u, { headers, signal: c.signal }).then(r => { clearTimeout(t); return r.ok ? r.json() : null; }).catch(() => null));
        }
      }
      const nameResults = await Promise.all(nameFetches);
      for (const data of nameResults) {
        if (!data) continue;
        const items = data.passes || data.items || data.cards || (Array.isArray(data) ? data : []);
        for (const p of items) allTimeNameItems.push(p);
      }
    }

    // ownerMap: playerId → owner count value from hotseason
    const ownerMap = {};
    for (const p of ownerPasses) {
      const bid = bId(String(p.id || p.entityId || ''));
      if (bid && p.value != null) ownerMap[bid] = p.value;
    }

    const shopPasses = earningsPasses; // primary list ranked by earnings

    // ── Build name map + iconic sets from D1 pass caches ────────────────────
    const nameMap = {};
    // Merge alltime name items fetched from recent shop pages
    for (const p of allTimeNameItems) {
      const bid = bId(String(p.id || p.entityId || ''));
      const name = p.label || p.playerName || p.name || p.displayName || null;
      if (bid && name) nameMap[bid] = name;
    }
    const iconicSets = {}; // baseId → Set of RaxEdge userIds at level >= 20
    const passRows = await env.DB.prepare("SELECT cache_key, data FROM odds_cache WHERE cache_key LIKE 'otd_passes_all_v9_%'").all().catch(() => ({ results: [] }));
    for (const row of (passRows.results || [])) {
      const userId = row.cache_key.replace('otd_passes_all_v9_', '');
      try {
        const pd = JSON.parse(row.data);
        for (const p of (pd.passes || [])) {
          if (!p.playerId) continue;
          const bid = bId(p.playerId);
          // Only use name if it matches the current sport — different sports can share the same entity ID
          if (p.playerName && !nameMap[bid] && p.sport === sportKey) nameMap[bid] = p.playerName;
          if (p.sport !== sportKey) continue;
          if (!effectiveAllTime && String(p.season) !== season) continue;
          if ((p.level || 0) >= 20) {
            if (!iconicSets[bid]) iconicSets[bid] = new Set();
            iconicSets[bid].add(userId);
          }
        }
      } catch(e) {}
    }

    // ── Batch-load D1 earnings for baseTotal ────────────────────────────────
    const earningsPrefix = `otd_earnings_v10_${entityType}_${sportKey}_`;
    const earningsPattern = effectiveAllTime ? earningsPrefix + '%' : earningsPrefix + season + '_%';
    const earningsRows = await env.DB.prepare('SELECT cache_key, data FROM odds_cache WHERE cache_key LIKE ?').bind(earningsPattern).all().catch(() => ({ results: [] }));

    const seasonMaxes = {}; // `${baseId}:${seasonPart}` → max baseTotal (de-dupe _l20 etc.)
    for (const row of (earningsRows.results || [])) {
      const rest = row.cache_key.slice(earningsPrefix.length);
      const uidx = rest.indexOf('_');
      if (uidx < 0) continue;
      const seasonPart = rest.slice(0, uidx);
      const bid = bId(rest.slice(uidx + 1));
      if (!bid) continue;
      try {
        const data = JSON.parse(row.data);
        const total = typeof data.baseTotal === 'number' && data.baseTotal > 0
          ? data.baseTotal
          : (data.earnings || []).reduce((s, e) => s + (e.earnings || 0), 0);
        if (!total) continue;
        const sk = bid + ':' + seasonPart;
        if (!seasonMaxes[sk] || total > seasonMaxes[sk]) seasonMaxes[sk] = total;
      } catch(e) {}
    }
    const earningsTotals = {}; // baseId → summed baseTotal across seasons
    for (const [sk, v] of Object.entries(seasonMaxes)) {
      const bid = sk.slice(0, sk.indexOf(':'));
      earningsTotals[bid] = (earningsTotals[bid] || 0) + v;
    }

    // ── Build final list ─────────────────────────────────────────────────────
    let list;
    if (shopPasses.length > 0) {
      // earningstotal section: `value` = season base earnings total direct from RS
      // hotseason section: `value` = total RS platform owner count (from ownerMap)
      list = shopPasses.slice(0, 200).map((p, i) => {
        const bid = bId(String(p.id || p.entityId || ''));
        const name = p.label || p.playerName || p.name || p.displayName || nameMap[bid] || null;
        if (name && !nameMap[bid]) nameMap[bid] = name;
        return {
          rank: i + 1,
          playerId: bid,
          name,
          season,
          position: p.position || p.pos || null,
          total: p.value != null ? Number(p.value) : (earningsTotals[bid] || null),
          passCount: ownerMap[bid] != null ? ownerMap[bid] : null,
          iconic: iconicSets[bid] ? iconicSets[bid].size : 0,
          sport: sportKey,
          entityType: p.entityType || entityType,
        };
      });
    } else {
      // D1 fallback (alltime) — one row per (player, season), NOT summed
      list = Object.entries(seasonMaxes)
        .map(([sk, total]) => {
          const colonIdx = sk.indexOf(':');
          const bid = sk.slice(0, colonIdx);
          const seasonPart = sk.slice(colonIdx + 1);
          return { bid, season: seasonPart, total };
        })
        .filter(r => r.bid && r.total > 0)
        .sort((a, b) => b.total - a.total)
        .slice(0, 200)
        .map((r, i) => ({
          rank: i + 1,
          playerId: r.bid,
          name: nameMap[r.bid] || null,
          season: r.season,
          position: null,
          total: r.total,
          passCount: ownerMap[r.bid] != null ? ownerMap[r.bid] : null,
          iconic: iconicSets[r.bid] ? iconicSets[r.bid].size : 0,
          sport: sportKey,
          entityType,
        }));
    }

    // ── Resolve missing names ────────────────────────────────────────────────
    // earningstotal returns {id, value, entityType} only — no names.
    // 1. Check D1 otd_player_{sport}_{id} cache (populated by prior earnings lookups).
    // 2. For still-missing player IDs, fetch from RS /players/{id}/sport/{sport} in parallel.
    const unknownItems = list.filter(item => !item.name);
    if (unknownItems.length > 0) {
      // Step 1: bulk D1 lookup
      const d1PlayerRows = await env.DB.prepare(
        `SELECT cache_key, data FROM odds_cache WHERE cache_key LIKE ?`
      ).bind(`otd_player_${sportKey}_%`).all().catch(() => ({ results: [] }));
      const d1NameMap = {};
      for (const row of (d1PlayerRows.results || [])) {
        const id = row.cache_key.replace(`otd_player_${sportKey}_`, '');
        try {
          const pd = JSON.parse(row.data);
          const n = pd.player && pd.player.name ? pd.player.name.trim() : null;
          if (n) d1NameMap[id] = n;
        } catch(e) {}
      }
      for (const item of unknownItems) {
        if (d1NameMap[item.playerId]) item.name = d1NameMap[item.playerId];
      }

      // Step 2: RS API fetch for remaining unknowns (players only, cap 120 — all parallel, 5s timeout each)
      const stillUnknown = list.filter(item => !item.name && item.entityType !== 'team').slice(0, 120);
      if (stillUnknown.length > 0) {
        const rsFetches = stillUnknown.map(async item => {
          const c = new AbortController();
          const t = setTimeout(() => c.abort(), 5000);
          try {
            const res = await fetch(`${RS_BASE}/players/${item.playerId}/sport/${sportKey}`, { headers, signal: c.signal });
            clearTimeout(t);
            if (!res.ok) return null;
            const data = await res.json();
            const p = data.player || {};
            const name = ((p.firstName || '') + ' ' + (p.lastName || '')).trim() || null;
            const pos = p.position || null;
            return { id: item.playerId, name, pos };
          } catch(e) { clearTimeout(t); return null; }
        });
        const rsResults = await Promise.all(rsFetches);
        const cacheWrites = [];
        for (const r of rsResults) {
          if (!r || !r.name) continue;
          // Update list item
          const item = list.find(i => i.playerId === r.id);
          if (item) { item.name = r.name; if (r.pos && !item.position) item.position = r.pos; }
          // Cache in D1
          const ck = `otd_player_${sportKey}_${r.id}`;
          const cb = JSON.stringify({ ok: true, player: { id: r.id, name: r.name, sport: sportKey, position: r.pos } });
          cacheWrites.push(env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at').bind(ck, cb, now).run().catch(() => {}));
        }
        await Promise.all(cacheWrites);
      }
    }

    const body = JSON.stringify({ ok: true, leaderboard: list, sport: sportKey, allTime: effectiveAllTime, fromShop: shopPasses.length > 0 });
    await env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at')
      .bind(lbCacheKey, body, now).run().catch(() => {});
    return new Response(body, { headers: { 'Content-Type': 'application/json' } });
  }

  return fail(400, 'Unknown action');
}
