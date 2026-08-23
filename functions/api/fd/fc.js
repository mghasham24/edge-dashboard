import { getSessionOrCron } from '../../_lib/auth.js';
// functions/api/fd/fc.js
// EPL Spread odds (subcat 13170) via DK native, proxied through Hetzner VPS.
// DK native is Akamai-blocked from CF datacenter IPs — VPS at vps.raxedge.com:3003 bypasses this.
// VPS /dk-soccer: fetches league events + per-event spread markets, returns { ok, games }
// VPS /dk-events: proxies DK pagedata events endpoint for live score data (period, score)

const VPS_HOST  = 'http://vps.raxedge.com:3003';
const DK_LEAGUE = '40253'; // EPL
const DK_SUBCAT = '13170'; // Spread
const CACHE_TTL = 60; // 60 seconds

const noGames = () => new Response(JSON.stringify({ ok: true, games: {} }), {
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

function parseLiveEvents(dkEventsRaw) {
  // Parse DK pagedata/event/v1/events response for live score data
  // Returns { eventId: { period, gameTime, homeScore, awayScore, isLive } }
  const result = {};
  try {
    const events = dkEventsRaw.events || dkEventsRaw.eventList || [];
    events.forEach(ev => {
      const id = String(ev.id || ev.eventId || '');
      if (!id) return;
      const live = ev.competition || ev.eventStatus || {};
      const period    = live.period || live.displayPeriod || '';
      const gameTime  = live.gameTime  != null ? live.gameTime  : (live.clock != null ? live.clock : null);
      const homeScore = live.homeScore != null ? live.homeScore : (live.homeTeamScore != null ? live.homeTeamScore : null);
      const awayScore = live.awayScore != null ? live.awayScore : (live.awayTeamScore != null ? live.awayTeamScore : null);
      const isLive    = ev.status === 'inprogress' || (ev.eventStatus && ev.eventStatus.state === 'inprogress')
                     || (period && period !== '' && homeScore != null);
      if (isLive || homeScore != null) {
        result[id] = { period, gameTime, homeScore, awayScore, isLive: !!isLive };
      }
    });
  } catch(e) {}
  return result;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSessionOrCron(request, env);
  if (!session) return fail(401, 'Not authenticated');
  if (session.plan !== 'pro' && !session.is_admin) return fail(403, 'Pro plan required');

  const reqUrl    = new URL(request.url);
  const debugMode = reqUrl.searchParams.get('debug');
  const freshMode = reqUrl.searchParams.get('fresh');

  const now      = Math.floor(Date.now() / 1000);
  const cacheKey = 'fd_fc_v2';

  if (!debugMode && !freshMode) {
    try {
      const cached = await env.DB.prepare(
        'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
      ).bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < CACHE_TTL) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      }
    } catch(e) {}
  }

  const vpsKey = env.VPS_DK_KEY || 'rax-dk-9x3m7p2q';
  if (!vpsKey) return noGames();

  const soccerUrl = `${VPS_HOST}/dk-soccer?league=${DK_LEAGUE}&subcat=${DK_SUBCAT}&key=${encodeURIComponent(vpsKey)}`;

  let raw;
  try {
    const r = await fetch(soccerUrl, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) {
      if (debugMode === '1') {
        const body = await r.text().catch(() => '');
        return new Response(JSON.stringify({ vpsStatus: r.status, body }), { headers: { 'Content-Type': 'application/json' } });
      }
      return noGames();
    }
    raw = await r.json();
  } catch(e) {
    if (debugMode === '1') {
      return new Response(JSON.stringify({ error: e.message }), { headers: { 'Content-Type': 'application/json' } });
    }
    return noGames();
  }

  if (!raw || !raw.ok || !raw.games) return noGames();

  if (debugMode === '1') {
    const games = raw.games || {};
    return new Response(JSON.stringify({ count: Object.keys(games).length, games: Object.fromEntries(Object.entries(games).slice(0, 3)) }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (debugMode === '2') {
    return new Response(JSON.stringify(raw), { headers: { 'Content-Type': 'application/json' } });
  }

  // Fetch live score data for all events in parallel
  const eventIds = Object.values(raw.games).map(g => g.id).filter(Boolean);
  let liveMap = {};

  if (eventIds.length) {
    try {
      const eventsUrl = `${VPS_HOST}/dk-events?eventIds=${encodeURIComponent(eventIds.join(','))}&key=${encodeURIComponent(vpsKey)}`;
      const evRes = await fetch(eventsUrl, { signal: AbortSignal.timeout(8000) });
      if (evRes.ok) {
        const evRaw = await evRes.json();
        liveMap = parseLiveEvents(evRaw);
      }
    } catch(e) {}
  }

  if (debugMode === '3') {
    return new Response(JSON.stringify({ liveMap, eventIds }), { headers: { 'Content-Type': 'application/json' } });
  }

  // Merge live data into game objects
  const enrichedGames = {};
  Object.entries(raw.games).forEach(([gameKey, game]) => {
    const liveData = game.id ? liveMap[game.id] : null;
    enrichedGames[gameKey] = { ...game, live: liveData || null };
  });

  const body = JSON.stringify({ ok: true, games: enrichedGames });
  try {
    await env.DB.prepare(
      'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
    ).bind(cacheKey, body, now).run();
  } catch(e) {}

  return new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
