// functions/api/dk/cfb-lines.js
// GET /api/dk/cfb-lines
// Returns upcoming NCAAF game ML odds from DK.
// League ID 87637, subcat 4518 (Game Lines: ML / Spread / Total).
// Returns ML only. Team keys use DK shortName (FSU, NMSU) to match RS team abbreviations.

import { getSessionOrCron } from '../../_lib/auth.js';

const DK_BASE      = 'https://sportsbook-nash.draftkings.com/sites/US-SB/api/sportscontent';
const DK_LEAGUE    = '87637'; // NCAAF
const LINES_SUBCAT = '4518';  // ML / Spread / Total (same subcat as NFL)
const CACHE_TTL    = 300;     // 5 minutes
const CACHE_KEY    = 'dk_cfb_lines_v1';

const DK_HEADERS = {
  'Accept':         '*/*',
  'User-Agent':     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
  'Origin':         'https://sportsbook.draftkings.com',
  'Referer':        'https://sportsbook.draftkings.com/',
  'x-client-name': 'web',
};

function parseOdds(american) {
  if (!american) return null;
  const s = String(american).replace(/−/g, '-').replace(/[^\d+\-]/g, '');
  if (!s || s === '-' || s === '+') return null;
  const n = parseInt(s, 10);
  return isFinite(n) ? n : null;
}

function eventsUrl() {
  const eq = encodeURIComponent(`$filter=leagueId eq '${DK_LEAGUE}' AND clientMetadata/Subcategories/any(s: s/Id eq '${LINES_SUBCAT}')`);
  const mq = encodeURIComponent(`$filter=clientMetadata/subCategoryId eq '${LINES_SUBCAT}' AND tags/all(t: t ne 'SportcastBetBuilder')`);
  return `${DK_BASE}/controldata/league/leagueSubcategory/v1/markets?isBatchable=false&templateVars=${DK_LEAGUE}%2C${LINES_SUBCAT}&eventsQuery=${eq}&marketsQuery=${mq}&include=Events&entity=events`;
}

function linesUrl(eventId) {
  const mq = encodeURIComponent(
    `$filter=eventId eq '${eventId}' AND clientMetadata/subCategoryId eq '${LINES_SUBCAT}' AND tags/all(t: t ne 'SportcastBetBuilder')`
  );
  return `${DK_BASE}/controldata/event/eventSubcategory/v1/markets?isBatchable=false` +
         `&templateVars=${eventId}%2C${LINES_SUBCAT}&marketsQuery=${mq}&include=MarketSplits&entity=markets`;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSessionOrCron(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  const url     = new URL(request.url);
  const debug   = url.searchParams.get('debug');
  const nocache = url.searchParams.has('nocache');
  const now     = Math.floor(Date.now() / 1000);
  const windowMs = 14 * 24 * 60 * 60 * 1000; // 14-day lookahead

  if (!nocache && !debug) {
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(CACHE_KEY).first();
      if (cached && (now - cached.fetched_at) < CACHE_TTL) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
      }
    } catch(e) {}
  }

  const evRes = await fetch(eventsUrl(), { headers: DK_HEADERS, signal: AbortSignal.timeout(12000) });
  if (!evRes.ok) {
    return new Response(JSON.stringify({ ok: false, error: 'events fetch failed', status: evRes.status }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const evData = await evRes.json();

  const nowMs = Date.now();
  const upcomingEvents = (evData.events || []).filter(e => {
    const ms = e.startEventDate ? new Date(e.startEventDate).getTime() : 0;
    // Include games that started within the last 2h (in-progress) and up to 14 days out
    return ms > nowMs - 2 * 3600 * 1000 && ms < nowMs + windowMs;
  });

  if (!upcomingEvents.length) {
    return new Response(JSON.stringify({ ok: true, games: {}, count: 0, ts: now }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (debug === '1') {
    const e = upcomingEvents[0];
    const raw = await fetch(linesUrl(String(e.id)), { headers: DK_HEADERS, signal: AbortSignal.timeout(10000) });
    const rawData = await raw.json();
    return new Response(JSON.stringify({ eventId: e.id, participants: e.participants, rawData }, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Fetch ML odds for all events in parallel (8s timeout per request)
  const allResults = await Promise.all(upcomingEvents.map(async e => {
    const startMs  = e.startEventDate ? new Date(e.startEventDate).getTime() : 0;
    const parts    = e.participants || [];
    const homePart = parts.find(p => p.venueRole === 'Home');
    const awayPart = parts.find(p => p.venueRole === 'Away');
    if (!homePart || !awayPart) return null;

    const homeShort = homePart.metadata?.shortName || homePart.name || '';
    const awayShort = awayPart.metadata?.shortName || awayPart.name || '';
    const homeTeam  = homePart.name || homeShort;
    const awayTeam  = awayPart.name || awayShort;
    const homeConf  = homePart.metadata?.conferenceShortName || '';
    const awayConf  = awayPart.metadata?.conferenceShortName || '';

    try {
      const res = await fetch(linesUrl(String(e.id)), { headers: DK_HEADERS, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const data = await res.json();

      // Find Moneyline market only
      const mlMkt = (data.markets || []).find(m => (m.name || '').toLowerCase() === 'moneyline');
      if (!mlMkt) return null;
      const mlSels = (data.selections || []).filter(s => String(s.marketId) === String(mlMkt.id));
      const homeSel = mlSels.find(s => s.outcomeType === 'Home');
      const awaySel = mlSels.find(s => s.outcomeType === 'Away');
      if (!homeSel || !awaySel) return null;

      const homeOdds = parseOdds(homeSel.displayOdds?.american);
      const awayOdds = parseOdds(awaySel.displayOdds?.american);
      if (homeOdds == null || awayOdds == null) return null;

      return {
        gameKey: awayShort + ' @ ' + homeShort,
        away: awayShort,
        home: homeShort,
        awayFull: awayTeam,
        homeFull: homeTeam,
        awayConf,
        homeConf,
        id: String(e.id),
        cm: startMs,
        awayOdds,
        homeOdds,
      };
    } catch(err) { return null; }
  }));

  const games = {};
  allResults
    .filter(Boolean)
    .sort((a, b) => a.cm - b.cm)
    .forEach(g => { games[g.gameKey] = g; });

  const payload = JSON.stringify({ ok: true, games, count: Object.keys(games).length, ts: now });

  context.waitUntil(
    env.DB.prepare(
      'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
    ).bind(CACHE_KEY, payload, now).run().catch(() => {})
  );

  return new Response(payload, { headers: { 'Content-Type': 'application/json' } });
}
