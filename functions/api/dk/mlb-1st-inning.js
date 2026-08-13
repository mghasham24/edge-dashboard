// functions/api/dk/mlb-1st-inning.js
// GET /api/dk/mlb-1st-inning
// Returns 1st-inning markets for today's MLB games — used by the parlay builder.

import { getSessionOrCron } from '../../_lib/auth.js';

const DK_BASE     = 'https://sportsbook-nash.draftkings.com/sites/US-SB/api/sportscontent';
const DK_LEAGUE   = '84240';
const HITS_SUBCAT = '6719';
const CACHE_TTL   = 300; // 5 min
const CACHE_KEY   = 'dk_mlb_1inn_v1';

// 1st-inning subcategory IDs fetched per event
const SUBCATS_1INN = ['13740', '20150', '15418', '11214', '12856', '12857', '12858', '12855'];

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

function eventSubcatUrl(eventId, subcatId) {
  const mq = encodeURIComponent(
    `$filter=eventId eq '${eventId}' AND clientMetadata/subCategoryId eq '${subcatId}' AND tags/all(t: t ne 'SportcastBetBuilder')`
  );
  return `${DK_BASE}/controldata/event/eventSubcategory/v1/markets?isBatchable=false` +
         `&templateVars=${eventId}%2C${subcatId}&marketsQuery=${mq}&entity=markets`;
}

// Parse all subcategory responses for one event into a structured game object.
function parseFirstInn(responses, eventId, homeTeam, awayTeam, homeShort, awayShort, timeStr, startMs) {
  const game = { eventId, homeTeam, awayTeam, homeShort, awayShort, time: timeStr, startMs, away: {}, home: {} };

  const bySubcat = new Map(responses.map(r => [r.subcatId, r.data]));

  function groupSelsByMkt(data) {
    const map = new Map();
    for (const s of (data.selections || [])) {
      const arr = map.get(String(s.marketId)) || [];
      arr.push(s);
      map.set(String(s.marketId), arr);
    }
    return map;
  }

  function parseOU(sels, mktId) {
    const over  = sels.find(s => s.outcomeType === 'Over'  || s.label === 'Over');
    const under = sels.find(s => s.outcomeType === 'Under' || s.label === 'Under');
    if (!over || !under) return null;
    const line = over.points ?? under.points;
    if (line == null) return null;
    const overOdds  = parseOdds(over.displayOdds?.american);
    const underOdds = parseOdds(under.displayOdds?.american);
    if (!overOdds || !underOdds) return null;
    return { line, overOdds, underOdds, overSelId: String(over.id), underSelId: String(under.id), marketId: mktId };
  }

  // Determine team side (away/home) from market's correlatedId or first selection participant
  function teamSide(mkt, sels) {
    const corr = mkt.correlatedId || '';
    if (corr.includes(':Home')) return 'home';
    if (corr.includes(':Away')) return 'away';
    const role = (sels[0]?.participants || [])[0]?.venueRole;
    if (role === 'Home') return 'home';
    if (role === 'Away') return 'away';
    return null;
  }

  // --- 13740: 1st Inning 3-Way ML ---
  const mlData = bySubcat.get('13740');
  if (mlData) {
    const smap = groupSelsByMkt(mlData);
    for (const [mktId, sels] of smap) {
      const away = sels.find(s => s.outcomeType === 'Away');
      const tie  = sels.find(s => s.outcomeType === 'Tie');
      const home = sels.find(s => s.outcomeType === 'Home');
      if (!away || !tie || !home) continue;
      const awayOdds = parseOdds(away.displayOdds?.american);
      const tieOdds  = parseOdds(tie.displayOdds?.american);
      const homeOdds = parseOdds(home.displayOdds?.american);
      if (!awayOdds || !tieOdds || !homeOdds) continue;
      game.ml = { awayOdds, tieOdds, homeOdds, awaySelId: String(away.id), tieSelId: String(tie.id), homeSelId: String(home.id), marketId: mktId };
      break;
    }
  }

  // --- 20150: 1st Inning Runs O/U (game-level) ---
  const runsData = bySubcat.get('20150');
  if (runsData) {
    const smap = groupSelsByMkt(runsData);
    for (const [mktId, sels] of smap) {
      const isMain = sels.some(s => (s.tags || []).includes('MainPointLine'));
      const ou = parseOU(sels, mktId);
      if (ou && (isMain || !game.runsOU)) { game.runsOU = ou; if (isMain) break; }
    }
  }

  // --- 15418: 1st Inning Walks O/U (game-level) ---
  const walksData = bySubcat.get('15418');
  if (walksData) {
    const smap = groupSelsByMkt(walksData);
    for (const [mktId, sels] of smap) {
      const ou = parseOU(sels, mktId);
      if (ou && !game.walksOU) { game.walksOU = ou; }
    }
  }

  // --- 11214: Team Hits (O/U + Exact per team) ---
  const hitsData = bySubcat.get('11214');
  if (hitsData) {
    const smap = groupSelsByMkt(hitsData);
    for (const [mktId, sels] of smap) {
      const mkt  = (hitsData.markets || []).find(m => String(m.id) === mktId);
      const side = mkt ? teamSide(mkt, sels) : null;
      if (!side) continue;
      const mktName = (mkt?.marketType?.name || mkt?.name || '').toLowerCase();
      if (mktName.includes('exact')) {
        if (!game[side].hitsExact) {
          const exact = sels.map(s => ({ label: s.label, odds: parseOdds(s.displayOdds?.american), selId: String(s.id), marketId: mktId })).filter(s => s.odds);
          if (exact.length) game[side].hitsExact = exact;
        }
      } else {
        const ou = parseOU(sels, mktId);
        if (ou && !game[side].hitsOU) game[side].hitsOU = ou;
      }
    }
  }

  // --- 12856: Batters to Plate (O/U + Exact per team) ---
  const battersData = bySubcat.get('12856');
  if (battersData) {
    const smap = groupSelsByMkt(battersData);
    for (const [mktId, sels] of smap) {
      const mkt  = (battersData.markets || []).find(m => String(m.id) === mktId);
      const side = mkt ? teamSide(mkt, sels) : null;
      if (!side) continue;
      const mktName = (mkt?.marketType?.name || mkt?.name || '').toLowerCase();
      if (mktName.includes('exact')) {
        if (!game[side].battersExact) {
          const exact = sels.map(s => ({ label: s.label, odds: parseOdds(s.displayOdds?.american), selId: String(s.id), marketId: mktId })).filter(s => s.odds);
          if (exact.length) game[side].battersExact = exact;
        }
      } else {
        const ou = parseOU(sels, mktId);
        if (ou && !game[side].battersOU) game[side].battersOU = ou;
      }
    }
  }

  // --- 12857: Pitches Thrown (O/U + Ranges per team) ---
  const pitchesData = bySubcat.get('12857');
  if (pitchesData) {
    const smap = groupSelsByMkt(pitchesData);
    for (const [mktId, sels] of smap) {
      const mkt  = (pitchesData.markets || []).find(m => String(m.id) === mktId);
      const side = mkt ? teamSide(mkt, sels) : null;
      if (!side) continue;
      const mktName = (mkt?.marketType?.name || mkt?.name || '').toLowerCase();
      const isRange = mktName.includes('range') || sels.some(s => /\d+[-–]\d+/.test(s.label || ''));
      if (isRange) {
        if (!game[side].pitchesRanges) {
          const ranges = sels.map(s => ({ label: s.label, odds: parseOdds(s.displayOdds?.american), selId: String(s.id), marketId: mktId })).filter(s => s.odds);
          if (ranges.length) game[side].pitchesRanges = ranges;
        }
      } else {
        const ou = parseOU(sels, mktId);
        if (ou && !game[side].pitchesOU) game[side].pitchesOU = ou;
      }
    }
  }

  // --- 12858: Team Runs — HR Yes/No, Runs Scored Exact, Run Scored Yes/No ---
  const teamRunsData = bySubcat.get('12858');
  if (teamRunsData) {
    const smap = groupSelsByMkt(teamRunsData);
    for (const [mktId, sels] of smap) {
      const mkt      = (teamRunsData.markets || []).find(m => String(m.id) === mktId);
      const side     = mkt ? teamSide(mkt, sels) : null;
      if (!side) continue;
      const mktTypeId = String(mkt?.marketType?.id || '');
      const mktName   = (mkt?.marketType?.name || mkt?.name || '').toLowerCase();

      if (mktTypeId === '11516' || mktName.includes('home run')) {
        if (!game[side].hrYN) {
          const yes = sels.find(s => s.outcomeType === 'Yes' || s.label === 'Yes');
          const no  = sels.find(s => s.outcomeType === 'No'  || s.label === 'No');
          if (yes && no) game[side].hrYN = { yesOdds: parseOdds(yes.displayOdds?.american), noOdds: parseOdds(no.displayOdds?.american), yesSelId: String(yes.id), noSelId: String(no.id), marketId: mktId };
        }
      } else if (mktTypeId === '11919' || mktName.includes('runs scored exact')) {
        if (!game[side].runsExact) {
          const exact = sels.map(s => ({ label: s.label, odds: parseOdds(s.displayOdds?.american), selId: String(s.id), marketId: mktId })).filter(s => s.odds);
          if (exact.length) game[side].runsExact = exact;
        }
      } else if (mktTypeId === '11511' || (mktName.includes('run scored') && !mktName.includes('exact'))) {
        if (!game[side].runScoredYN) {
          const yes = sels.find(s => s.outcomeType === 'Yes' || s.label === 'Yes');
          const no  = sels.find(s => s.outcomeType === 'No'  || s.label === 'No');
          if (yes && no) game[side].runScoredYN = { yesOdds: parseOdds(yes.displayOdds?.american), noOdds: parseOdds(no.displayOdds?.american), yesSelId: String(yes.id), noSelId: String(no.id), marketId: mktId };
        }
      }
    }
  }

  // --- 12855: Strikeouts Exact per team ---
  const ksData = bySubcat.get('12855');
  if (ksData) {
    const smap = groupSelsByMkt(ksData);
    for (const [mktId, sels] of smap) {
      const mkt  = (ksData.markets || []).find(m => String(m.id) === mktId);
      const side = mkt ? teamSide(mkt, sels) : null;
      if (!side || game[side].strikeoutsExact) continue;
      const exact = sels.map(s => ({ label: s.label, odds: parseOdds(s.displayOdds?.american), selId: String(s.id), marketId: mktId })).filter(s => s.odds);
      if (exact.length) game[side].strikeoutsExact = exact;
    }
  }

  const hasData = game.ml || game.runsOU || game.walksOU ||
    Object.keys(game.away).length > 0 || Object.keys(game.home).length > 0;
  return hasData ? game : null;
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
  const nocache = url.searchParams.has('nocache');
  const debug   = url.searchParams.get('debug');
  const now     = Math.floor(Date.now() / 1000);
  const today   = todayET();

  // Always read cache — fresh copy serves immediately, stale copy used as fallback if DK rate-limits
  let staleCache = null;
  if (!nocache && !debug) {
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(CACHE_KEY).first();
      if (cached) {
        if ((now - cached.fetched_at) < CACHE_TTL) {
          return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
        }
        staleCache = cached.data; // keep for fallback
      }
    } catch(e) {}
  }

  // Step 1: discover today's events via hits subcategory
  const hitsRes = await fetch(hitsLeagueUrl(), { headers: DK_HEADERS, signal: AbortSignal.timeout(12000) });
  if (!hitsRes.ok) {
    return new Response(JSON.stringify({ ok: false, error: 'event discovery failed' }), { headers: { 'Content-Type': 'application/json' } });
  }
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

  // debug: dump raw event-level response for a given subcategory
  if (debug) {
    const e = todayEvents[0];
    const subcatId = debug === '1' ? '13740' : debug;
    const raw = await fetch(eventSubcatUrl(String(e.id), subcatId), { headers: DK_HEADERS, signal: AbortSignal.timeout(10000) });
    const rawData = await raw.json();
    return new Response(JSON.stringify({ eventId: e.id, participants: e.participants, subcatId, markets: rawData.markets?.slice(0,5), selCount: rawData.selections?.length, sels: rawData.selections?.slice(0,8) }, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Step 2: for each event, fetch all 1st inning subcategories in parallel
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
    const evId      = String(e.id);

    const subcatResults = await Promise.allSettled(
      SUBCATS_1INN.map(async subcatId => {
        const res = await fetch(eventSubcatUrl(evId, subcatId), { headers: DK_HEADERS, signal: AbortSignal.timeout(8000) });
        if (!res.ok) return { subcatId, data: {}, rateLimited: res.status === 429 };
        const data = await res.json();
        return { subcatId, data };
      })
    );

    // If DK rate-limited any subcat, data is incomplete — serve stale rather than partial
    const anyRateLimited = subcatResults.some(r => r.status === 'fulfilled' && r.value?.rateLimited);
    if (anyRateLimited && staleCache) {
      return new Response(staleCache, { headers: { 'Content-Type': 'application/json' } });
    }

    const responses = subcatResults
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    return parseFirstInn(responses, evId, homeTeam, awayTeam, homeShort, awayShort, timeStr, startMs);
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
