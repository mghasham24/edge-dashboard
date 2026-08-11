// functions/api/dk/mlb-lines.js
// GET /api/dk/mlb-lines
// Returns today's MLB game lines (ML, Run Line, Total) from DK for the parlay builder.
// Uses event IDs sourced from the existing hits subcategory fetch.

import { getSessionOrCron } from '../../_lib/auth.js';

const DK_BASE    = 'https://sportsbook-nash.draftkings.com/sites/US-SB/api/sportscontent';
const DK_LEAGUE  = '84240';
const LINES_SUBCAT = '4519';
const HITS_SUBCAT  = '6719'; // used only to discover today's event IDs + team metadata
const CACHE_TTL  = 60;
const CACHE_KEY  = 'dk_mlb_lines_v2';

const DK_HEADERS = {
  'Accept':         '*/*',
  'User-Agent':     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
  'Origin':         'https://sportsbook.draftkings.com',
  'Referer':        'https://sportsbook.draftkings.com/',
  'x-client-name': 'web',
};

function todayET() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

function parseOdds(american) {
  if (!american) return null;
  const s = String(american).replace(/−/g, '-').replace(/[^0-9+\-]/g, '');
  const n = parseInt(s, 10);
  return isFinite(n) ? n : null;
}

function hitsLeagueUrl() {
  const eq = encodeURIComponent(`$filter=leagueId eq '${DK_LEAGUE}' AND clientMetadata/Subcategories/any(s: s/Id eq '${HITS_SUBCAT}')`);
  const mq = encodeURIComponent(`$filter=clientMetadata/subCategoryId eq '${HITS_SUBCAT}' AND tags/all(t: t ne 'SportcastBetBuilder')`);
  return `${DK_BASE}/controldata/league/leagueSubcategory/v1/markets?isBatchable=false&templateVars=${DK_LEAGUE}%2C${HITS_SUBCAT}&eventsQuery=${eq}&marketsQuery=${mq}&include=Events&entity=events`;
}

function linesUrl(eventId) {
  const mq = encodeURIComponent(
    `$filter=eventId eq '${eventId}' AND clientMetadata/subCategoryId eq '${LINES_SUBCAT}' AND tags/all(t: t ne 'SportcastBetBuilder')`
  );
  return `${DK_BASE}/controldata/event/eventSubcategory/v1/markets?isBatchable=false` +
         `&templateVars=${eventId}%2C${LINES_SUBCAT}&marketsQuery=${mq}&include=MarketSplits&entity=markets`;
}

function parseLines(data, eventId, homeTeam, awayTeam, homeShort, awayShort, timeStr, startMs) {
  const results = [];
  const allSels = data.selections || [];
  const allMkts = data.markets || [];

  // Group selections by marketId for name-based lookup via data.markets
  const selsByMarket = new Map();
  for (const s of allSels) {
    const arr = selsByMarket.get(String(s.marketId)) || [];
    arr.push(s);
    selsByMarket.set(String(s.marketId), arr);
  }

  // Primary path: iterate data.markets and match by name
  for (const mkt of allMkts) {
    const sels = selsByMarket.get(String(mkt.id)) || [];
    const name = (mkt.name || '').toLowerCase();

    if (name.includes('moneyline') || name.includes('money line') || name === 'game line') {
      const home = sels.find(s => s.outcomeType === 'Home' || (s.label || '').toLowerCase().includes(homeShort.toLowerCase()));
      const away = sels.find(s => s.outcomeType === 'Away' || (s.label || '').toLowerCase().includes(awayShort.toLowerCase()));
      if (!home || !away) continue;
      const homeOdds = parseOdds(home.displayOdds?.american);
      const awayOdds = parseOdds(away.displayOdds?.american);
      if (!homeOdds || !awayOdds) continue;
      results.push({
        eventId: String(eventId), market: 'team_ml', stat: 'Moneyline',
        homeTeam, awayTeam, homeShort, awayShort, time: timeStr, startMs,
        homeOdds, awayOdds,
        homeSelId: String(home.id), awaySelId: String(away.id), marketId: String(mkt.id),
      });

    } else if (name.includes('run line') || name.includes('runline')) {
      const homeSel = sels.find(s => s.outcomeType === 'Home' || (s.label || '').toLowerCase().includes(homeShort.toLowerCase()));
      const awaySel = sels.find(s => s.outcomeType === 'Away' || (s.label || '').toLowerCase().includes(awayShort.toLowerCase()));
      if (!homeSel || !awaySel) continue;
      const homeLine = homeSel.points ?? null;
      const awayLine = awaySel.points ?? null;
      const homeOdds = parseOdds(homeSel.displayOdds?.american);
      const awayOdds = parseOdds(awaySel.displayOdds?.american);
      if (!homeOdds || !awayOdds) continue;
      results.push({
        eventId: String(eventId), market: 'team_runline', stat: 'Run Line',
        homeTeam, awayTeam, homeShort, awayShort, time: timeStr, startMs,
        homeOdds, awayOdds, homeLine, awayLine,
        homeSelId: String(homeSel.id), awaySelId: String(awaySel.id), marketId: String(mkt.id),
      });

    } else if (name.includes('total') && !name.includes('team')) {
      const over  = sels.find(s => s.outcomeType === 'Over'  || s.label === 'Over');
      const under = sels.find(s => s.outcomeType === 'Under' || s.label === 'Under');
      if (!over || !under) continue;
      const line = over.points ?? under.points;
      if (line == null) continue;
      const overOdds  = parseOdds(over.displayOdds?.american);
      const underOdds = parseOdds(under.displayOdds?.american);
      if (!overOdds || !underOdds) continue;
      results.push({
        eventId: String(eventId), market: 'team_total', stat: 'Total Runs',
        homeTeam, awayTeam, homeShort, awayShort, time: timeStr, startMs,
        line, overOdds, underOdds,
        overSelId: String(over.id), underSelId: String(under.id), marketId: String(mkt.id),
      });
    }
  }

  // Fallback: if data.markets was empty, parse directly from selections (CWS-style)
  // Selections with outcomeType Home/Away + no points = moneyline
  if (!results.length && allSels.length) {
    // Group by marketId to reconstruct markets from selections
    const mktMap = new Map();
    for (const s of allSels) {
      const mid = String(s.marketId);
      if (!mktMap.has(mid)) mktMap.set(mid, { id: mid, label: s.marketLabel || s.subcategoryLabel || '', sels: [] });
      mktMap.get(mid).sels.push(s);
    }
    for (const [mid, g] of mktMap) {
      const sels = g.sels;
      // Moneyline: Home + Away with points == null or 0
      const homeML = sels.find(s => s.outcomeType === 'Home' && (s.points == null || s.points === 0));
      const awayML = sels.find(s => s.outcomeType === 'Away' && (s.points == null || s.points === 0));
      if (homeML && awayML) {
        const homeOdds = parseOdds(homeML.displayOdds?.american);
        const awayOdds = parseOdds(awayML.displayOdds?.american);
        if (homeOdds && awayOdds && !results.find(r => r.market === 'team_ml')) {
          results.push({
            eventId: String(eventId), market: 'team_ml', stat: 'Moneyline',
            homeTeam, awayTeam, homeShort, awayShort, time: timeStr, startMs,
            homeOdds, awayOdds,
            homeSelId: String(homeML.id), awaySelId: String(awayML.id), marketId: mid,
          });
        }
        continue;
      }
      // Run line: Home + Away with non-zero points
      const homeRL = sels.find(s => s.outcomeType === 'Home' && s.points != null && s.points !== 0);
      const awayRL = sels.find(s => s.outcomeType === 'Away' && s.points != null && s.points !== 0);
      if (homeRL && awayRL) {
        const homeOdds = parseOdds(homeRL.displayOdds?.american);
        const awayOdds = parseOdds(awayRL.displayOdds?.american);
        if (homeOdds && awayOdds && !results.find(r => r.market === 'team_runline')) {
          results.push({
            eventId: String(eventId), market: 'team_runline', stat: 'Run Line',
            homeTeam, awayTeam, homeShort, awayShort, time: timeStr, startMs,
            homeOdds, awayOdds, homeLine: homeRL.points, awayLine: awayRL.points,
            homeSelId: String(homeRL.id), awaySelId: String(awayRL.id), marketId: mid,
          });
        }
        continue;
      }
      // Total: Over + Under
      const overSel  = sels.find(s => s.outcomeType === 'Over'  || s.label === 'Over');
      const underSel = sels.find(s => s.outcomeType === 'Under' || s.label === 'Under');
      if (overSel && underSel) {
        const line = overSel.points ?? underSel.points;
        const overOdds  = parseOdds(overSel.displayOdds?.american);
        const underOdds = parseOdds(underSel.displayOdds?.american);
        if (line != null && overOdds && underOdds && !results.find(r => r.market === 'team_total')) {
          results.push({
            eventId: String(eventId), market: 'team_total', stat: 'Total Runs',
            homeTeam, awayTeam, homeShort, awayShort, time: timeStr, startMs,
            line, overOdds, underOdds,
            overSelId: String(overSel.id), underSelId: String(underSel.id), marketId: mid,
          });
        }
      }
    }
  }

  return results;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSessionOrCron(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  const url      = new URL(request.url);
  const debug    = url.searchParams.get('debug');
  const nocache  = url.searchParams.has('nocache');
  const now      = Math.floor(Date.now() / 1000);
  const today    = todayET();

  // Serve from cache
  if (!nocache && !debug) {
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(CACHE_KEY).first();
      if (cached && (now - cached.fetched_at) < CACHE_TTL) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
      }
    } catch(e) {}
  }

  // Step 1: get today's events from hits subcategory
  const hitsRes = await fetch(hitsLeagueUrl(), { headers: DK_HEADERS, signal: AbortSignal.timeout(12000) });
  if (!hitsRes.ok) return new Response(JSON.stringify({ ok: false, error: 'hits fetch failed' }), { headers: { 'Content-Type': 'application/json' } });
  const hitsData = await hitsRes.json();

  const todayEvents = (hitsData.events || []).filter(e => {
    const d = e.startEventDate
      ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(e.startEventDate))
      : '';
    return d === today;
  });

  if (!todayEvents.length) {
    return new Response(JSON.stringify({ ok: true, games: [], count: 0, ts: now }), { headers: { 'Content-Type': 'application/json' } });
  }

  // debug=1: raw DK response for first event
  if (debug === '1' && todayEvents.length) {
    const e = todayEvents[0];
    const raw = await fetch(linesUrl(String(e.id)), { headers: DK_HEADERS, signal: AbortSignal.timeout(10000) });
    const rawData = await raw.json();
    return new Response(JSON.stringify({ eventId: e.id, participants: e.participants, rawData }, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // debug=2: show how many markets parse per event + first event's raw selection summary
  if (debug === '2') {
    const debugGames = await Promise.all(todayEvents.slice(0, 5).map(async e => {
      const parts = e.participants || [];
      const homePart = parts.find(p => p.venueRole === 'Home');
      const awayPart = parts.find(p => p.venueRole === 'Away');
      const homeShort = homePart?.metadata?.shortName || homePart?.name || '';
      const awayShort = awayPart?.metadata?.shortName || awayPart?.name || '';
      try {
        const res = await fetch(linesUrl(String(e.id)), { headers: DK_HEADERS, signal: AbortSignal.timeout(8000) });
        const data = await res.json();
        const markets = parseLines(data, e.id, homePart?.name || '', awayPart?.name || '', homeShort, awayShort, '', 0);
        return {
          eventId: e.id, homeTeam: homePart?.name, awayTeam: awayPart?.name,
          homeShort, awayShort,
          marketsCount: data.markets?.length ?? 0, selectionsCount: data.selections?.length ?? 0,
          parsedMarkets: markets.map(m => m.market),
          firstMktNames: (data.markets || []).slice(0, 5).map(m => m.name),
          firstSels: (data.selections || []).slice(0, 5).map(s => ({ ot: s.outcomeType, label: s.label, pts: s.points, odds: s.displayOdds?.american })),
        };
      } catch(err) { return { eventId: e.id, error: String(err) }; }
    }));
    return new Response(JSON.stringify({ eventsFound: todayEvents.length, debugGames }, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Step 2: fetch game lines per event in parallel
  const allGames = await Promise.all(todayEvents.map(async e => {
    const startMs   = e.startEventDate ? new Date(e.startEventDate).getTime() : 0;
    const timeStr   = startMs
      ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(startMs))
      : '';
    const parts     = e.participants || [];
    const homePart  = parts.find(p => p.venueRole === 'Home');
    const awayPart  = parts.find(p => p.venueRole === 'Away');
    const homeShort = homePart?.metadata?.shortName || homePart?.name || '';
    const awayShort = awayPart?.metadata?.shortName || awayPart?.name || '';
    const homeTeam  = homePart?.name || homeShort;
    const awayTeam  = awayPart?.name || awayShort;

    try {
      const res = await fetch(linesUrl(String(e.id)), { headers: DK_HEADERS, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const data = await res.json();
      const markets = parseLines(data, e.id, homeTeam, awayTeam, homeShort, awayShort, timeStr, startMs);
      if (!markets.length) return null;
      return { eventId: String(e.id), homeTeam, awayTeam, homeShort, awayShort, time: timeStr, startMs, markets };
    } catch(e) { return null; }
  }));

  const games = allGames.filter(Boolean).sort((a, b) => a.startMs - b.startMs);
  const payload = JSON.stringify({ ok: true, games, count: games.length, ts: now });

  context.waitUntil(
    env.DB.prepare(
      'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
    ).bind(CACHE_KEY, payload, now).run().catch(() => {})
  );

  return new Response(payload, { headers: { 'Content-Type': 'application/json' } });
}
