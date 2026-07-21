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

    const cacheKey = 'otd_search_v2_' + sport + '_' + q.toLowerCase().replace(/[^a-z0-9]/g, '_');
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < 3600) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
      }
    } catch(e) {}

    try {
      const res = await fetch(`${RS_BASE}/search?query=${encodeURIComponent(q)}&sport=${sport}`, { headers });
      if (!res.ok) return fail(res.status, 'RS search failed: ' + res.status);
      const data = await res.json();

      // Normalize accent chars for fuzzy matching
      const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      const queryWords = norm(q).split(/\s+/).filter(w => w.length > 1);

      const playerMap = {};
      for (const play of (data.results && data.results.plays) || []) {
        const pid = play.primaryPlayerId;
        if (!pid || playerMap[pid]) continue;
        const desc = play.description || '';
        const m = desc.match(/^((?:[A-ZÁÉÍÓÚ][a-záéíóúñ'.\-]+\s+){1,3}[A-ZÁÉÍÓÚ][a-záéíóúñ'.\-]+)/);
        if (!m) continue;
        const extractedName = m[1].trim();
        // Only include if the extracted name actually matches the query (avoids showing wrong players from multi-player plays)
        const nameNorm = norm(extractedName);
        if (!queryWords.some(w => nameNorm.includes(w))) continue;
        playerMap[pid] = { id: pid, name: extractedName, sport, teamId: play.teamId };
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

  // Earnings: get all OTD claimable dates for a player at a rarity level
  if (action === 'earnings') {
    const id = url.searchParams.get('id');
    const sport = url.searchParams.get('sport') || 'mlb';
    const season = url.searchParams.get('season') || '2026';
    const level = parseInt(url.searchParams.get('level') || '1', 10);
    if (!id) return fail(400, 'Missing id');

    const cacheKey = `otd_earnings_${sport}_${season}_${id}_l${level}`;
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < 43200) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
      }
    } catch(e) {}

    try {
      const res = await fetch(`${RS_BASE}/userpassearnings/${sport}/season/${season}/entity/player/${id}?level=${level}`, { headers });
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

  return fail(400, 'Unknown action');
}
