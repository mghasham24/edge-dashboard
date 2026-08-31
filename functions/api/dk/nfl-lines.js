// functions/api/dk/nfl-lines.js
// GET /api/dk/nfl-lines
// Returns today's NFL preseason game lines (ML, Spread, Total) from DK for the parlay builder.
// No player props — team lines only. League ID 24685, subcat 4518.

import { getSessionOrCron } from '../../_lib/auth.js';

const DK_BASE      = 'https://sportsbook-nash.draftkings.com/sites/US-SB/api/sportscontent';
const DK_LEAGUE    = '24685'; // NFL Preseason
const LINES_SUBCAT = '4518';  // ML / Spread / Total
const CACHE_TTL    = 900; // 15 minutes
const CACHE_KEY    = 'dk_nfl_lines_v1';

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
  const s = String(american)
    .replace(/−/g, '-')
    .replace(/[^\d+\-]/g, '');
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

function parseLines(data, eventId, homeTeam, awayTeam, homeShort, awayShort, timeStr, startMs) {
  const results = [];
  const selsByMarket = new Map();
  for (const s of (data.selections || [])) {
    const arr = selsByMarket.get(String(s.marketId)) || [];
    arr.push(s);
    selsByMarket.set(String(s.marketId), arr);
  }

  for (const mkt of (data.markets || [])) {
    const sels = selsByMarket.get(String(mkt.id)) || [];
    const name = (mkt.name || '').toLowerCase();

    if (name === 'moneyline') {
      const home = sels.find(s => s.outcomeType === 'Home');
      const away = sels.find(s => s.outcomeType === 'Away');
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

    } else if (name === 'spread') {
      const homeSel = sels.find(s => s.outcomeType === 'Home');
      const awaySel = sels.find(s => s.outcomeType === 'Away');
      if (!homeSel || !awaySel) continue;
      const homeLine = homeSel.points ?? null;
      const awayLine = awaySel.points ?? null;
      const homeOdds = parseOdds(homeSel.displayOdds?.american);
      const awayOdds = parseOdds(awaySel.displayOdds?.american);
      if (!homeOdds || !awayOdds) continue;
      results.push({
        eventId: String(eventId), market: 'team_runline', stat: 'Spread',
        homeTeam, awayTeam, homeShort, awayShort, time: timeStr, startMs,
        homeOdds, awayOdds, homeLine, awayLine,
        homeSelId: String(homeSel.id), awaySelId: String(awaySel.id), marketId: String(mkt.id),
      });

    } else if (name === 'total') {
      const over  = sels.find(s => s.outcomeType === 'Over'  || s.label === 'Over');
      const under = sels.find(s => s.outcomeType === 'Under' || s.label === 'Under');
      if (!over || !under) continue;
      const line = over.points ?? under.points;
      if (line == null) continue;
      const overOdds  = parseOdds(over.displayOdds?.american);
      const underOdds = parseOdds(under.displayOdds?.american);
      if (!overOdds || !underOdds) continue;
      results.push({
        eventId: String(eventId), market: 'team_total', stat: 'Total Points',
        homeTeam, awayTeam, homeShort, awayShort, time: timeStr, startMs,
        line, overOdds, underOdds,
        overSelId: String(over.id), underSelId: String(under.id), marketId: String(mkt.id),
      });
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

  const url     = new URL(request.url);
  const debug   = url.searchParams.get('debug');
  const nocache = url.searchParams.has('nocache');
  const now     = Math.floor(Date.now() / 1000);
  const today   = todayET();

  const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=600' };

  let stalePayload = null;
  if (!nocache && !debug) {
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(CACHE_KEY).first();
      if (cached) {
        if ((now - cached.fetched_at) < CACHE_TTL) {
          return new Response(cached.data, { headers: JSON_HEADERS });
        }
        stalePayload = cached.data; // stale — serve immediately, refresh in background
      }
    } catch(e) {}
  }

  // Serve stale immediately, refresh in background
  if (stalePayload) {
    context.waitUntil(refreshNflCache(env, now, today));
    return new Response(stalePayload, { headers: JSON_HEADERS });
  }

  const evRes = await fetch(eventsUrl(), { headers: DK_HEADERS, signal: AbortSignal.timeout(12000) });
  if (!evRes.ok) {
    const fallback = stalePayload || JSON.stringify({ ok: false, error: 'events fetch failed' });
    return new Response(fallback, { headers: JSON_HEADERS });
  }
  const evData = await evRes.json();

  const todayEvents = (evData.events || []).filter(e => {
    const d = e.startEventDate
      ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(e.startEventDate))
      : '';
    return d === today;
  });

  if (!todayEvents.length) {
    return new Response(JSON.stringify({ ok: true, games: [], count: 0, ts: now }), { headers: JSON_HEADERS });
  }

  if (debug === '1') {
    const e = todayEvents[0];
    const raw = await fetch(linesUrl(String(e.id)), { headers: DK_HEADERS, signal: AbortSignal.timeout(10000) });
    const rawData = await raw.json();
    return new Response(JSON.stringify({ eventId: e.id, participants: e.participants, rawData }, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const allGames = await Promise.all(todayEvents.map(async e => {
    const startMs  = e.startEventDate ? new Date(e.startEventDate).getTime() : 0;
    const timeStr  = startMs
      ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(startMs))
      : '';
    const parts    = e.participants || [];
    const homePart = parts.find(p => p.venueRole === 'Home');
    const awayPart = parts.find(p => p.venueRole === 'Away');
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
    } catch(err) { return null; }
  }));

  const games = allGames.filter(Boolean).sort((a, b) => a.startMs - b.startMs);
  const payload = JSON.stringify({ ok: true, games, count: games.length, ts: now });

  // Only cache when we actually got games — don't overwrite good cache with empty
  if (games.length > 0) {
    context.waitUntil(
      env.DB.prepare(
        'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
      ).bind(CACHE_KEY, payload, now).run().catch(() => {})
    );
  }

  return new Response(payload, { headers: JSON_HEADERS });
}

async function refreshNflCache(env, now, today) {
  try {
    const evRes = await fetch(eventsUrl(), { headers: DK_HEADERS, signal: AbortSignal.timeout(12000) });
    if (!evRes.ok) return;
    const evData = await evRes.json();
    const todayEvents = (evData.events || []).filter(e => {
      const d = e.startEventDate
        ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(e.startEventDate))
        : '';
      return d === today;
    });
    if (!todayEvents.length) return;
    const allGames = await Promise.all(todayEvents.map(async e => {
      const startMs   = e.startEventDate ? new Date(e.startEventDate).getTime() : 0;
      const timeStr   = startMs ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(startMs)) : '';
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
      } catch { return null; }
    }));
    const games = allGames.filter(Boolean).sort((a, b) => a.startMs - b.startMs);
    if (!games.length) return;
    const payload = JSON.stringify({ ok: true, games, count: games.length, ts: now });
    await env.DB.prepare(
      'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
    ).bind(CACHE_KEY, payload, now).run();
  } catch(e) {}
}
