import { getSessionOrCron } from '../../_lib/auth.js';
// functions/api/fd/fc.js
// EPL Asian Handicap odds via The Odds API (DK bookmaker as reference).
// DK/FD native endpoints are blocked from CF datacenter IPs for soccer (Akamai / competition page 400).
// Cache 5 minutes in D1 to conserve Odds API credits.

const ODDS_SPORT = 'soccer_epl';
const CACHE_TTL  = 300; // 5 minutes

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSessionOrCron(request, env);
  if (!session) return fail(401, 'Not authenticated');
  if (session.plan !== 'pro' && !session.is_admin) return fail(403, 'Pro plan required');

  const reqUrl   = new URL(request.url);
  const debugMode = reqUrl.searchParams.get('debug');
  const freshMode = reqUrl.searchParams.get('fresh');

  const now      = Math.floor(Date.now() / 1000);
  const cacheKey = 'fd_fc';

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

  const apiKey = env.ODDS_API_KEY;
  if (!apiKey) return fail(500, 'ODDS_API_KEY not configured');

  const oddsUrl = `https://api.the-odds-api.com/v4/sports/${ODDS_SPORT}/odds/?apiKey=${apiKey}&regions=us&markets=spreads&oddsFormat=american&dateFormat=iso`;

  let raw;
  try {
    const r = await fetch(oddsUrl, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return fail(r.status, `Odds API error: ${body.slice(0, 200)}`);
    }
    raw = await r.json();
  } catch(e) {
    return fail(502, `Odds API fetch failed: ${e.message}`);
  }

  if (!Array.isArray(raw)) {
    return fail(502, 'Unexpected Odds API response');
  }

  if (debugMode === '1') {
    // Also probe sport list to confirm API key works and soccer_epl is available
    let sportsCheck = null;
    try {
      const sr = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${apiKey}`, { signal: AbortSignal.timeout(8000) });
      const sports = await sr.json();
      sportsCheck = Array.isArray(sports) ? sports.filter(s => s.key?.startsWith('soccer')).map(s => s.key) : sports;
    } catch(e) { sportsCheck = { error: e.message }; }
    return new Response(JSON.stringify({ count: raw.length, events: raw.slice(0,3), soccerSports: sportsCheck }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const nowMs = Date.now();
  const gamesMap = {};

  for (const ev of raw) {
    // Skip games that started more than 4 hours ago (live but likely decided)
    const commenceMs = new Date(ev.commence_time).getTime();
    if (commenceMs < nowMs - 4 * 60 * 60 * 1000) continue;

    const homeTeam = ev.home_team;
    const awayTeam = ev.away_team;
    if (!homeTeam || !awayTeam) continue;

    // Find DK bookmaker, fallback to first available
    const dk = ev.bookmakers?.find(b => b.key === 'draftkings')
            || ev.bookmakers?.find(b => b.key === 'fanduel')
            || ev.bookmakers?.[0];
    if (!dk) continue;

    const market = dk.markets?.find(m => m.key === 'spreads');
    if (!market?.outcomes?.length) continue;

    // Extract ±0.5 AH prices for home and away
    const hm  = market.outcomes.find(o => o.name === homeTeam && Number(o.point) === -0.5)?.price ?? null;
    const hp  = market.outcomes.find(o => o.name === homeTeam && Number(o.point) ===  0.5)?.price ?? null;
    const awm = market.outcomes.find(o => o.name === awayTeam && Number(o.point) === -0.5)?.price ?? null;
    const awp = market.outcomes.find(o => o.name === awayTeam && Number(o.point) ===  0.5)?.price ?? null;

    if (debugMode === '2') {
      const allOutcomes = market.outcomes.map(o => ({ name: o.name, point: o.point, price: o.price }));
      gamesMap[awayTeam + ' @ ' + homeTeam] = { homeTeam, awayTeam, book: dk.key, hm, hp, awm, awp, allOutcomes };
      continue;
    }

    if (!hm && !hp && !awm && !awp) continue;

    const spreadsObj = { Home: {}, Away: {} };
    if (hm  != null) spreadsObj.Home['-0.5'] = hm;
    if (hp  != null) spreadsObj.Home['0.5']  = hp;
    if (awm != null) spreadsObj.Away['-0.5'] = awm;
    if (awp != null) spreadsObj.Away['0.5']  = awp;

    const gameKey = awayTeam + ' @ ' + homeTeam;
    gamesMap[gameKey] = {
      id:      ev.id,
      away:    awayTeam,
      home:    homeTeam,
      cm:      ev.commence_time,
      league:  'EPL',
      hm, hp, awm, awp,
      spreads: spreadsObj,
    };
  }

  if (debugMode === '2') {
    return new Response(JSON.stringify({ ok: true, games: gamesMap }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const body = JSON.stringify({ ok: true, games: gamesMap });

  try {
    await env.DB.prepare(
      'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
    ).bind(cacheKey, body, now).run();
  } catch(e) {}

  return new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
