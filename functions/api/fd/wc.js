import { getSessionOrCron } from '../../_lib/auth.js';
// functions/api/fd/wc.js
// Fetches DraftKings real-time FIFA World Cup Asian Handicap ±0.5 spread odds
// Subcat 13170 = 2-way AH (Home -0.5 / Away +0.5), same as FC tab — no draw
// Step 1: Get today's WC events from DK league endpoint
// Step 2: For each event, fetch subcat 13170 to get actual ±0.5 prices

const DK_BASE      = 'https://sportsbook-nash.draftkings.com/sites/US-SB/api/sportscontent';
const DK_SUBCAT    = '13170'; // WC Asian Handicap ±0.5 — same subcat as regular FC leagues
const CACHE_TTL    = 4; // 4s ensures 5s frontend poller always gets a fresh DK fetch

const DK_WC_LEAGUES = {
  '209533': 'WC', // FIFA World Cup 2026
};

function dkLeagueEventsUrl(leagueId) {
  const eq = encodeURIComponent(`$filter=leagueId eq '${leagueId}'`);
  const mq = encodeURIComponent(
    `$filter=clientMetadata/subCategoryId eq '${DK_SUBCAT}' AND tags/all(t: t ne 'SportcastBetBuilder')`
  );
  return `${DK_BASE}/controldata/league/leagueSubcategory/v1/markets?isBatchable=false&templateVars=${leagueId}&eventsQuery=${eq}&marketsQuery=${mq}&include=Events&entity=events`;
}

function dkEventSubcatUrl(eventId) {
  const mq = encodeURIComponent(
    `$filter=eventId eq '${eventId}' AND clientMetadata/subCategoryId eq '${DK_SUBCAT}' AND tags/all(t: t ne 'SportcastBetBuilder')`
  );
  return `${DK_BASE}/controldata/event/eventSubcategory/v1/markets?isBatchable=false&templateVars=${eventId}%2C${DK_SUBCAT}&marketsQuery=${mq}&include=MarketSplits&entity=markets`;
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
  if (session.plan !== 'pro' && !session.is_admin) return fail(403, 'Pro plan required');

  const reqUrl    = new URL(request.url);
  const debugMode = reqUrl.searchParams.get('debug');
  const freshMode = reqUrl.searchParams.get('fresh');

  const now      = Math.floor(Date.now() / 1000);
  const cacheKey = 'fd_wc';

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
    'x-client-widget-name': 'cms',
    'x-client-widget-version': '2.13.0',
    'x-client-page': 'league',
    'x-client-feature': 'leagueSubcategory',
  };

  const nowMs = Date.now();

  try {
    // Step 1: Fetch WC league events
    const leagueEntries = Object.entries(DK_WC_LEAGUES);
    const leagueResults = await Promise.all(leagueEntries.map(async ([leagueId, leagueLabel]) => {
      const events = [];
      try {
        const r = await fetch(dkLeagueEventsUrl(leagueId), { headers });
        if (!r.ok) {
          if (debugMode === '1') events.push({ _error: `league ${leagueId} status ${r.status}` });
          return events;
        }
        const d = await r.json();
        if (debugMode === '1' && !d.events) events.push({ _warn: `league ${leagueId} no events key`, keys: Object.keys(d) });

        for (const ev of d.events || []) {

          let home, away;
          const parts_arr = ev.participants || [];
          const homeP = parts_arr.find(p => p.venueRole === 'Home');
          const awayP = parts_arr.find(p => p.venueRole === 'Away');
          if (homeP && awayP) {
            home = homeP.name; away = awayP.name;
          } else {
            const parts = (ev.name || '').split(' vs ');
            if (parts.length !== 2) continue;
            home = parts[0].trim(); away = parts[1].trim();
          }

          events.push({ eventId: ev.id, home, away, league: leagueLabel, openDate: ev.startEventDate });
        }
      } catch(e) {}
      return events;
    }));

    const todayEvents = leagueResults.flat();

    if (debugMode === '1') {
      return new Response(JSON.stringify({ todayEventsFound: todayEvents.length, events: todayEvents }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!todayEvents.length) {
      return new Response(JSON.stringify({ ok: true, games: {} }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Step 2: Fetch AH markets for all events in parallel
    let prevGames = {};
    try {
      const prev = await env.DB.prepare('SELECT data FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
      if (prev) prevGames = JSON.parse(prev.data).games || {};
    } catch(e) {}

    const gamesMap = {};

    await Promise.all(todayEvents.map(async (ev) => {
      const gameKey = ev.away + ' @ ' + ev.home;
      try {
        const r = await fetch(dkEventSubcatUrl(ev.eventId), { headers });
        if (!r.ok) return;
        const d = await r.json();

        const spreads = { Home: {}, Away: {} };
        for (const sel of d.selections || []) {
          const pts   = sel.points;
          const ot    = sel.outcomeType;
          const price = parseAmerican(sel.displayOdds && sel.displayOdds.american);
          if (price == null || pts == null) continue;
          if (ot !== 'Home' && ot !== 'Away') continue;
          spreads[ot][String(pts)] = price;
        }

        const homeMinus = spreads.Home['-0.5'] || null;
        const homePlus  = spreads.Home['0.5']  || null;
        const awayMinus = spreads.Away['-0.5'] || null;
        const awayPlus  = spreads.Away['0.5']  || null;

        if (debugMode === '2') {
          const allSels = (d.selections || []).map(s => ({ label: s.label, outcomeType: s.outcomeType, points: s.points, odds: s.displayOdds && s.displayOdds.american }));
          gamesMap[gameKey] = { home: ev.home, away: ev.away, hm: homeMinus, hp: homePlus, awm: awayMinus, awp: awayPlus, spreads, allSels };
          return;
        }

        if (!Object.keys(spreads.Home).length && !Object.keys(spreads.Away).length) {
          // DK suspended AH market — freeze last known odds
          const frozen = prevGames[gameKey] || prevGames[ev.away + ' @ ' + ev.home] || null;
          if (frozen && (Object.keys(frozen.spreads?.Home || {}).length || Object.keys(frozen.spreads?.Away || {}).length)) {
            gamesMap[gameKey] = { ...frozen, id: parseInt(ev.eventId), away: ev.away, home: ev.home, cm: ev.openDate, live: true };
          }
          return;
        }

        gamesMap[gameKey] = {
          id: parseInt(ev.eventId),
          away: ev.away,
          home: ev.home,
          cm: ev.openDate,
          league: ev.league,
          hm: homeMinus,
          hp: homePlus,
          awm: awayMinus,
          awp: awayPlus,
          spreads
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
      ).bind(cacheKey, body, now).run();
    } catch(e) {}

    return new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

  } catch(e) {
    return fail(500, e.message);
  }
}
