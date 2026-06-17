import { getSessionOrCron } from '../../_lib/auth.js';
// functions/api/dk/cws.js
// Fetches DraftKings College World Series (NCAA Baseball) moneyline odds
// League 41151 = DK College Baseball (CWS)
// RS sport: ncaabb
// Step 1: Get today's CWS events from DK league 41151
// Step 2: For each event, fetch all markets and extract "Game Winner" ML prices

const DK_BASE     = 'https://sportsbook-nash.draftkings.com/sites/US-SB/api/sportscontent';
const DK_LEAGUE   = '41151'; // College Baseball / CWS
const CACHE_TTL   = 5;
const CACHE_KEY   = 'dk_cws';

const DK_ML_SUBCAT = '4519'; // DK baseball Game Winner (moneyline)

function dkLeagueEventsUrl() {
  const eq = encodeURIComponent(`$filter=leagueId eq '${DK_LEAGUE}'`);
  const mq = encodeURIComponent(`$filter=clientMetadata/subCategoryId eq '${DK_ML_SUBCAT}' AND tags/all(t: t ne 'SportcastBetBuilder')`);
  return `${DK_BASE}/controldata/league/leagueSubcategory/v1/markets?isBatchable=false&templateVars=${DK_LEAGUE}&eventsQuery=${eq}&marketsQuery=${mq}&include=Events&entity=events`;
}

function dkEventMarketsUrl(eventId) {
  const mq = encodeURIComponent(
    `$filter=eventId eq '${eventId}' AND clientMetadata/subCategoryId eq '${DK_ML_SUBCAT}' AND tags/all(t: t ne 'SportcastBetBuilder')`
  );
  return `${DK_BASE}/controldata/event/eventSubcategory/v1/markets?isBatchable=false&templateVars=${eventId}%2C${DK_ML_SUBCAT}&marketsQuery=${mq}&include=MarketSplits&entity=markets`;
}

function parseAmerican(str) {
  if (!str) return null;
  const s = String(str).replace(/−/g, '-').replace(/[^0-9+\-]/g, '');
  const n = parseInt(s, 10);
  return isFinite(n) ? n : null;
}

function isToday_ET(dateStr) {
  if (!dateStr) return false;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  return fmt.format(new Date(dateStr)) === fmt.format(new Date());
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

  const reqUrl    = new URL(request.url);
  const debugMode = reqUrl.searchParams.get('debug');
  const freshMode = reqUrl.searchParams.get('fresh');

  const now = Math.floor(Date.now() / 1000);

  if (!debugMode && !freshMode) {
    try {
      const cached = await env.DB.prepare(
        'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
      ).bind(CACHE_KEY).first();
      if (cached && (now - cached.fetched_at) < CACHE_TTL) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      }
    } catch(e) {}
  }

  const headers = {
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15',
    'Origin': 'https://sportsbook.draftkings.com',
    'Referer': 'https://sportsbook.draftkings.com/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors',
    'x-client-name': 'web',
    'x-client-version': '2624.3.1.5',
  };

  try {
    // Step 1: Get today's CWS events
    const evRes = await fetch(dkLeagueEventsUrl(), { headers });
    if (!evRes.ok) return fail(evRes.status, 'DK league fetch failed: ' + evRes.status);
    const evData = await evRes.json();

    const todayEvents = [];
    for (const ev of evData.events || []) {
      if (!isToday_ET(ev.startEventDate)) continue;
      let home, away;
      const homeP = (ev.participants || []).find(p => p.venueRole === 'Home');
      const awayP = (ev.participants || []).find(p => p.venueRole === 'Away');
      if (homeP && awayP) { home = homeP.name; away = awayP.name; }
      else {
        const parts = (ev.name || '').split(' @ ');
        if (parts.length !== 2) continue;
        away = parts[0].trim(); home = parts[1].trim();
      }
      todayEvents.push({ eventId: ev.id, home, away, cm: ev.startEventDate });
    }

    if (debugMode === '1') {
      return new Response(JSON.stringify({ eventsFound: todayEvents.length, events: todayEvents }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!todayEvents.length) {
      return new Response(JSON.stringify({ ok: true, games: {} }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Step 2: Fetch ML (Game Winner) markets for each event in parallel
    const gamesMap = {};

    await Promise.all(todayEvents.map(async (ev) => {
      const gameKey = ev.away + ' @ ' + ev.home;
      try {
        const r = await fetch(dkEventMarketsUrl(ev.eventId), { headers, signal: AbortSignal.timeout(5000) });
        if (!r.ok) return;
        const d = await r.json();

        if (debugMode === '2') {
          const allMkts = (d.selections || []).map(s => ({
            label: s.label, outcomeType: s.outcomeType, points: s.points,
            odds: s.displayOdds && s.displayOdds.american,
            marketLabel: s.marketLabel || s.subcategoryLabel
          }));
          gamesMap[gameKey] = { home: ev.home, away: ev.away, cm: ev.cm, allMkts };
          return;
        }

        // Find Game Winner (ML) selections — Home and Away with no point spread
        let homeOdds = null, awayOdds = null;
        for (const sel of d.selections || []) {
          const ot    = sel.outcomeType;
          const pts   = sel.points;
          const odds  = parseAmerican(sel.displayOdds && sel.displayOdds.american);
          if (odds == null) continue;
          // ML = no points (or 0 points), Home or Away outcomeType
          if ((pts == null || pts === 0) && ot === 'Home') homeOdds = odds;
          if ((pts == null || pts === 0) && ot === 'Away') awayOdds = odds;
        }

        if (homeOdds == null || awayOdds == null) return;

        gamesMap[gameKey] = {
          id: parseInt(ev.eventId),
          away: ev.away,
          home: ev.home,
          cm: ev.cm,
          awayOdds,
          homeOdds,
        };
      } catch(e) {}
    }));

    if (debugMode === '2') {
      return new Response(JSON.stringify({ ok: true, games: gamesMap }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const body = JSON.stringify({ ok: true, games: gamesMap });
    try {
      await env.DB.prepare(
        'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
      ).bind(CACHE_KEY, body, now).run();
    } catch(e) {}

    return new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

  } catch(e) {
    return fail(500, e.message);
  }
}
