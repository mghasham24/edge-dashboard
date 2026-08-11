// GET /api/parlays/player-rs-ids?sport=mlb
// Returns:
//   ids:            { playerName: rsPlayerId }  — from D1 OTD cache
//   gamesByEventId: { dkEventId: rsGameId }     — joined from props cache + RS sync cache
// Auto-populates otd_player_* entries from the leaderboard cache for new players.

import { getSessionOrCron } from '../../_lib/auth.js';

const SPORT_SLUG      = { mlb: 'mlb', wnba: 'wnba', nfl: 'nfl', ufc: 'ufc' };
const SYNC_CACHE_KEY  = { mlb: 'real_sync_mlb_v12', wnba: 'real_sync_wnba_v12' };
const PROPS_CACHE_KEY = { mlb: 'dk_mlb_props_v11',  wnba: 'dk_wnba_props_v3' };
const LB_CACHE_KEY    = { mlb: 'otd_lb_v24_player_mlb_2025', wnba: 'otd_lb_v24_player_wnba_2025' };

// Strip accents: "Azurá Stevens" → "Azura Stevens"
function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSessionOrCron(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  const url   = new URL(request.url);
  const sport = url.searchParams.get('sport') || 'mlb';
  const slug  = SPORT_SLUG[sport];
  if (!slug) {
    return new Response(JSON.stringify({ error: 'Unknown sport' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const [playerRows, syncRow, propsRow, lbRow] = await Promise.allSettled([
    env.DB.prepare('SELECT data FROM odds_cache WHERE cache_key LIKE ?').bind('otd_player_' + slug + '_%').all(),
    env.DB.prepare('SELECT data FROM odds_cache WHERE cache_key=?').bind(SYNC_CACHE_KEY[sport] || '').first(),
    env.DB.prepare('SELECT data FROM odds_cache WHERE cache_key=?').bind(PROPS_CACHE_KEY[sport] || '').first(),
    env.DB.prepare('SELECT data FROM odds_cache WHERE cache_key=?').bind(LB_CACHE_KEY[sport] || '').first(),
  ]);

  // Player name → RS player ID (exact + accent-stripped)
  const ids = {};
  const cachedPids = new Set();
  if (playerRows.status === 'fulfilled') {
    for (const row of (playerRows.value?.results || [])) {
      try {
        const raw = JSON.parse(row.data);
        const p = raw.player || raw;
        if (!p.name || !p.id) continue;
        const pid = String(p.id);
        ids[p.name] = pid;
        const plain = stripAccents(p.name);
        if (plain !== p.name) ids[plain] = pid;
        cachedPids.add(pid);
      } catch {}
    }
  }

  // Auto-populate from leaderboard for any players not yet in otd_player cache
  if (lbRow.status === 'fulfilled' && lbRow.value?.data) {
    try {
      const lbData = JSON.parse(lbRow.value.data);
      const newWrites = [];
      for (const entry of (lbData.leaderboard || [])) {
        if (!entry.playerId || !entry.name) continue;
        const pid    = String(entry.playerId);
        const rsName = entry.name;
        const plain  = stripAccents(rsName);
        // Always add both name variants to ids map
        ids[rsName] = pid;
        if (plain !== rsName) ids[plain] = pid;
        // Write to D1 if this player wasn't already in the cache
        if (!cachedPids.has(pid)) {
          cachedPids.add(pid);
          newWrites.push(
            env.DB.prepare(
              'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,9999999999) ON CONFLICT(cache_key) DO NOTHING'
            ).bind(`otd_player_${slug}_${pid}`, JSON.stringify({ name: rsName, id: pid })).run().catch(() => {})
          );
        }
      }
      if (newWrites.length) context.waitUntil(Promise.all(newWrites));
    } catch {}
  }

  // RS sync cache: fullMatchup (lowercased) → rsGameId
  const syncGameIds = {};
  if (syncRow.status === 'fulfilled' && syncRow.value?.data) {
    try {
      const syncData = JSON.parse(syncRow.value.data);
      for (const [key, val] of Object.entries(syncData)) {
        if (key.endsWith('__gid')) syncGameIds[key.slice(0, -5).toLowerCase()] = val;
      }
    } catch {}
  }

  // Props cache: DK events with full team names → match to RS sync game IDs
  const gamesByEventId = {};
  if (propsRow.status === 'fulfilled' && propsRow.value?.data) {
    try {
      const propsData = JSON.parse(propsRow.value.data);
      for (const g of (propsData.games || [])) {
        if (!g.eventId || !g.away || !g.home) continue;
        const awayLc   = g.away.toLowerCase();
        const homeLc   = g.home.toLowerCase();
        const exactKey = awayLc + ' @ ' + homeLc;
        let rsGameId   = syncGameIds[exactKey];
        if (!rsGameId) {
          for (const [k, v] of Object.entries(syncGameIds)) {
            if (k.includes(awayLc) && k.includes(homeLc)) { rsGameId = v; break; }
          }
        }
        if (rsGameId) gamesByEventId[String(g.eventId)] = rsGameId;
      }
    } catch {}
  }

  return new Response(JSON.stringify({ ok: true, ids, gamesByEventId }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
