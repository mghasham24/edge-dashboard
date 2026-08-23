// functions/api/dk/wnba-props.js
// GET /api/dk/wnba-props
// Returns WNBA player prop options for the parlays builder.
// Headshots use ESPN combiner CDN (espn_player_ids:wnba D1 cache, refreshed every 24hr).

import { getSessionOrCron } from '../../_lib/auth.js';
import { buildPlayerMap } from '../espn/player-ids.js';
import STATIC_ESPN_IDS from '../espn/wnba-ids.json' assert { type: 'json' };

const DK_BASE   = 'https://sportsbook-nash.draftkings.com/sites/US-SB/api/sportscontent';
const DK_LEAGUE = '94682'; // WNBA
const CACHE_TTL = 300;     // 5 min
const CACHE_KEY = 'dk_wnba_props_v6';

// Confirmed WNBA DK subcategory IDs (from DevTools 2026-07-28).
const SUBCAT_MAP = {
  '12488': { market: 'pts',           stat: 'Points',        type: 'ou' },
  '12492': { market: 'reb',           stat: 'Rebounds',      type: 'ou' },
  '12495': { market: 'ast',           stat: 'Assists',       type: 'ou' },
  '12497': { market: 'fg3m',          stat: 'Threes',        type: 'ou' },
  '5001':  { market: 'pra',           stat: 'PRA',           type: 'ou' },
  '9973':  { market: 'pa',            stat: 'Pts+Ast',       type: 'ou' },
  '9976':  { market: 'pr',            stat: 'Pts+Reb',       type: 'ou' },
  '9974':  { market: 'ra',            stat: 'Reb+Ast',       type: 'ou' },
};
// Yes/No subcats — fetched per-event (DK event-level endpoint only, no league-level).
// Confirmed subcat IDs from DevTools 2026-08-16.
const SUBCAT_MAP_YN = {
  '13762': { market: 'double_double', stat: 'Double-Double', type: 'yn' },
  '13759': { market: 'triple_double', stat: 'Triple-Double', type: 'yn' },
};

const DK_HEADERS = {
  'Accept':         '*/*',
  'User-Agent':     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
  'Origin':         'https://sportsbook.draftkings.com',
  'Referer':        'https://sportsbook.draftkings.com/',
  'x-client-name': 'web',
};

function subcatUrl(subcatId) {
  const eq = encodeURIComponent(`$filter=leagueId eq '${DK_LEAGUE}' AND clientMetadata/Subcategories/any(s: s/Id eq '${subcatId}')`);
  const mq = encodeURIComponent(`$filter=clientMetadata/subCategoryId eq '${subcatId}' AND tags/all(t: t ne 'SportcastBetBuilder')`);
  return `${DK_BASE}/controldata/league/leagueSubcategory/v1/markets?isBatchable=false&templateVars=${DK_LEAGUE}%2C${subcatId}&eventsQuery=${eq}&marketsQuery=${mq}&include=Events&entity=events`;
}

function eventSubcatUrl(eventId, subcatId) {
  const mq = encodeURIComponent(`$filter=eventId eq '${eventId}' AND clientMetadata/subCategoryId eq '${subcatId}' AND tags/all(t: t ne 'SportcastBetBuilder')`);
  return `${DK_BASE}/controldata/event/eventSubcategory/v1/markets?isBatchable=false&templateVars=${eventId}%2C${subcatId}&marketsQuery=${mq}&entity=markets`;
}

function todayET() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

function parseOdds(american) {
  if (!american) return null;
  const s = String(american).replace(/−/g, '-').replace(/[^0-9+\-]/g, '');
  const n = parseInt(s, 10);
  return isFinite(n) ? n : null;
}

function parseSubcat(data, subcatId, info) {
  const today = todayET();
  const players = [];

  const eventsById  = new Map((data.events    || []).map(e => [String(e.id), e]));
  const marketsById = new Map((data.markets   || []).map(m => [String(m.id), m]));

  const selsByMarket = new Map();
  for (const s of (data.selections || [])) {
    const arr = selsByMarket.get(String(s.marketId)) || [];
    arr.push(s);
    selsByMarket.set(String(s.marketId), arr);
  }

  for (const [mktId, sels] of selsByMarket) {
    const mkt = marketsById.get(mktId);
    if (!mkt) continue;
    const event = eventsById.get(String(mkt.eventId));
    if (!event) continue;

    const startMs = event.startEventDate ? new Date(event.startEventDate).getTime() : 0;
    const evDate  = startMs ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(startMs)) : '';
    if (evDate && evDate < today) continue;

    const timeStr = startMs
      ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(startMs))
      : '';

    const evParts   = event.participants || [];
    const homePart  = evParts.find(p => p.venueRole === 'Home');
    const awayPart  = evParts.find(p => p.venueRole === 'Away');
    const homeShort = homePart?.metadata?.shortName || homePart?.name || '';
    const awayShort = awayPart?.metadata?.shortName || awayPart?.name || '';

    const over  = sels.find(s => s.outcomeType === 'Over'  || s.label === 'Over');
    const under = sels.find(s => s.outcomeType === 'Under' || s.label === 'Under');
    if (!over || !under) continue;

    const player = (over.participants || [])[0];
    if (!player) continue;
    const line = over.points ?? under.points;
    if (line == null) continue;
    const oddsOver  = parseOdds(over.displayOdds?.american);
    const oddsUnder = parseOdds(under.displayOdds?.american);
    if (!oddsOver || !oddsUnder) continue;

    const dkPlayerId = player.id || player.metadata?.playerId || null;
    const headshot   = dkPlayerId ? `/api/dk/player-image?id=${dkPlayerId}&size=lg` : null;

    const isHome = player.venueRole === 'HomePlayer';
    const team   = isHome ? homeShort : awayShort;
    const opp    = isHome ? awayShort : homeShort;
    const mainLine = (over.tags || []).includes('MainPointLine');

    players.push({
      name: player.name, team, opp, time: timeStr, startMs,
      market: info.market, stat: info.stat,
      threshold: line, label: `Over ${line}`, direction: 'more',
      americanOdds: oddsOver,
      marketId: mktId, selectionId: String(over.id), eventId: String(mkt.eventId),
      subcatId, mainLine, headshot, dkPlayerId,
    }, {
      name: player.name, team, opp, time: timeStr, startMs,
      market: info.market, stat: info.stat,
      threshold: line, label: `Under ${line}`, direction: 'less',
      americanOdds: oddsUnder,
      marketId: mktId, selectionId: String(under.id), eventId: String(mkt.eventId),
      subcatId, mainLine, headshot, dkPlayerId,
    });
  }
  return players;
}

async function fetchSubcat(subcatId, info) {
  const res = await fetch(subcatUrl(subcatId), {
    headers: DK_HEADERS,
    signal:  AbortSignal.timeout(12000),
  });
  if (!res.ok) return { players: [], events: [] };
  const data = await res.json();
  return { players: parseSubcat(data, subcatId, info), events: data.events || [] };
}

// Parses a DK event-level YN (Yes/No) subcat response into player pick entries.
// game = { eventId, home, away, homeShort, awayShort, startMs, time }
function parseSubcatYN(data, game, subcatId, info) {
  const players = [];
  const marketsById = new Map((data.markets || []).map(m => [String(m.id), m]));
  for (const sel of (data.selections || [])) {
    if (sel.outcomeType !== 'Yes') continue;
    marketsById.get(String(sel.marketId)); // just confirming market exists
    const player = (sel.participants || [])[0];
    if (!player) continue;
    const american = sel.displayOdds?.american;
    const odds = parseOdds(american) ?? (sel.trueOdds >= 2
      ? Math.round((sel.trueOdds - 1) * 100)
      : Math.round(-100 / (sel.trueOdds - 1)));
    if (!odds || !isFinite(odds)) continue;
    const isHome = player.venueRole === 'HomePlayer';
    const team   = isHome ? (game.homeShort || game.home) : (game.awayShort || game.away);
    const opp    = isHome ? (game.awayShort || game.away) : (game.homeShort || game.home);
    players.push({
      name: player.name, team, opp, time: game.time || '', startMs: game.startMs || 0,
      market: info.market, stat: info.stat,
      threshold: null, label: 'Yes', direction: 'more',
      americanOdds: odds, type: 'yn',
      marketId: String(sel.marketId), selectionId: String(sel.id),
      eventId: game.eventId, subcatId: String(subcatId),
      mainLine: true,
      headshot: player.id ? `/api/dk/player-image?id=${player.id}&size=lg` : null,
      dkPlayerId: player.id || null,
    });
  }
  return players;
}

async function fetchSubcatYN(game, subcatId, info) {
  try {
    const res = await fetch(eventSubcatUrl(game.eventId, subcatId), {
      headers: DK_HEADERS,
      signal:  AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return parseSubcatYN(data, game, subcatId, info);
  } catch(_) { return []; }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSessionOrCron(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);

  // Discover mode: try candidate subcat IDs and return which have WNBA player prop data.
  // Hit ?discover=1 to find correct subcategory IDs if the defaults return no players.
  if (url.searchParams.has('discover')) {
    const candidates = ['13002','13003','13004','13005','13006','13007','13008',
                        '13119','13120','13121','13122','13123','13124','13125',
                        '13189','13190','13191','13192','13193','13194'];
    const results = await Promise.allSettled(
      candidates.map(async sid => {
        const res = await fetchSubcat(sid, { market: 'test', stat: 'Test', type: 'ou' });
        return { subcatId: sid, playerCount: res.players.length, sample: res.players.slice(0, 2).map(p => `${p.name} ${p.stat} ${p.threshold}`) };
      })
    );
    const found = results
      .filter(r => r.status === 'fulfilled' && r.value.playerCount > 0)
      .map(r => r.value);
    return new Response(JSON.stringify({ found, total: found.length }, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Debug: dump raw structure for a specific subcategory
  if (url.searchParams.get('debug') === '1') {
    const subcatId = url.searchParams.get('subcat') || '12488';
    const res  = await fetch(subcatUrl(subcatId), { headers: DK_HEADERS, signal: AbortSignal.timeout(12000) });
    const data = await res.json();
    const sels = data.selections || [];
    const mkts = data.markets || [];
    // Full raw selection (first 4) so we can see every field DK returns
    const sample = sels.slice(0, 4);
    const mktSample = mkts.slice(0, 2);
    const evts = data.events || [];
    const evtSample = evts.slice(0, 2);
    const evtKeys = evts[0] ? Object.keys(evts[0]) : [];
    return new Response(JSON.stringify({ responseKeys: Object.keys(data), selectionCount: sels.length, marketCount: mkts.length, eventCount: evts.length, topKeys: sels[0] ? Object.keys(sels[0]) : [], mktKeys: mkts[0] ? Object.keys(mkts[0]) : [], evtKeys, evtSample, sample, mktSample }, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const now     = Math.floor(Date.now() / 1000);
  const nocache = url.searchParams.has('nocache');

  let stalePayload = null;
  try {
    const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(CACHE_KEY).first();
    if (!nocache && cached && (now - cached.fetched_at) < CACHE_TTL) {
      return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
    }
    if (cached) stalePayload = cached.data;
  } catch(e) {}

  // Load ESPN player ID map — D1 cache (24hr TTL) with static JSON fallback
  const ESPN_ID_TTL = 86400;
  let espnPlayers = STATIC_ESPN_IDS;
  let espnStale   = true;
  try {
    const ec = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?')
      .bind('espn_player_ids:wnba').first();
    if (ec) {
      espnPlayers = { ...STATIC_ESPN_IDS, ...JSON.parse(ec.data).players };
      espnStale   = (now - ec.fetched_at) >= ESPN_ID_TTL;
    }
  } catch(e) {}

  const entries = Object.entries(SUBCAT_MAP);
  const results = await Promise.allSettled(entries.map(([subcatId, info]) => fetchSubcat(subcatId, info)));

  const allPlayers = [];
  const wnbaGames  = [];
  const seenEventIds = new Set();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    allPlayers.push(...r.value.players);
    for (const e of (r.value.events || [])) {
      const eid = String(e.id);
      if (seenEventIds.has(eid)) continue;
      seenEventIds.add(eid);
      const parts    = e.participants || [];
      const homePart = parts.find(p => p.venueRole === 'Home');
      const awayPart = parts.find(p => p.venueRole === 'Away');
      if (!homePart?.name || !awayPart?.name) continue;
      const startMs = e.startEventDate ? new Date(e.startEventDate).getTime() : 0;
      const timeStr = startMs
        ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(startMs))
        : '';
      wnbaGames.push({
        eventId:   eid,
        home:      homePart.name, away:      awayPart.name,
        homeShort: homePart.metadata?.shortName || homePart.name,
        awayShort: awayPart.metadata?.shortName || awayPart.name,
        startMs,   time: timeStr,
      });
    }
  }

  // Second pass: fetch Yes/No subcats (DD, TD) per event in parallel
  if (wnbaGames.length) {
    const ynEntries = Object.entries(SUBCAT_MAP_YN);
    const ynResults = await Promise.allSettled(
      wnbaGames.flatMap(game => ynEntries.map(([subcatId, info]) => fetchSubcatYN(game, subcatId, info)))
    );
    for (const r of ynResults) {
      if (r.status === 'fulfilled') allPlayers.push(...r.value);
    }
  }

  // Apply ESPN headshots; background-refresh ID map if stale
  for (const p of allPlayers) {
    const espnId = espnPlayers[p.name?.toLowerCase()];
    p.headshot = espnId
      ? `https://a.espncdn.com/combiner/i?img=/i/headshots/wnba/players/full/${espnId}.png&w=350&h=254`
      : null;
  }
  if (espnStale) {
    context.waitUntil(
      buildPlayerMap('basketball', 'wnba').then(players => {
        if (!players) return;
        return env.DB.prepare(
          'INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at'
        ).bind('espn_player_ids:wnba', JSON.stringify({ players }), now).run();
      }).catch(() => {})
    );
  }

  const payload = JSON.stringify({ ok: true, players: allPlayers, count: allPlayers.length, games: wnbaGames, ts: now });

  if (allPlayers.length > 0) {
    context.waitUntil(
      env.DB.prepare(
        'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
      ).bind(CACHE_KEY, payload, now).run().catch(() => {})
    );
    return new Response(payload, { headers: { 'Content-Type': 'application/json' } });
  }

  // DK returned empty — serve stale cache rather than caching the empty response
  if (stalePayload) {
    try {
      const parsed = JSON.parse(stalePayload);
      if (parsed.players && parsed.players.length > 0) {
        return new Response(stalePayload, { headers: { 'Content-Type': 'application/json' } });
      }
    } catch(e) {}
  }

  return new Response(payload, { headers: { 'Content-Type': 'application/json' } });
}
