// GET /api/espn/player-ids?sport=mlb|wnba
// Returns a name→ESPN-id map for all rostered players in the given sport.
// Cached in D1 for 24 hours. Static JSON fallback bundled in repo.

import mlbIds  from './mlb-ids.json'  assert { type: 'json' };
import wnbaIds from './wnba-ids.json' assert { type: 'json' };

const ESPN_CACHE_TTL = 86400; // 24hr

const SPORT_CONFIG = {
  mlb:  { espnSport: 'baseball',   espnLeague: 'mlb',  staticIds: mlbIds  },
  wnba: { espnSport: 'basketball', espnLeague: 'wnba', staticIds: wnbaIds },
};

export async function onRequestGet({ request, env }) {
  const url   = new URL(request.url);
  const sport = url.searchParams.get('sport') || 'mlb';
  const cfg   = SPORT_CONFIG[sport];
  if (!cfg) return new Response(JSON.stringify({ error: 'unknown sport' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const now      = Math.floor(Date.now() / 1000);
  const cacheKey = `espn_player_ids:${sport}`;
  const nocache  = url.searchParams.has('nocache');

  if (!nocache) {
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < ESPN_CACHE_TTL) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
      }
    } catch(e) {}
  }

  // Attempt live ESPN fetch; fall back to bundled static map
  const players = await buildPlayerMap(cfg.espnSport, cfg.espnLeague) || cfg.staticIds;
  const payload = JSON.stringify({ players, sport, count: Object.keys(players).length, ts: now });

  try {
    await env.DB.prepare(
      'INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at'
    ).bind(cacheKey, payload, now).run();
  } catch(e) {}

  return new Response(payload, { headers: { 'Content-Type': 'application/json' } });
}

export async function buildPlayerMap(espnSport, espnLeague) {
  try {
    const teamsRes = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/${espnSport}/${espnLeague}/teams?limit=50`
    );
    if (!teamsRes.ok) return null;
    const teamsData = await teamsRes.json();
    const teams = (teamsData.sports?.[0]?.leagues?.[0]?.teams || [])
      .map(t => t.team).filter(t => t?.id);
    if (!teams.length) return null;

    const rosterResults = await Promise.allSettled(
      teams.map(t =>
        fetch(`https://site.api.espn.com/apis/site/v2/sports/${espnSport}/${espnLeague}/teams/${t.id}/roster`)
          .then(r => r.json())
      )
    );

    const SUFFIX_RE = /\s+(jr\.?|sr\.?|ii|iii|iv)$/i;
    const players = {};
    for (const r of rosterResults) {
      if (r.status !== 'fulfilled') continue;
      const roster = r.value;
      const athletes = roster.athletes || [];
      for (const entry of athletes) {
        // MLB: grouped by position — entry has .items[]; WNBA: flat — entry is the athlete
        const items = entry.items || (entry.id ? [entry] : []);
        for (const a of items) {
          if (!a.id || !a.fullName) continue;
          const full = a.fullName.toLowerCase();
          const norm = full.replace(SUFFIX_RE, '');
          const id   = String(a.id);
          players[full] = id;
          if (norm !== full) players[norm] = id; // also store without suffix
        }
      }
    }
    return Object.keys(players).length > 0 ? players : null;
  } catch(e) {
    return null;
  }
}
