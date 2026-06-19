// functions/api/scores.js
// GET /api/scores?sport=baseball_mlb
// Returns live scores from ESPN public scoreboard API — free, no auth needed from ESPN

import { getSessionOrCron } from '../_lib/auth.js';

const ESPN_URLS = {
  'baseball_mlb':    'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard',
  'basketball_wnba': 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard',
  'icehockey_nhl':   'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard',
  'soccer_wc':       'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard',
  'baseball_cws':    'https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball/scoreboard',
};

const CACHE_TTL = 20;

function fail(status, msg) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

function makeLabel(sport, period, clock, statusName, shortDetail) {
  if (statusName === 'STATUS_FINAL' || statusName === 'STATUS_FULL_TIME') return 'Final';
  if (statusName === 'STATUS_HALFTIME') return 'HT';
  if (statusName === 'STATUS_SCHEDULED' || statusName === 'STATUS_PREGAME') return shortDetail || '';

  if (sport === 'baseball_mlb' || sport === 'baseball_cws') {
    // shortDetail is already formatted: "Top 7th", "Bot 3rd", "Mid 5th"
    return (shortDetail || '').replace('Bottom', 'Bot').replace('Middle', 'Mid') || (period ? `Inn ${period}` : '');
  }
  if (sport === 'icehockey_nhl') {
    if (period > 3) return clock && clock !== '0:00' ? `OT ${clock}` : 'OT';
    return clock && clock !== '0:00' ? `P${period} ${clock}` : `P${period}`;
  }
  if (sport === 'basketball_wnba') {
    if (period > 4) return clock && clock !== '0:00' ? `OT ${clock}` : 'OT';
    return clock && clock !== '0:00' ? `Q${period} ${clock}` : (period ? `Q${period}` : '');
  }
  if (sport === 'soccer_wc' || sport === 'soccer_fc') {
    return clock && clock !== '0:00' ? `${clock}'` : (period === 2 ? '2nd' : period === 1 ? '1st' : shortDetail || '');
  }
  return shortDetail || '';
}

export async function onRequestGet({ request, env }) {
  const session = await getSessionOrCron(request, env);
  if (!session) return fail(401, 'Not authenticated');

  const url = new URL(request.url);
  const sport = url.searchParams.get('sport');
  if (!sport || !ESPN_URLS[sport]) {
    return fail(400, 'Unsupported sport. Valid: ' + Object.keys(ESPN_URLS).join(', '));
  }

  const cacheKey = 'scores_' + sport;
  const now = Math.floor(Date.now() / 1000);

  try {
    const cached = await env.DB.prepare(
      'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
    ).bind(cacheKey).first();
    if (cached && (now - cached.fetched_at) < CACHE_TTL) {
      return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
    }
  } catch(e) {}

  try {
    const res = await fetch(ESPN_URLS[sport], {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return fail(res.status, 'ESPN fetch failed: ' + res.status);

    const data = await res.json();
    const games = [];

    for (const event of (data.events || [])) {
      const comp = event.competitions?.[0];
      if (!comp) continue;

      const home = (comp.competitors || []).find(c => c.homeAway === 'home');
      const away = (comp.competitors || []).find(c => c.homeAway === 'away');
      if (!home || !away) continue;

      const status    = comp.status || {};
      const st        = status.type || {};
      const period    = status.period || 0;
      const clock     = status.displayClock || '';
      const completed = st.completed || false;
      const state     = st.state || 'pre'; // 'pre' | 'in' | 'post'
      const label     = makeLabel(sport, period, clock, st.name || '', st.shortDetail || st.detail || '');

      games.push({
        awayTeam:  away.team?.displayName || away.team?.name || '',
        homeTeam:  home.team?.displayName || home.team?.name || '',
        awayAbbrv: away.team?.abbreviation || '',
        homeAbbrv: home.team?.abbreviation || '',
        awayScore: parseInt(away.score || '0', 10),
        homeScore: parseInt(home.score || '0', 10),
        period,
        clock,
        label,
        status:    completed ? 'final' : state === 'in' ? 'live' : 'pre',
        startTime: event.date || '',
      });
    }

    const body = JSON.stringify({ ok: true, sport, games });
    try {
      await env.DB.prepare(
        'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
      ).bind(cacheKey, body, now).run();
    } catch(e) {}

    return new Response(body, { headers: { 'Content-Type': 'application/json' } });

  } catch(e) {
    return fail(500, e.message);
  }
}
