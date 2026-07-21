import { getSessionOrCron } from '../../_lib/auth.js';
import { hashidsEncode } from '../../_lib/hashids.js';

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

    const cacheKey = 'otd_search_v4_' + sport + '_' + q.toLowerCase().replace(/[^a-z0-9]/g, '_');
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

      // Each play has primaryPlayer (batter) and secondaryPlayer (pitcher) with names already included.
      // Check both so pitchers show up when searched by name.
      const playerMap = {};
      for (const play of (data.results && data.results.plays) || []) {
        for (const pObj of [play.primaryPlayer, play.secondaryPlayer]) {
          if (!pObj || !pObj.id || playerMap[pObj.id]) continue;
          const name = ((pObj.firstName || '') + ' ' + (pObj.lastName || '')).trim();
          if (!name) continue;
          if (!queryWords.some(w => norm(name).includes(w))) continue;
          playerMap[pObj.id] = { id: pObj.id, name, sport, teamId: pObj.teamId };
        }
        if (Object.keys(playerMap).length >= 8) break;
      }

      const players = Object.values(playerMap).slice(0, 8);
      const body = JSON.stringify({ ok: true, players });
      try {
        await env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at')
          .bind(cacheKey, body, now).run();
      } catch(e) {}
      return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    } catch(e) {
      return fail(500, e.message);
    }
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
      const res = await fetch(`${RS_BASE}/userpassearnings/${sport}/season/${season}/entity/${entityType}/${id}?level=${level}`, { headers });
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
  if (action === 'user_passes_all') {
    const userId = url.searchParams.get('userId');
    if (!userId) return fail(400, 'Missing userId');

    // Query by season only — no sport filter so RS returns all passes regardless of sport.
    // 5 seasons × 2 entity types = 10 parallel calls (vs 110 sport-filtered calls that RS rate-limits).
    const cacheKey = `otd_passes_all_v2_${userId}`;
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < 1800) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
      }
    } catch(e) {}

    const yr = new Date().getFullYear();
    const seasons = [yr, yr-1, yr-2, yr-3, yr-4];

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
        const level = (p.boostInfo && typeof p.boostInfo.level === 'number') ? p.boostInfo.level
          : typeof p.level === 'number' ? p.level
          : typeof p.collectingLevel === 'number' ? p.collectingLevel
          : rarityToLevelAll(p.rarity || p.rarityName, p.rarityLevel || p.subLevel);
        if (playerId && sport && level >= 3) {
          results.push({ playerId, playerName, sport, season, level, entityType });
        }
      }
      return results;
    }

    try {
      const passMap = {};

      await Promise.all(seasons.map(async season => {
        try {
          const [playerRes, teamRes] = await Promise.all([
            fetch(`${RS_BASE}/userpasses/${encodeURIComponent(userId)}/passes?entityType=player&season=${season}`, { headers }),
            fetch(`${RS_BASE}/userpasses/${encodeURIComponent(userId)}/passes?entityType=team&season=${season}`, { headers })
          ]);
          for (const [res, entityType] of [[playerRes, 'player'], [teamRes, 'team']]) {
            if (!res.ok) continue;
            try {
              const data = await res.json();
              for (const pass of extractPasses(data, entityType, season)) {
                const key = `${pass.playerId}|${pass.sport}|${pass.season}`;
                passMap[key] = pass;
              }
            } catch(e) {}
          }
        } catch(e) {}
      }));

      const passes = Object.values(passMap);
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

  // Fetch all passes for an RS user in a given sport + season
  if (action === 'user_passes') {
    const userId = url.searchParams.get('userId');
    const sport  = url.searchParams.get('sport') || 'mlb';
    const season = url.searchParams.get('season') || String(new Date().getFullYear());
    if (!userId) return fail(400, 'Missing userId');

    const cacheKey = `otd_passes_v5_${userId}_${sport}_${season}`;
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < 1800) {
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
            const level = (p.boostInfo && typeof p.boostInfo.level === 'number') ? p.boostInfo.level
              : typeof p.level === 'number' ? p.level
              : typeof p.collectingLevel === 'number' ? p.collectingLevel
              : rarityToLevel(p.rarity || p.rarityName, p.rarityLevel || p.subLevel);
            return { playerId, playerName, sport: p.sport || sport, season: String(p.season || season), level, entityType };
          }).filter(p => p.playerId && p.level >= 3);
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

  return fail(400, 'Unknown action');
}
