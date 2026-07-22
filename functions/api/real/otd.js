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

  if (!env.REAL_AUTH_TOKEN || !env.REAL_SESSION_TOKEN) {
    return fail(503, 'REAL_AUTH_TOKEN or REAL_SESSION_TOKEN not set');
  }

  const headers = buildHeaders(env);

  // Search: find players by name
  if (action === 'search') {
    const q = (url.searchParams.get('q') || '').trim();
    const sport = url.searchParams.get('sport') || 'mlb';
    if (q.length < 2) return fail(400, 'Query too short');

    const cacheKey = 'otd_search_v5_' + q.toLowerCase().replace(/[^a-z0-9]/g, '_');
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < 3600) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
      }
    } catch(e) {}

    const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const queryWords = norm(q).split(/\s+/).filter(w => w.length > 1);

    try {
      const res = await fetch(`${RS_BASE}/search?query=${encodeURIComponent(q)}&sport=${sport}`, { headers });
      if (!res.ok) return fail(res.status, 'RS search failed: ' + res.status);
      const data = await res.json();

      const playerMap = {};
      const addPlayer = (pObj) => {
        if (!pObj || !pObj.id || playerMap[pObj.id]) return;
        const name = ((pObj.firstName || '') + ' ' + (pObj.lastName || '')).trim();
        if (!name) return;
        if (!queryWords.some(w => norm(name).includes(w))) return;
        playerMap[pObj.id] = { id: pObj.id, name, sport, teamId: pObj.teamId, avatar: pObj.avatar || '' };
      };

      // Format 1: data.players or data.results.players (direct player list)
      for (const pObj of (data.players || (data.results && data.results.players) || [])) {
        addPlayer(pObj);
      }
      // Format 2: data.entities — RS returns { type, entity: { firstName, lastName, ... }, id }
      for (const e of (data.entities || (data.results && data.results.entities) || [])) {
        addPlayer(e.entity || e.player || e);
      }
      // Format 3: data.results.plays — each play has primaryPlayer / secondaryPlayer
      for (const play of (data.results && data.results.plays) || (data.plays) || []) {
        addPlayer(play.primaryPlayer);
        addPlayer(play.secondaryPlayer);
      }

      const players = Object.values(playerMap).slice(0, 15);
      const body = JSON.stringify({ ok: true, players });
      // Only cache if we got results to avoid caching stale "no results"
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

    const cacheKey = `otd_perf_url_v1_${entityType}_${sport}_${entityId}_${season}`;
    let bsList;
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < 86400) {
        bsList = JSON.parse(cached.data);
      }
    } catch(e) {}

    if (!bsList) {
      try {
        // Try player boxscores endpoint (no sport filter — RS 400s when sport is passed)
        const rsUrl = `${RS_BASE}/players/${encodeURIComponent(entityId)}/playerboxscores?season=${season}`;
        const res = await fetch(rsUrl, { headers });
        if (!res.ok) return fail(res.status, 'RS perf_url failed: ' + res.status);
        const data = await res.json();
        bsList = data.playerBoxScores || data.boxScores || data.items || (Array.isArray(data) ? data : []);
        try {
          await env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at')
            .bind(cacheKey, JSON.stringify(bsList), now).run();
        } catch(e) {}
      } catch(e) {
        return fail(500, e.message);
      }
    }

    const match = bsList.find(function(b) { return (b.day || '').startsWith(day); });
    return new Response(JSON.stringify({
      ok: true,
      raw: match || null,
      debug: { bsCount: bsList.length, sample: bsList[0] || null, day }
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

    const cacheKey = `otd_earnings_v2_${entityType}_${sport}_${season}_${id}_l${level}`;
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < 43200) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
      }
    } catch(e) {}

    try {
      const earningsUrl = `${RS_BASE}/userpassearnings/${sport}/season/${season}/entity/${entityType}/${id}?level=${level}`;
      let res = await fetch(earningsUrl, { headers });
      // Retry once on 429 after a short delay
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 1000));
        res = await fetch(earningsUrl, { headers });
      }
      if (!res.ok) return fail(res.status, 'RS earnings failed: ' + res.status);
      const data = await res.json();
      const body = JSON.stringify({ ok: true, earnings: data.earnings || [] });
      try {
        await env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at')
          .bind(cacheKey, body, now).run();
      } catch(e) {}
      return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    } catch(e) {
      return fail(500, e.message);
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
        boostLevel: p.boostInfo && p.boostInfo.level,
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
    const cacheKey = `otd_passes_all_v6_${userId}`;
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < 7200) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
      }
    } catch(e) {}

    const yr = new Date().getFullYear();
    const seasons = [];
    for (let y = yr; y >= 2015; y--) seasons.push(y);

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
        const playerId = p.entityId || p.playerId || entity.id;
        const playerName = p.label
          || (entity.firstName && entity.lastName ? (entity.firstName + ' ' + entity.lastName).trim() : null)
          || entity.name || entity.displayName || null;
        const sport = p.sport || entity.sport || null;
        const season = String(p.season || fallbackSeason);
        // boostInfo.level is 0 for Common cards (it tracks boost progress, not rarity).
        // Always derive rarity level from the rarity string first; use boostInfo only for Rare+.
        const rarityLevel = rarityToLevelAll(p.rarity || p.rarityName, p.rarityLevel || p.subLevel);
        const level = rarityLevel > 0 ? rarityLevel
          : (p.boostInfo && typeof p.boostInfo.level === 'number' && p.boostInfo.level > 0) ? p.boostInfo.level
          : typeof p.level === 'number' ? p.level
          : typeof p.collectingLevel === 'number' ? p.collectingLevel
          : 0;
        if (playerId && sport && level >= 1) {
          results.push({ playerId, playerName, sport, season, level, entityType, passId: p.id || null, avatar: entity.avatar || null });
        }
      }
      return results;
    }

    try {
      const passMap = {};

      const CHUNK = 3;
      for (let i = 0; i < seasons.length; i += CHUNK) {
        await Promise.all(seasons.slice(i, i + CHUNK).map(async season => {
          try {
            const [playerRes, teamRes] = await Promise.all([
              fetch(`${RS_BASE}/userpasses/${encodeURIComponent(userId)}/passes?entityType=player&season=${season}`, { headers }),
              fetch(`${RS_BASE}/userpasses/${encodeURIComponent(userId)}/passes?entityType=team&season=${season}`, { headers })
            ]);
            for (const [res, entityType] of [[playerRes, 'player'], [teamRes, 'team']]) {
              if (!res.ok) {
                if (res.status === 429) throw new Error('429');
                continue;
              }
              try {
                const data = await res.json();
                for (const pass of extractPasses(data, entityType, season)) {
                  const key = `${pass.playerId}|${pass.sport}|${pass.season}`;
                  passMap[key] = pass;
                }
              } catch(e) {}
            }
          } catch(e) {
            if (e.message === '429') throw e;
          }
        }));
        if (i + CHUNK < seasons.length) await new Promise(r => setTimeout(r, 400));
      }

      const passes = Object.values(passMap);
      const body = JSON.stringify({ ok: true, passes });
      try {
        await env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at')
          .bind(cacheKey, body, now).run();
      } catch(e) {}
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

      function rarityToLevel(rarity, rarityLevel) {
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

      function extractPasses(res, entityType) {
        if (!res.ok) return [];
        return res.json().then(data => {
          const raw = Array.isArray(data) ? data : (data.passes || data.items || data.collectingCards || []);
          return raw.map(p => {
            const entity = p.entity || p.player || p.team || {};
            const playerId = p.entityId || p.playerId || entity.id;
            const playerName = p.label
              || (entity.firstName && entity.lastName ? (entity.firstName + ' ' + entity.lastName).trim() : null)
              || entity.name || entity.displayName || null;
            const rl = rarityToLevel(p.rarity || p.rarityName, p.rarityLevel || p.subLevel);
            const level = rl > 0 ? rl
              : (p.boostInfo && typeof p.boostInfo.level === 'number' && p.boostInfo.level > 0) ? p.boostInfo.level
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

  // All passes that earned on a given OTD day (MM-DD match across all years), with pre-computed RS URLs
  if (action === 'day_earnings') {
    const day = url.searchParams.get('day');
    if (!day) return fail(400, 'Missing day');

    const cacheKey = `otd_day_earns_v2_${day}`;
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < 300) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
      }
    } catch(e) {}

    try {
      const res = await fetch(`${RS_BASE}/cardhistoricalearnings?day=${encodeURIComponent(day)}`, { headers });
      if (!res.ok) return fail(res.status, 'RS day_earnings failed: ' + res.status);
      const data = await res.json();

      const entries = [];
      for (const sg of (data.sportEarnings || [])) {
        for (const p of (sg.passEarnings || [])) {
          const sportCode = RS_SPORT_CODE[p.sport] || 0;
          // routeType 18 = UserPass — encodes [18, sportCode, 0, passId] where passId = p.id
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

  return fail(400, 'Unknown action');
}
