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

  // Leaderboard cache-only fast path — no RS token needed if D1 cache is warm.
  // Falls through to token check + full build only on cache miss.
  if (action === 'leaderboard' && url.searchParams.get('force') !== '1') {
    const sport = url.searchParams.get('sport') || 'mlb';
    const season = url.searchParams.get('season') || String(new Date().getFullYear());
    const allTime = url.searchParams.get('alltime') === '1';
    const entityType = url.searchParams.get('entityType') || 'player';

    if (sport === 'all') {
      // all-sports: handled fully below; skip fast path
    } else {
      const RS_SPORT_ALIAS_LB = { ncaabb: 'ncaam', mma: 'ufc' };
      const RS_SEASON_NORM_LB = { ufc: 'alltime', mma: 'alltime' };
      const sportKey = RS_SPORT_ALIAS_LB[sport] || sport;
      const effectiveAllTime = allTime || !!RS_SEASON_NORM_LB[sportKey];
      const lbCacheKey = `otd_lb_v24_${entityType}_${sportKey}_${effectiveAllTime ? 'alltime' : season}`;
      try {
        const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(lbCacheKey).first();
        if (cached) {
          let responseData = cached.data;
          try {
            const parsed = JSON.parse(cached.data);
            if (parsed.leaderboard) {
              let dirty = false;

              // Deduplicate alltime leaderboards in-place (UFC had both year + 'alltime' rows per fighter)
              if (effectiveAllTime) {
                const seen = {};
                const deduped = parsed.leaderboard.filter(item => {
                  if (seen[item.playerId]) return false;
                  seen[item.playerId] = true;
                  return true;
                });
                if (deduped.length !== parsed.leaderboard.length) {
                  parsed.leaderboard = deduped.map((item, i) => ({ ...item, rank: i + 1 }));
                  dirty = true;
                }
              }

              // Enrich entries that still have numeric IDs as names
              const numericNameItems = parsed.leaderboard.filter(i => !i.name || /^\d+$/.test(String(i.name).trim()));
              if (numericNameItems.length > 0) {
                // 1. Try D1 player cache first
                try {
                  const cacheKeys = numericNameItems.slice(0, 100).map(i => `otd_player_${sportKey}_${i.playerId}`);
                  const ph = cacheKeys.map(() => '?').join(',');
                  const nameRows = await env.DB.prepare(`SELECT cache_key, data FROM odds_cache WHERE cache_key IN (${ph})`).bind(...cacheKeys).all();
                  const nameMap = {};
                  for (const row of (nameRows.results || [])) {
                    try {
                      const d = JSON.parse(row.data);
                      const pid = row.cache_key.replace(`otd_player_${sportKey}_`, '');
                      const name = d.name || ((d.firstName || '') + ' ' + (d.lastName || '')).trim() || d.displayName || null;
                      if (name && !/^\d+$/.test(name)) nameMap[pid] = name;
                    } catch(e2) {}
                  }
                  for (const item of numericNameItems) {
                    if (nameMap[item.playerId]) { item.name = nameMap[item.playerId]; dirty = true; }
                  }
                } catch(e2) {}

                // 2. Still numeric after D1 lookup — call RS players API directly (up to 15 in parallel)
                const stillNumeric = numericNameItems.filter(i => !i.name || /^\d+$/.test(String(i.name).trim()));
                if (stillNumeric.length > 0 && env.REAL_AUTH_TOKEN && env.REAL_SESSION_TOKEN) {
                  const rsAuthHdrs = {
                    'Accept': 'application/json', 'Content-Type': 'application/json',
                    'Origin': 'https://www.realapp.com', 'Referer': 'https://www.realapp.com/',
                    'real-auth-info': env.REAL_AUTH_TOKEN, 'real-session-token': env.REAL_SESSION_TOKEN,
                    'real-device-uuid': env.REAL_DEVICE_UUID || '',
                    'real-device-type': 'desktop_web', 'real-version': '35',
                    'real-request-token': hashidsEncode(now),
                  };
                  await Promise.all(stillNumeric.slice(0, 15).map(async item => {
                    try {
                      const rsEntityPath = (item.entityType === 'team' || sportKey === 'ufc') ? 'teams' : 'players';
                      const r = await fetch(`${RS_BASE}/${rsEntityPath}/${item.playerId}/sport/${sportKey}`, {
                        headers: rsAuthHdrs, signal: AbortSignal.timeout(5000)
                      });
                      if (!r.ok) return;
                      const d = await r.json();
                      const top = d.team || d.player || d;
                      const name = top.name || ((top.firstName || '') + ' ' + (top.lastName || '')).trim() || top.displayName || null;
                      if (!name || /^\d+$/.test(name)) return;
                      item.name = name; dirty = true;
                      env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,9999999999) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at')
                        .bind(`otd_player_${sportKey}_${item.playerId}`, JSON.stringify({ name, id: item.playerId }), now).run().catch(() => {});
                    } catch(e2) {}
                  }));
                }
              }

              if (dirty) {
                responseData = JSON.stringify(parsed);
                env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at')
                  .bind(lbCacheKey, responseData, cached.fetched_at).run().catch(() => {});
              }
            }
          } catch(e) {}
          return new Response(responseData, { headers: { 'Content-Type': 'application/json' } });
        }
      } catch(e) {}

      // Try v16 promotion before requiring a token (with MLB position enrichment)
      try {
        const v16Key = `otd_lb_v16_${entityType}_${sportKey}_${effectiveAllTime ? 'alltime' : season}`;
        const v16 = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(v16Key).first();
        if (v16) {
          const parsed = JSON.parse(v16.data);
          if (sportKey === 'mlb' && parsed.leaderboard) {
            const pItems = parsed.leaderboard.filter(i => i.entityType !== 'team' && !i.position);
            if (pItems.length) {
              const posMap = {};
              const posKeys = pItems.map(i => `otd_mlbpos_v1_${i.playerId}`);
              try {
                const ph = posKeys.map(() => '?').join(',');
                const rows = await env.DB.prepare(`SELECT cache_key, data FROM odds_cache WHERE cache_key IN (${ph})`).bind(...posKeys).all();
                for (const row of (rows.results || [])) {
                  const pid = row.cache_key.replace('otd_mlbpos_v1_', '');
                  try { posMap[pid] = JSON.parse(row.data); } catch(e2) {}
                }
              } catch(e2) {}
              const missing = pItems.filter(i => !posMap[String(i.playerId)]).map(i => i.playerId);
              if (missing.length) {
                try {
                  const ctrl = new AbortController();
                  const t = setTimeout(() => ctrl.abort(), 8000);
                  let mlbRes;
                  try { mlbRes = await fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${missing.slice(0,200).join(',')}&fields=people,id,primaryPosition,abbreviation`, { signal: ctrl.signal }); }
                  finally { clearTimeout(t); }
                  if (mlbRes && mlbRes.ok) {
                    const mlbData = await mlbRes.json();
                    const writes = [];
                    for (const p of (mlbData.people || [])) {
                      const abbr = (p.primaryPosition && p.primaryPosition.abbreviation) || null;
                      if (!abbr) continue;
                      const pid = String(p.id);
                      posMap[pid] = abbr;
                      writes.push(env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,9999999999) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at').bind(`otd_mlbpos_v1_${pid}`, JSON.stringify(abbr)).run().catch(() => {}));
                    }
                    await Promise.all(writes);
                  }
                } catch(e2) {}
              }
              for (const item of pItems) {
                const abbr = posMap[String(item.playerId)] || null;
                if (abbr) item.position = abbr;
              }
            }
          }
          const body = JSON.stringify(parsed);
          await env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at')
            .bind(lbCacheKey, body, v16.fetched_at).run().catch(() => {});
          return new Response(body, { headers: { 'Content-Type': 'application/json' } });
        }
      } catch(e) {}
    }
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
          "SELECT data FROM odds_cache WHERE cache_key LIKE 'otd_passes_all_v10_%' ORDER BY fetched_at DESC LIMIT 60"
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
        .bind(`otd_passes_all_v10_${userId}`).first();
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
    // UFC fighters are always entityType=team in RS regardless of what the frontend passes
    const entityType = (sport === 'ufc' || sport === 'mma') ? 'team' : (url.searchParams.get('entityType') || 'player');
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

      // For UFC, 'alltime' is not a valid season in the RS earnings API — use real years.
      // Try the pass's season first, then fall back to recent years if it returns no data.
      const ufcSeasonCandidates = (rsSport === 'ufc' && (season === 'alltime' || isNaN(Number(season))))
        ? [String(new Date().getFullYear()), String(new Date().getFullYear() - 1), '2024', '2023', '2022']
        : (rsSport === 'ufc' ? [season, String(new Date().getFullYear()), String(new Date().getFullYear() - 1), '2024', '2023', '2022'].filter((s, i, a) => a.indexOf(s) === i) : null);

      const earningsUrl = (s) => `${RS_BASE}/userpassearnings/${rsSport}/season/${s}/entity/${entityType}/${id}?level=1`;

      async function rsGet(hdrs, url) {
        const fetchUrl = url || earningsUrl(season);
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 8000);
        try { return await fetch(fetchUrl, { headers: hdrs, signal: c.signal }); }
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

      let data = await res.json();
      let earnings = data.earnings || data.events || data.performances || data.playerEarnings || data.earningDays ||
        (Array.isArray(data.data) ? data.data : null) ||
        (Array.isArray(data.results) ? data.results : null) ||
        (Array.isArray(data.items) ? data.items : null) ||
        (Array.isArray(data) ? data : []);

      // UFC: if the first season returned nothing, try other years until we get data
      if (ufcSeasonCandidates && !earnings.length) {
        for (const candidate of ufcSeasonCandidates.slice(1)) {
          try {
            const candRes = await rsGet(buildHeadersWithToken(usedToken), earningsUrl(candidate));
            if (!candRes.ok) continue;
            const candData = await candRes.json();
            const candEarnings = candData.earnings || candData.events || candData.performances || candData.playerEarnings ||
              (Array.isArray(candData) ? candData : []);
            if (candEarnings.length > 0) { data = candData; earnings = candEarnings; break; }
          } catch(e) {}
        }
      }

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

  // Admin: bulk-seed all UFC fighters + earnings from RS into D1
  // Supports ?offset=N&limit=M to paginate within CF's 30s wall-clock limit.
  // Call repeatedly: offset=0, offset=50, offset=100, ... until done=true.
  if (action === 'seed_ufc') {
    if (!session?.is_admin) return fail(403, 'Admin only');
    const seedSport = 'ufc';
    const seedEntity = 'team';
    const seedSeason = '2023';
    const SEED_PAGES = parseInt(url.searchParams.get('pages') || '20', 10);
    const SEED_CONCURRENCY = 6;
    const seedOffset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));
    const seedLimit = Math.min(60, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)));
    const skipExisting = url.searchParams.get('skip_existing') !== '0';

    // Phase 1: fetch all fighter pages (fast — 20 parallel fetches ~2s)
    const pageFetches = [];
    for (let pg = 0; pg < SEED_PAGES; pg++) {
      const u = `${RS_BASE}/userpassshop/${seedSport}/season/${seedSeason}/entity/${seedEntity}/section/earningstotal?before=${pg * 20}`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      pageFetches.push(
        fetch(u, { headers, signal: ctrl.signal })
          .then(r => { clearTimeout(t); return r.ok ? r.json() : null; })
          .catch(() => null)
      );
    }
    const pageResults = await Promise.all(pageFetches);

    const fighterMap = {};
    let rawItemSample = null;
    for (const data of pageResults) {
      if (!data) continue;
      const items = data.passes || data.items || data.leaderboard || data.players || data.data || (Array.isArray(data) ? data : []);
      for (const item of items) {
        if (!rawItemSample) rawItemSample = item; // capture first item for debugging
        const id = String(item.id || item.entityId || '');
        const name = item.label || item.name || item.displayName || '';
        const value = Number(item.value) || 0;
        const entity = item.entity || item.player || item.team || {};
        const avatar = item.entityAvatar || item.avatar || item.avatarKey || item.imageKey || item.imageHash ||
          entity.entityAvatar || entity.avatar || entity.avatarKey || entity.imageKey || entity.image || '';
        if (!id) continue;
        if (!fighterMap[id] || value > (fighterMap[id].value || 0)) {
          fighterMap[id] = { id, name, value, avatar };
        }
      }
    }
    const allFighters = Object.values(fighterMap).sort((a, b) => b.value - a.value);
    if (allFighters.length === 0) return fail(502, 'No fighters returned from RS — tokens may be invalid');

    // list_only=1: return full RS list with D1 earnings status, no fetching
    if (url.searchParams.get('list_only') === '1') {
      const allKeys = allFighters.map(f => `otd_earnings_v10_${seedEntity}_${seedSport}_${seedSeason}_${f.id}`);
      const hasEarnings = new Set();
      for (let i = 0; i < allKeys.length; i += 100) {
        const chunk = allKeys.slice(i, i + 100);
        const ph = chunk.map(() => '?').join(',');
        const rows = await env.DB.prepare(`SELECT cache_key FROM odds_cache WHERE cache_key IN (${ph})`).bind(...chunk).all().catch(() => ({ results: [] }));
        for (const row of rows.results) hasEarnings.add(row.cache_key);
      }
      const withOtd = allFighters.filter(f => hasEarnings.has(`otd_earnings_v10_${seedEntity}_${seedSport}_${seedSeason}_${f.id}`));
      const noOtd = allFighters.filter(f => !hasEarnings.has(`otd_earnings_v10_${seedEntity}_${seedSport}_${seedSeason}_${f.id}`));
      return new Response(JSON.stringify({ ok: true, total: allFighters.length, withOtd: withOtd.length, noOtd: noOtd.length, noOtdFighters: noOtd }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Slice to this chunk
    const chunk = allFighters.slice(seedOffset, seedOffset + seedLimit);
    const done = seedOffset + seedLimit >= allFighters.length;

    // Phase 2: check which IDs in this chunk already have earnings cached
    const existingKeys = new Set();
    if (skipExisting && chunk.length > 0) {
      const placeholders = chunk.map(() => '?').join(',');
      const keys = chunk.map(f => `otd_earnings_v10_${seedEntity}_${seedSport}_${seedSeason}_${f.id}`);
      const rows = await env.DB.prepare(`SELECT cache_key FROM odds_cache WHERE cache_key IN (${placeholders})`).bind(...keys).all().catch(() => ({ results: [] }));
      for (const row of rows.results) existingKeys.add(row.cache_key);
    }

    const toFetch = chunk.filter(f => !existingKeys.has(`otd_earnings_v10_${seedEntity}_${seedSport}_${seedSeason}_${f.id}`));

    // Phase 3: fetch earnings for this chunk
    let fetched = 0, written = 0, noData = 0;
    for (let i = 0; i < toFetch.length; i += SEED_CONCURRENCY) {
      const batch = toFetch.slice(i, i + SEED_CONCURRENCY);
      const results = await Promise.all(batch.map(async (fighter) => {
        const u = `${RS_BASE}/userpassearnings/${seedSport}/season/${seedSeason}/entity/${seedEntity}/${fighter.id}?level=1`;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        try {
          const res = await fetch(u, { headers, signal: ctrl.signal });
          clearTimeout(t);
          if (!res.ok) return null;
          const data = await res.json();
          const earnings = data.earnings || data.events || data.performances || data.playerEarnings || data.earningDays || [];
          const baseTotal = (data.info && typeof data.info.total === 'number') ? data.info.total : null;
          const info = data.info || {};
          const avatarFromEarnings = info.entityAvatar || info.avatar || info.avatarKey || info.imageKey || info.image || info.logoUrl || info.imageUrl || '';
          return { fighter, earnings, baseTotal, avatarFromEarnings };
        } catch { clearTimeout(t); return null; }
      }));

      const writes = [];
      for (const result of results) {
        fetched++;
        if (!result || result.earnings.length === 0) { noData++; continue; }
        const { fighter, earnings, baseTotal } = result;
        const body = JSON.stringify({ ok: true, earnings, baseTotal, rawSample: earnings[0] || null });
        const earningsKey = `otd_earnings_v10_${seedEntity}_${seedSport}_${seedSeason}_${fighter.id}`;
        writes.push(env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at').bind(earningsKey, body, now).run().catch(() => {}));
        written++;
      }
      for (const r of results) {
        if (!r) continue;
        const av = r.fighter.avatar || r.avatarFromEarnings || '';
        if (av && !r.fighter.avatar) r.fighter.avatar = av;
      }
      for (const f of batch) {
        const nameKey = `otd_player_${seedSport}_${f.id}`;
        const nameData = JSON.stringify({ name: f.name, id: f.id, position: null, avatar: f.avatar || '' });
        writes.push(env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,9999999999) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at').bind(nameKey, nameData).run().catch(() => {}));
      }
      await Promise.all(writes);
    }

    return new Response(JSON.stringify({
      ok: true,
      totalFighters: allFighters.length,
      offset: seedOffset,
      limit: seedLimit,
      chunkSize: chunk.length,
      skipped: chunk.length - toFetch.length,
      fetched,
      earningsWritten: written,
      noEarningsData: noData,
      done,
      nextOffset: done ? null : seedOffset + seedLimit,
      rawItemSample,
      avatarsSeen: allFighters.filter(f => f.avatar).length,
    }), { headers: { 'Content-Type': 'application/json' } });
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

    // If userId contains non-alphanumeric chars (e.g. underscore), it's a typed username not an internal RS ID.
    // RS searchusers may not surface these users even when searched directly, so strip trailing underscores
    // for the query and exact-match on the full username. Fall back to the original value if unresolved.
    let resolvedUserId = userId;
    if (/[^a-zA-Z0-9]/.test(userId)) {
      const resolveQ = userId.replace(/_+$/, '') || userId;
      try {
        const srRes = await fetch(`${RS_BASE}/searchusers?query=${encodeURIComponent(resolveQ)}`, { headers });
        if (srRes.ok) {
          const srData = await srRes.json();
          const srUsers = Array.isArray(srData) ? srData : (srData.users || srData.results || []);
          const srMatch = srUsers.find(u => (u.userName || u.username || '').toLowerCase() === userId.toLowerCase());
          if (srMatch) resolvedUserId = srMatch.id || srMatch.userId || userId;
        }
      } catch(e) {}
    }

    const cacheKey = `otd_passes_all_v10_${resolvedUserId}`;
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
        if (playerId && sport && level >= 0) {
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
              ? [fetch(`${RS_BASE}/userpasses/${encodeURIComponent(resolvedUserId)}/passes?entityType=player&season=${season}${sportParam}`, { headers })]
              : [
                  fetch(`${RS_BASE}/userpasses/${encodeURIComponent(resolvedUserId)}/passes?entityType=player&season=${season}`, { headers }),
                  fetch(`${RS_BASE}/userpasses/${encodeURIComponent(resolvedUserId)}/passes?entityType=team&season=${season}`, { headers })
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
          }).filter(p => p.playerId && p.level >= 0);
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

  // Pass Suggestion: score all D1-cached fighters by net unique earnings vs user's current passes
  if (action === 'suggest') {
    if (!session) return fail(401, 'Login required');

    const VALID_SUGGEST_SPORTS = ['ufc', 'nba', 'mlb', 'nhl', 'wnba'];
    const suggestSport = url.searchParams.get('sport') || 'ufc';
    if (!VALID_SUGGEST_SPORTS.includes(suggestSport)) return fail(400, 'Invalid sport');
    const suggestUserId = url.searchParams.get('userId');
    if (!suggestUserId) return fail(400, 'Missing userId');

    const suggestEntityType = 'team';
    const suggestSeason = suggestSport === 'ufc' ? '2023' : String(currentYear);
    const earningsPrefix = `otd_earnings_v10_${suggestEntityType}_${suggestSport}_${suggestSeason}_`;

    // UFC multiplier table (mirrors app.js UFC_LEVEL_MULTIPLIERS)
    const UFC_SUGGEST_MULT = {
      1:1, 2:1.4, 3:1.6, 4:2,
      5:5, 6:5.4, 7:5.8, 8:6.2, 9:6.7,
      10:10, 11:10.2, 12:10.4, 13:10.6, 14:10.8, 15:11, 16:11.2, 17:11.4, 18:11.6, 19:12,
      20:20, 21:20.3, 22:20.6, 23:20.9, 24:21.2, 25:21.5, 26:21.8, 27:22.1, 28:22.4, 29:22.7,
      30:23, 31:23.3, 32:23.6, 33:23.9, 34:24.2, 35:24.5
    };
    function suggestGetMult(level) { return UFC_SUGGEST_MULT[level] || 1; }

    // Serve from cache if fresh (1h)
    const suggestCacheKey = `otd_suggest_v7_${suggestSport}_${suggestUserId}`;
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(suggestCacheKey).first();
      if (cached && (now - cached.fetched_at) < 3600) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
      }
    } catch {}

    // 1. Fetch user's passes from RS (player + team in parallel)
    const [playerRes, teamRes] = await Promise.all([
      fetch(`${RS_BASE}/userpasses/${encodeURIComponent(suggestUserId)}/passes?entityType=player&season=${suggestSeason}&sport=${suggestSport}`, { headers }).catch(() => null),
      fetch(`${RS_BASE}/userpasses/${encodeURIComponent(suggestUserId)}/passes?entityType=team&season=${suggestSeason}&sport=${suggestSport}`, { headers }).catch(() => null),
    ]);

    function suggestRarityLabel(label) {
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
    async function extractIds(res) {
      if (!res || !res.ok) return [];
      try {
        const data = await res.json();
        const raw = Array.isArray(data) ? data : (data.passes || data.items || data.collectingCards || []);
        return raw.map(p => {
          const entity = p.entity || p.player || p.team || {};
          const bi = p.boostInfo || {};
          const id = String(p.entityId || p.playerId || entity.id || '');
          const name = p.label || (entity.firstName && entity.lastName ? `${entity.firstName} ${entity.lastName}`.trim() : null) || entity.name || entity.displayName || null;
          const labelLevel = suggestRarityLabel(bi.rarityLabel);
          const level = labelLevel > 0 ? labelLevel
            : (typeof bi.level === 'number' && bi.level > 0) ? bi.level
            : typeof p.level === 'number' ? p.level
            : typeof p.collectingLevel === 'number' ? p.collectingLevel
            : 1;
          return { id, name, level };
        }).filter(p => p.id);
      } catch { return []; }
    }

    const [playerPasses, teamPasses] = await Promise.all([extractIds(playerRes), extractIds(teamRes)]);
    const allUserPasses = [...playerPasses, ...teamPasses];
    const ownedIds = new Set(allUserPasses.map(p => p.id));

    // 2. Load owned passes earnings from D1
    const ownedEarningsMap = new Map();
    if (ownedIds.size > 0) {
      const ownedKeys = [...ownedIds].map(id => earningsPrefix + id);
      for (let i = 0; i < ownedKeys.length; i += 100) {
        const chunk = ownedKeys.slice(i, i + 100);
        const ph = chunk.map(() => '?').join(',');
        const rows = await env.DB.prepare(`SELECT cache_key, data FROM odds_cache WHERE cache_key IN (${ph})`).bind(...chunk).all().catch(() => ({ results: [] }));
        for (const row of rows.results) {
          const id = row.cache_key.replace(earningsPrefix, '');
          try { const d = JSON.parse(row.data); ownedEarningsMap.set(id, d.earnings || []); } catch {}
        }
      }
    }

    // 3. Build covered dates set + day → owners map
    const coveredDates = new Set();
    const dayToOwners = new Map(); // day → [{ id, name, baseEarnings, earnings, level }]
    for (const [id, earningsArr] of ownedEarningsMap) {
      const pass = allUserPasses.find(p => p.id === id) || {};
      const ownerName = pass.name || id;
      const passLevel = pass.level || 1;
      const passMult = suggestGetMult(passLevel);
      for (const e of earningsArr) {
        if (!e.day) continue;
        coveredDates.add(e.day);
        if (!dayToOwners.has(e.day)) dayToOwners.set(e.day, []);
        const baseEarnings = e.earnings || 0;
        dayToOwners.get(e.day).push({ id, name: ownerName, baseEarnings, earnings: Math.round(baseEarnings * passMult), level: passLevel });
      }
    }

    // 4. Load all D1 fighter earnings + names
    const [allEarningsRows, nameRows] = await Promise.all([
      env.DB.prepare('SELECT cache_key, data FROM odds_cache WHERE cache_key LIKE ? LIMIT 800').bind(earningsPrefix + '%').all().catch(() => ({ results: [] })),
      env.DB.prepare('SELECT cache_key, data FROM odds_cache WHERE cache_key LIKE ? LIMIT 800').bind(`otd_player_${suggestSport}_%`).all().catch(() => ({ results: [] })),
    ]);

    const nameMap = new Map(); // id → { name, avatar }
    for (const row of nameRows.results) {
      const id = row.cache_key.replace(`otd_player_${suggestSport}_`, '');
      try { const d = JSON.parse(row.data); nameMap.set(id, { name: d.name || id, avatar: d.avatar || '' }); } catch {}
    }

    // 5. Score every non-owned fighter
    const candidates = [];
    for (const row of allEarningsRows.results) {
      const id = row.cache_key.replace(earningsPrefix, '');
      if (ownedIds.has(id)) continue;
      try {
        const d = JSON.parse(row.data);
        const earnings = d.earnings || [];
        let uniqueEarnings = 0, overlapEarnings = 0, uniqueDays = 0, overlapDays = 0;
        for (const e of earnings) {
          if (coveredDates.has(e.day)) { overlapEarnings += e.earnings; overlapDays++; }
          else { uniqueEarnings += e.earnings; uniqueDays++; }
        }
        const totalEarnings = typeof d.baseTotal === 'number' && d.baseTotal > 0
          ? d.baseTotal : earnings.reduce((s, e) => s + (e.earnings || 0), 0);
        const overlapEvents = earnings.filter(e => coveredDates.has(e.day)).map(e => ({
          day: e.day, dayDisplay: e.dayDisplay || e.day, earnings: e.earnings || 0,
          competitors: (dayToOwners.get(e.day) || []).slice().sort((a, b) => b.earnings - a.earnings),
        }));
        const nme = nameMap.get(id) || { name: id, avatar: '' };
        candidates.push({ id, name: nme.name, avatar: nme.avatar || '', totalEarnings, uniqueEarnings, overlapEarnings, uniqueDays, overlapDays, totalDays: earnings.length, overlapEvents });
      } catch {}
    }
    candidates.sort((a, b) => b.uniqueEarnings - a.uniqueEarnings);

    // 6. Owned passes summary
    const ownedSummary = allUserPasses.map(p => {
      const earnings = ownedEarningsMap.get(p.id) || [];
      return {
        id: p.id,
        name: p.name || (nameMap.get(p.id) || {}).name || p.id,
        totalEarnings: earnings.reduce((s, e) => s + (e.earnings || 0), 0),
        fightDays: earnings.length,
      };
    });

    const body = JSON.stringify({ ok: true, sport: suggestSport, userId: suggestUserId, ownedPasses: ownedSummary, coveredDays: coveredDates.size, suggestions: candidates.slice(0, 60) });
    await env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at')
      .bind(suggestCacheKey, body, now).run().catch(() => {});
    return new Response(body, { headers: { 'Content-Type': 'application/json' } });
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
      "SELECT data FROM odds_cache WHERE cache_key LIKE 'otd_passes_all_v10_%'"
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

    // "All Sports" view — merge all cached per-sport leaderboards from D1
    if (sport === 'all') {
      const suffix = 'alltime'; // all-sports view is always alltime
      const pattern = `otd_lb_v24_${entityType}_%_${suffix}`;
      let rows;
      try { rows = await env.DB.prepare('SELECT cache_key, data FROM odds_cache WHERE cache_key LIKE ?').bind(pattern).all(); }
      catch(e) { return fail(500, e.message); }
      const combined = [];
      for (const row of (rows.results || [])) {
        try {
          const d = JSON.parse(row.data);
          const sportFromKey = row.cache_key.replace(`otd_lb_v24_${entityType}_`, '').replace(`_${suffix}`, '');
          for (const item of (d.leaderboard || [])) {
            combined.push(Object.assign({}, item, { sport: item.sport || sportFromKey }));
          }
        } catch(e) {}
      }
      combined.sort((a, b) => (b.total || 0) - (a.total || 0));
      const leaderboard = combined.slice(0, 1000).map((item, i) => Object.assign({}, item, { rank: i + 1 }));
      return new Response(JSON.stringify({ ok: true, leaderboard }), { headers: { 'Content-Type': 'application/json' } });
    }
    try { // top-level build guard — ensures valid JSON even if build path throws
    const RS_SPORT_ALIAS_LB = { ncaabb: 'ncaam', mma: 'ufc' };
    const RS_SEASON_NORM_LB = { ufc: 'alltime', mma: 'alltime' };
    const sportKey = RS_SPORT_ALIAS_LB[sport] || sport;
    const isAlwaysAllTime = !!RS_SEASON_NORM_LB[sportKey];
    const effectiveAllTime = allTime || isAlwaysAllTime;

    const currentSeasonStr = String(new Date().getFullYear());
    // Ended seasons (≤ last year) have frozen data — cache forever.
    // Current year and alltime: 1-week TTL.
    const WEEK = 604800;
    const isActiveSeason = !effectiveAllTime && season === currentSeasonStr;
    const lbTtl = (isActiveSeason || effectiveAllTime) ? WEEK : Infinity;

    const lbCacheKey = `otd_lb_v24_${entityType}_${sportKey}_${effectiveAllTime ? 'alltime' : season}`;
    if (url.searchParams.get('force') !== '1') {
      try {
        const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(lbCacheKey).first();
        if (cached && (now - cached.fetched_at) < lbTtl) {
          return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
        }
      } catch(e) {}

      // v16 → v18 promotion: migrate existing cached data without hitting RS
      try {
        const v16Key = `otd_lb_v16_${entityType}_${sportKey}_${effectiveAllTime ? 'alltime' : season}`;
        const v16 = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(v16Key).first();
        if (v16) {
          const parsed = JSON.parse(v16.data);
          // For MLB, enrich with positions from D1 position cache
          if (sportKey === 'mlb' && parsed.leaderboard) {
            const pItems = parsed.leaderboard.filter(i => i.entityType !== 'team');
            if (pItems.length) {
              const posKeys = pItems.map(i => `otd_mlbpos_v1_${i.playerId}`);
              const posMap = {};
              const PCHUNK = 100;
              for (let ci = 0; ci < posKeys.length; ci += PCHUNK) {
                const chunk = posKeys.slice(ci, ci + PCHUNK);
                try {
                  const ph = chunk.map(() => '?').join(',');
                  const rows = await env.DB.prepare(`SELECT cache_key, data FROM odds_cache WHERE cache_key IN (${ph})`).bind(...chunk).all();
                  for (const row of (rows.results || [])) {
                    const pid = row.cache_key.replace('otd_mlbpos_v1_', '');
                    try { posMap[pid] = JSON.parse(row.data); } catch(e2) {}
                  }
                } catch(e2) {}
              }
              for (const item of pItems) {
                const abbr = posMap[String(item.playerId)] || null;
                if (abbr) item.position = abbr;
              }
            }
          }
          const body = JSON.stringify(parsed);
          await env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at')
            .bind(lbCacheKey, body, v16.fetched_at).run().catch(() => {});
          return new Response(body, { headers: { 'Content-Type': 'application/json' } });
        }
      } catch(e) {}
    }

    function bId(id) { return String(id).replace(/_l\d+$/, ''); }

    // RS /players/{id}/sport/{slug} uses short slugs, not the full sportKey
    const RS_SPORT_SLUG = {
      'baseball_mlb': 'mlb', 'basketball_nba': 'nba', 'basketball_wnba': 'wnba',
      'icehockey_nhl': 'nhl', 'mma_mixed_martial_arts': 'ufc', 'soccer_fc': 'soccer',
      'soccer_epl': 'epl', 'golf': 'golf',
    };
    const rsPlayerSlug = RS_SPORT_SLUG[sportKey] || sportKey;

    // ── Component caches: earningstotal and ownerMap per season ──────────────
    // Past seasons: frozen data, cache forever.  Current year: 1-week TTL.
    const DB_UPSERT = 'INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at';

    async function getCachedComponent(cacheKey, ttl) {
      try {
        const row = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
        if (row && (now - row.fetched_at) < ttl) return JSON.parse(row.data);
      } catch(e) {}
      return null;
    }
    async function setCachedComponent(cacheKey, data) {
      try { await env.DB.prepare(DB_UPSERT).bind(cacheKey, JSON.stringify(data), now).run(); } catch(e) {}
    }

    async function getEarningsTotal(targetSeason) {
      const ttl = targetSeason === currentSeasonStr ? WEEK : Infinity;
      const key = `otd_earningstotal_v2_${sportKey}_${entityType}_${targetSeason}`;
      const cached = await getCachedComponent(key, ttl);
      if (cached) return cached;
      const passes = await fetchShopSection('earningstotal', 500);
      await setCachedComponent(key, passes);
      return passes;
    }

    async function getOwnerMap(targetSeason) {
      const ttl = targetSeason === currentSeasonStr ? WEEK : Infinity;
      const key = `otd_owners_v3_${sportKey}_${entityType}_${targetSeason}`;
      const cached = await getCachedComponent(key, ttl);
      if (cached) return cached;
      const passes = await fetchShopSection('hotseason', 10000, targetSeason, 10);
      const ownerMap = {};
      for (const p of passes) {
        const bid = bId(String(p.id || p.entityId || ''));
        if (bid && p.value != null) ownerMap[bid] = p.value;
      }
      await setCachedComponent(key, ownerMap);
      return ownerMap;
    }

    // Fetches a shop section sequentially (small fetches) or in parallel batches (large fetches).
    // `concurrency` > 1 fires that many pages simultaneously per batch round — safe because
    // RS uses a simple absolute offset (`before=N`) so offsets can be pre-computed.
    async function fetchShopSection(section, maxCount = 200, seasonOverride, concurrency = 1) {
      const useSeason = seasonOverride || season;
      const PAGE = 20;

      function makeFetch(offset) {
        const u = `${RS_BASE}/userpassshop/${sportKey}/season/${useSeason}/entity/${entityType}/section/${section}?before=${offset}`;
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 8000);
        return fetch(u, { headers, signal: c.signal })
          .then(r => { clearTimeout(t); return r.ok ? r.json() : null; })
          .catch(() => { clearTimeout(t); return null; });
      }

      const results = [];
      let done = false;

      if (concurrency <= 1) {
        // Sequential — for small fetches where order matters for early-stop
        const maxPages = Math.ceil(maxCount / PAGE) + 2;
        for (let page = 0; page < maxPages && !done && results.length < maxCount; page++) {
          try {
            const data = await makeFetch(results.length);
            if (!data) { done = true; break; }
            const items = data.passes || data.items || data.cards || (Array.isArray(data) ? data : []);
            if (!items.length) { done = true; break; }
            for (const p of items) results.push(p);
            if (data.hasMore === false || items.length < 3) done = true;
          } catch(e) { done = true; }
        }
      } else {
        // Parallel batches — fetch `concurrency` pages at once, stop when a batch comes back empty
        for (let batchStart = 0; batchStart < maxCount && !done; batchStart += concurrency * PAGE) {
          const batch = [];
          for (let i = 0; i < concurrency; i++) {
            const offset = batchStart + i * PAGE;
            if (offset >= maxCount) break;
            batch.push(makeFetch(offset));
          }
          const responses = await Promise.all(batch);
          for (const data of responses) {
            if (!data) { done = true; break; }
            const items = data.passes || data.items || data.cards || (Array.isArray(data) ? data : []);
            if (!items.length || items.length < 3) { done = true; break; }
            for (const p of items) results.push(p);
            if (data.hasMore === false) { done = true; break; }
          }
        }
      }
      return results;
    }

    // Fetch earningstotal and ownerMap via component caches.
    // Old seasons: forever cache.  Current year: 1-week TTL.
    // For alltime: earningstotal comes from D1 earnings rows (not RS API).
    // Owner map merges across all years so sports with data only in older seasons (e.g. UFC in 2023) get coverage.
    async function getMultiYearOwnerMap() {
      const currentYear = new Date().getFullYear();
      const minYear = sportKey === 'golf' ? 2015 : 2021;
      const years = [];
      for (let y = currentYear; y >= minYear; y--) years.push(String(y));
      const maps = await Promise.all(years.map(y => getOwnerMap(y)));
      const merged = {};
      for (const m of maps) {
        for (const [bid, count] of Object.entries(m)) {
          if (merged[bid] == null || count > merged[bid]) merged[bid] = count;
        }
      }
      return merged;
    }
    const [earningsPasses, ownerMap] = effectiveAllTime
      ? [[], await getMultiYearOwnerMap()]
      : await Promise.all([getEarningsTotal(season), getOwnerMap(season)]);

    // For alltime: seed nameMap from all historically relevant seasons.
    // 8 pages for recent 3 years (top 160 each), 2 pages for older years (top 40 each).
    // Golf goes back to 2015; all other sports go back to 2022.
    let allTimeNameItems = [];
    if (effectiveAllTime) {
      const currentYear = new Date().getFullYear();
      const nameFetches = [];
      if (isAlwaysAllTime) {
        // UFC/MMA: all earnings live in season 2023 — fetch 36 pages (720 fighters)
        for (let pg = 0; pg < 36; pg++) {
          const u = `${RS_BASE}/userpassshop/${sportKey}/season/2023/entity/${entityType}/section/earningstotal?before=${pg * 20}`;
          const c = new AbortController();
          const t = setTimeout(() => c.abort(), 6000);
          nameFetches.push(fetch(u, { headers, signal: c.signal }).then(r => { clearTimeout(t); return r.ok ? r.json() : null; }).catch(() => null));
        }
      } else {
        const sportMinYear = sportKey === 'golf' ? 2015 : 2022;
        for (let y = currentYear; y >= sportMinYear; y--) {
          const numPages = y >= currentYear - 2 ? 8 : 2;
          for (let pg = 0; pg < numPages; pg++) {
            const before = pg * 20;
            const u = `${RS_BASE}/userpassshop/${sportKey}/season/${y}/entity/${entityType}/section/earningstotal?before=${before}`;
            const c = new AbortController();
            const t = setTimeout(() => c.abort(), 6000);
            nameFetches.push(fetch(u, { headers, signal: c.signal }).then(r => { clearTimeout(t); return r.ok ? r.json() : null; }).catch(() => null));
          }
        }
      }
      const nameResults = await Promise.all(nameFetches);
      for (const data of nameResults) {
        if (!data) continue;
        const items = data.passes || data.items || data.cards || (Array.isArray(data) ? data : []);
        for (const p of items) allTimeNameItems.push(p);
      }
    }

    // For alltime with RS data: deduplicate allTimeNameItems (a fighter may appear across multiple years)
    // and use as shopPasses so names come directly from RS without needing the D1 earnings loop.
    let shopPasses = earningsPasses;
    if (effectiveAllTime && allTimeNameItems.length > 0) {
      const seen = {};
      for (const p of allTimeNameItems) {
        const bid = bId(String(p.id || p.entityId || ''));
        const val = Number(p.value) || 0;
        if (bid && (!seen[bid] || val > seen[bid].val)) seen[bid] = { val, p };
      }
      shopPasses = Object.values(seen).sort((a, b) => b.val - a.val).map(({ p }) => p);
    }

    // ── Build name map + iconic sets from D1 pass caches ────────────────────
    const nameMap = {};
    // Merge alltime name items fetched from recent shop pages
    for (const p of allTimeNameItems) {
      const bid = bId(String(p.id || p.entityId || ''));
      const name = p.label || p.playerName || p.name || p.displayName || null;
      // Skip if name looks like a raw numeric ID (RS returns entity IDs for team-type entries)
      if (bid && name && !/^\d+$/.test(String(name).trim())) nameMap[bid] = name;
    }
    const iconicSets = {}; // baseId → Set of RaxEdge userIds at level >= 20
    // Skip passRows for alltime views when allTimeNameItems already provides names — avoids CPU 1102 error
    const passRows = (effectiveAllTime && allTimeNameItems.length > 0) ? { results: [] } :
      await env.DB.prepare("SELECT cache_key, data FROM odds_cache WHERE cache_key LIKE 'otd_passes_all_v10_%'").all().catch(() => ({ results: [] }));
    for (const row of (passRows.results || [])) {
      const userId = row.cache_key.replace('otd_passes_all_v10_', '');
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
    // Skip D1 earnings loop when shopPasses has RS data — avoids 836-row JSON.parse CPU cost
    const earningsRows = shopPasses.length > 0 ? { results: [] } :
      await env.DB.prepare('SELECT cache_key, data FROM odds_cache WHERE cache_key LIKE ? LIMIT 500').bind(earningsPattern).all().catch(() => ({ results: [] }));

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
    // When alltime view: collapse per-season entries to one per player (keep max).
    // Prevents duplicate rows for sports like UFC that have both year-specific
    // and 'alltime' keys in the D1 earnings cache.
    if (effectiveAllTime && shopPasses.length === 0) {
      const playerMax = {};
      for (const [sk, total] of Object.entries(seasonMaxes)) {
        const colonIdx = sk.indexOf(':');
        const bid = sk.slice(0, colonIdx);
        if (!playerMax[bid] || total > playerMax[bid]) playerMax[bid] = total;
      }
      for (const key of Object.keys(seasonMaxes)) delete seasonMaxes[key];
      for (const [bid, total] of Object.entries(playerMax)) seasonMaxes[bid + ':alltime'] = total;
    }

    // ── Build final list ─────────────────────────────────────────────────────
    let list;
    if (shopPasses.length > 0) {
      // earningstotal section: `value` = season base earnings total direct from RS
      // hotseason section: `value` = total RS platform owner count (from ownerMap)
      list = shopPasses.slice(0, 500).map((p, i) => {
        const bid = bId(String(p.id || p.entityId || ''));
        const name = p.label || p.playerName || p.name || p.displayName || nameMap[bid] || null;
        if (name && !nameMap[bid]) nameMap[bid] = name;
        return {
          rank: i + 1,
          playerId: bid,
          name,
          season: effectiveAllTime ? 'alltime' : season,
          position: p.position || p.pos || null,
          total: p.value != null ? Number(p.value) : null,
          passCount: ownerMap[bid] != null ? ownerMap[bid] : null,
          iconic: iconicSets[bid] ? iconicSets[bid].size : 0,
          sport: sportKey,
          entityType: p.entityType || entityType,
        };
      });
    } else {
      // D1 fallback (alltime) — one row per player:season, ranked by that season's earnings
      list = Object.entries(seasonMaxes)
        .filter(([sk, total]) => sk && total > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 500)
        .map(([sk, total], i) => {
          const colonIdx = sk.indexOf(':');
          const bid = sk.slice(0, colonIdx);
          const seasonPart = sk.slice(colonIdx + 1);
          return {
            rank: i + 1,
            playerId: bid,
            name: nameMap[bid] || null,
            season: seasonPart,
            position: null,
            total,
            passCount: ownerMap[bid] != null ? ownerMap[bid] : null,
            iconic: iconicSets[bid] ? iconicSets[bid].size : 0,
            sport: sportKey,
            entityType,
          };
        });
    }

    // ── Supplement alltime owner counts per season ───────────────────────────
    // ownerMap seeded only from current year so far. For other seasons in the list,
    // pull from getOwnerMap (forever-cached for past seasons — instant on repeat calls).
    if (effectiveAllTime) {
      const uniqueSeasons = [...new Set(list.map(r => r.season).filter(Boolean))];
      const extraSeasons = uniqueSeasons.filter(s => s !== currentSeasonStr);
      if (extraSeasons.length > 0) {
        const extraMaps = await Promise.all(extraSeasons.map(yr => getOwnerMap(yr)));
        for (const extraMap of extraMaps) {
          for (const [bid, count] of Object.entries(extraMap)) {
            if (ownerMap[bid] == null) ownerMap[bid] = count; // don't overwrite current-year data
          }
        }
        for (const item of list) {
          if (item.passCount == null && ownerMap[item.playerId] != null) {
            item.passCount = ownerMap[item.playerId];
          }
        }
      }
    }

    // Write initial list to cache now and return early — name resolution + MLB positions
    // run in background via context.waitUntil so the browser gets a fast response.
    const earlyBody = JSON.stringify({ ok: true, leaderboard: list, sport: sportKey, allTime: effectiveAllTime, fromShop: shopPasses.length > 0 });
    await env.DB.prepare(DB_UPSERT).bind(lbCacheKey, earlyBody, now).run().catch(() => {});
    context.waitUntil((async () => { try {

    // ── Resolve missing names ────────────────────────────────────────────────
    // earningstotal returns {id, value, entityType} only — no names.
    // 1. Check D1 otd_player_{sport}_{id} cache (populated by prior earnings lookups).
    // 2. For still-missing player IDs, fetch from RS /players/{id}/sport/{sport} in parallel.
    const isNumericName = n => n && /^\d+$/.test(String(n).trim());
    const unknownItems = list.filter(item => !item.name || isNumericName(item.name));
    if (unknownItems.length > 0) {
      // Step 1: bulk D1 lookup
      const d1PlayerRows = await env.DB.prepare(
        `SELECT cache_key, data FROM odds_cache WHERE cache_key LIKE ?`
      ).bind(`otd_player_${rsPlayerSlug}_%`).all().catch(() => ({ results: [] }));
      const d1NameMap = {};
      for (const row of (d1PlayerRows.results || [])) {
        const id = row.cache_key.replace(`otd_player_${rsPlayerSlug}_`, '');
        try {
          const pd = JSON.parse(row.data);
          const rawName = (pd.player && pd.player.name) ? pd.player.name : (pd.name || null);
          const n = rawName ? String(rawName).trim() : null;
          if (n && !isNumericName(n)) d1NameMap[id] = n;
        } catch(e) {}
      }
      for (const item of unknownItems) {
        if (d1NameMap[item.playerId]) item.name = d1NameMap[item.playerId];
      }

      // Step 2: RS API fetch for remaining unknowns — includes team-type entities (UFC fighters)
      // UFC passes are stored as entityType=team but player IDs still resolve via /players/{id}/sport/{sport}
      const stillUnknown = list.filter(item => !item.name || isNumericName(item.name)).slice(0, 50);
      if (stillUnknown.length > 0) {
        const rsFetches = stillUnknown.map(async item => {
          const c = new AbortController();
          const t = setTimeout(() => c.abort(), 5000);
          try {
            const isTeamEntity = sportKey === 'ufc' || item.entityType === 'team';
            const ep = isTeamEntity ? 'teams' : 'players';
            const res = await fetch(`${RS_BASE}/${ep}/${item.playerId}/sport/${rsPlayerSlug}`, { headers, signal: c.signal });
            clearTimeout(t);
            if (!res.ok) return null;
            const data = await res.json();
            const p = data.team || data.player || data;
            const name = p.name || ((p.firstName || '') + ' ' + (p.lastName || '')).trim() || p.displayName || null;
            const pos = p.position || null;
            return { id: item.playerId, name: name || null, pos };
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
          const ck = `otd_player_${rsPlayerSlug}_${r.id}`;
          const cb = JSON.stringify({ name: r.name, id: r.id, position: r.pos });
          cacheWrites.push(env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at').bind(ck, cb, now).run().catch(() => {}));
        }
        await Promise.all(cacheWrites);
      }
    }

    // ── MLB position lookup via MLB Stats API ────────────────────────────────
    // RS player IDs == MLB Stats API player IDs. Batch-fetch primaryPosition for
    // all player-type rows; cache individually forever (positions rarely change).
    if (sportKey === 'mlb') {
      const playerItems = list.filter(i => i.entityType !== 'team');
      const posNeeded = [];
      const posCacheKeys = playerItems.map(i => `otd_mlbpos_v1_${i.playerId}`);

      // Batch D1 lookup
      const CHUNK = 100;
      const posMap = {};
      for (let ci = 0; ci < posCacheKeys.length; ci += CHUNK) {
        const chunk = posCacheKeys.slice(ci, ci + CHUNK);
        try {
          const ph = chunk.map(() => '?').join(',');
          const rows = await env.DB.prepare(`SELECT cache_key, data FROM odds_cache WHERE cache_key IN (${ph})`).bind(...chunk).all();
          for (const row of (rows.results || [])) {
            const pid = row.cache_key.replace('otd_mlbpos_v1_', '');
            try { posMap[pid] = JSON.parse(row.data); } catch(e) {}
          }
        } catch(e) {}
      }
      for (const item of playerItems) {
        if (!posMap[item.playerId]) posNeeded.push(item.playerId);
      }

      // Fetch missing positions from MLB Stats API (one batched call)
      if (posNeeded.length > 0) {
        try {
          const ids = posNeeded.slice(0, 200).join(',');
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 8000);
          let mlbRes;
          try { mlbRes = await fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${ids}&fields=people,id,firstName,lastName,primaryPosition,abbreviation`, { signal: ctrl.signal }); }
          finally { clearTimeout(t); }
          if (mlbRes && mlbRes.ok) {
            const mlbData = await mlbRes.json();
            const writes = [];
            for (const p of (mlbData.people || [])) {
              const pid = String(p.id);
              const abbr = (p.primaryPosition && p.primaryPosition.abbreviation) || null;
              if (abbr) {
                posMap[pid] = abbr;
                writes.push(env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,9999999999) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at').bind(`otd_mlbpos_v1_${pid}`, JSON.stringify(abbr)).run().catch(() => {}));
              }
              // Fill in name for any player still showing as a numeric ID
              const mlbName = ((p.firstName || '') + ' ' + (p.lastName || '')).trim() || null;
              if (mlbName) {
                const item = list.find(i => i.playerId === pid);
                if (item && (!item.name || /^\d+$/.test(String(item.name).trim()))) item.name = mlbName;
              }
            }
            await Promise.all(writes);
          }
        } catch(e) {}
      }

      // Apply positions to list items
      for (const item of playerItems) {
        const abbr = posMap[item.playerId] || null;
        if (abbr) item.position = abbr;
      }

      // MLB name fallback: any item still showing a numeric name gets resolved via MLB Stats API.
      // Runs independently of position cache — players with cached positions skip posNeeded but still need names.
      const stillNumericNames = list.filter(i => !i.name || /^\d+$/.test(String(i.name).trim()));
      if (stillNumericNames.length > 0) {
        try {
          const nameIds = stillNumericNames.slice(0, 400).map(i => i.playerId).join(',');
          const nc = new AbortController();
          const nt = setTimeout(() => nc.abort(), 8000);
          let nameRes;
          try { nameRes = await fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${nameIds}&fields=people,id,firstName,lastName`, { signal: nc.signal }); }
          finally { clearTimeout(nt); }
          if (nameRes && nameRes.ok) {
            const nd = await nameRes.json();
            for (const p of (nd.people || [])) {
              const n = ((p.firstName || '') + ' ' + (p.lastName || '')).trim();
              if (!n) continue;
              const item = list.find(i => i.playerId === String(p.id));
              if (item) item.name = n;
            }
          }
        } catch(e) {}
      }
    }

    // Update cache with resolved names/positions for next request
    const resolvedBody = JSON.stringify({ ok: true, leaderboard: list, sport: sportKey, allTime: effectiveAllTime, fromShop: shopPasses.length > 0 });
    await env.DB.prepare(DB_UPSERT).bind(lbCacheKey, resolvedBody, now).run().catch(() => {});

    } catch(bgErr) {} })());
    return new Response(earlyBody, { headers: { 'Content-Type': 'application/json' } });
    } catch(buildErr) {
      return new Response(JSON.stringify({ ok: true, leaderboard: [], error: buildErr.message }), { headers: { 'Content-Type': 'application/json' } });
    }
  }

  return fail(400, 'Unknown action');
}
