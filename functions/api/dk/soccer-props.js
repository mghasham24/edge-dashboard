// functions/api/dk/soccer-props.js
// GET /api/dk/soccer-props
// Returns soccer player props from DraftKings for the parlay builder.
// Markets: Anytime Goalscorer, Shots on Target, Assists, GK Saves, Offsides, Fouls Won

import { getSessionOrCron } from '../../_lib/auth.js';

const DK_BASE   = 'https://sportsbook-nash.draftkings.com/sites/US-SB/api/sportscontent';
const CACHE_TTL = 300;
const CACHE_KEY = 'dk_soccer_props_v5';

// Confirmed subcat IDs from DevTools 2026-08-16 (MLS, confirmed same across EU leagues).
const SUBCAT_MAP_OU = {
  '16861': { market: 'sot',       stat: 'Shots on Target', espnField: 'shotsOnTarget' },
  '16863': { market: 'assists',   stat: 'Assists',         espnField: 'goalAssists'   },
  '18346': { market: 'saves',     stat: 'GK Saves',        espnField: 'saves'         },
  '18351': { market: 'offsides',  stat: 'Offsides',        espnField: 'offsides'      },
  '19540': { market: 'fouls_won', stat: 'Fouls Won',       espnField: 'foulsSuffered' },
};
// Goalscorer: outcomeType='ToScoreAnyTime', one selection per player, no threshold.
const SUBCAT_GOALSCORER = '16604';

const DK_SOCCER_LEAGUES = {
  '40253': { name: 'EPL',        espnSlug: 'eng.1'          },
  '40031': { name: 'La Liga',    espnSlug: 'esp.1'          },
  '40030': { name: 'Serie A',    espnSlug: 'ita.1'          },
  '40032': { name: 'Ligue 1',    espnSlug: 'fra.1'          },
  '40481': { name: 'Bundesliga', espnSlug: 'ger.1'          },
  '89345': { name: 'MLS',        espnSlug: 'usa.1'          },
  '40685': { name: 'UCL',        espnSlug: 'UEFA.CHAMPIONS' },
};

const DK_HEADERS = {
  'Accept':         '*/*',
  'User-Agent':     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
  'Origin':         'https://sportsbook.draftkings.com',
  'Referer':        'https://sportsbook.draftkings.com/',
  'x-client-name': 'web',
};

function leagueSubcatUrl(leagueId, subcatId) {
  const eq = encodeURIComponent(`$filter=leagueId eq '${leagueId}' AND clientMetadata/Subcategories/any(s: s/Id eq '${subcatId}')`);
  const mq = encodeURIComponent(`$filter=clientMetadata/subCategoryId eq '${subcatId}' AND tags/all(t: t ne 'SportcastBetBuilder')`);
  return `${DK_BASE}/controldata/league/leagueSubcategory/v1/markets?isBatchable=false&templateVars=${leagueId}%2C${subcatId}&eventsQuery=${eq}&marketsQuery=${mq}&include=Events&entity=events`;
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

// Build a lookup map: eventId → { home, away, homeShort, awayShort, startMs, time, league, leagueId, espnSlug }
function buildEventMap(eventsArr, leagueId, leagueInfo) {
  const today = todayET();
  const map = {};
  const nowMs = Date.now();
  for (const ev of (eventsArr || [])) {
    if (!ev.startEventDate) continue;
    const startMs = new Date(ev.startEventDate).getTime();
    if (startMs <= nowMs) continue;
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(startMs));
    const timeStr = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(startMs));
    const parts = ev.participants || [];
    const home  = parts.find(p => p.venueRole === 'Home');
    const away  = parts.find(p => p.venueRole === 'Away');
    map[String(ev.id)] = {
      eventId:   String(ev.id),
      home:      home?.metadata?.rosettaTeamName || home?.name || '',
      away:      away?.metadata?.rosettaTeamName || away?.name || '',
      homeShort: home?.name || '',
      awayShort: away?.name || '',
      startMs,
      time: timeStr,
      league:   leagueInfo.name,
      leagueId,
      espnSlug: leagueInfo.espnSlug,
      gameDate: d,
    };
  }
  return map;
}

// Parse soccer milestone prop subcategory (shots, assists, saves, offsides, fouls).
// DK format: one market per player, selections are "1+", "2+", "3+" (milestoneValue field).
// Shows the MostBalancedOdds selection (or lowest threshold) as the main card.
function parseMilestone(data, eventMap, subcatId, info) {
  const players = [];
  const marketsById = new Map((data.markets || []).map(m => [String(m.id), m]));
  const selsByMarket = new Map();
  for (const s of (data.selections || [])) {
    const arr = selsByMarket.get(String(s.marketId)) || [];
    arr.push(s);
    selsByMarket.set(String(s.marketId), arr);
  }

  for (const [mktId, sels] of selsByMarket) {
    const mkt = marketsById.get(mktId);
    if (!mkt) continue;
    const ev = eventMap[String(mkt.eventId)];
    if (!ev) continue;

    // Pick the main selection: prefer MostBalancedOdds tag, else lowest milestoneValue
    const main = sels.find(s => (s.tags || []).includes('MostBalancedOdds'))
              || sels.slice().sort((a, b) => (a.milestoneValue ?? 999) - (b.milestoneValue ?? 999))[0];
    if (!main) continue;

    const player = (main.participants || [])[0] || (mkt.participants || [])[0];
    if (!player) continue;
    const odds = parseOdds(main.displayOdds?.american);
    if (!odds) continue;

    const threshold      = main.milestoneValue ?? 1;
    const milestoneLabel = main.label || (threshold + '+');
    const isHome   = player.venueRole === 'HomePlayer';
    const team     = isHome ? ev.homeShort : ev.awayShort;
    const opp      = isHome ? ev.awayShort : ev.homeShort;
    const dkId     = player.id || null;
    const headshot = dkId ? `/api/dk/player-image?id=${dkId}&size=lg` : null;

    players.push({
      name: player.name, team, opp, awayShort: ev.awayShort, homeShort: ev.homeShort,
      time: ev.time, startMs: ev.startMs,
      market: info.market, stat: info.stat, espnField: info.espnField,
      league: ev.league, leagueId: ev.leagueId, espnSlug: ev.espnSlug,
      gameDate: ev.gameDate,
      threshold, milestoneLabel, direction: 'more',
      type: 'milestone',
      americanOdds: odds, subcatId, mainLine: true,
      headshot, dkPlayerId: dkId,
      marketId: mktId, selectionId: String(main.id), eventId: String(mkt.eventId),
    });
  }
  return players;
}

// Parse Anytime Goalscorer subcategory.
// EU format: flat selections with outcomeType='ToScoreAnyTime', multiple players per shared market.
// MLS/milestone format: one market per player, milestone selections (1+, 2+, 3+) with no outcomeType —
//   pick MostBalancedOdds selection (or lowest threshold) as the "Anytime" line.
function parseGoalscorer(data, eventMap) {
  const players = [];
  const marketsById = new Map((data.markets || []).map(m => [String(m.id), m]));

  // Pass 1: EU format — selections with explicit ToScoreAnyTime outcomeType
  const handledMarkets = new Set();
  for (const sel of (data.selections || [])) {
    if (sel.outcomeType !== 'ToScoreAnyTime') continue;
    const mkt = marketsById.get(String(sel.marketId));
    if (!mkt) continue;
    const ev = eventMap[String(mkt.eventId)];
    if (!ev) continue;
    const player = (sel.participants || [])[0] || (mkt.participants || [])[0];
    if (!player) continue;
    const odds = parseOdds(sel.displayOdds?.american);
    if (!odds) continue;
    handledMarkets.add(String(mkt.id));
    const isHome = player.venueRole === 'HomePlayer';
    const team   = isHome ? ev.homeShort : ev.awayShort;
    const opp    = isHome ? ev.awayShort : ev.homeShort;
    const dkId   = player.id || null;
    players.push({
      name: player.name, team, opp, awayShort: ev.awayShort, homeShort: ev.homeShort,
      time: ev.time, startMs: ev.startMs,
      market: 'goalscorer', stat: 'Goalscorer', espnField: 'totalGoals',
      league: ev.league, leagueId: ev.leagueId, espnSlug: ev.espnSlug,
      gameDate: ev.gameDate,
      threshold: null, direction: 'more', type: 'yn',
      americanOdds: odds, subcatId: SUBCAT_GOALSCORER, mainLine: true,
      headshot: dkId ? `/api/dk/player-image?id=${dkId}&size=lg` : null, dkPlayerId: dkId,
      marketId: String(sel.marketId), selectionId: String(sel.id), eventId: String(mkt.eventId),
    });
  }

  // Pass 2: MLS/milestone format — markets not covered by Pass 1
  const selsByMarket = new Map();
  for (const s of (data.selections || [])) {
    const arr = selsByMarket.get(String(s.marketId)) || [];
    arr.push(s);
    selsByMarket.set(String(s.marketId), arr);
  }
  for (const [mktId, sels] of selsByMarket) {
    if (handledMarkets.has(mktId)) continue;
    const mkt = marketsById.get(mktId);
    if (!mkt) continue;
    const ev = eventMap[String(mkt.eventId)];
    if (!ev) continue;
    const main = sels.find(s => (s.tags || []).includes('MostBalancedOdds'))
              || sels.slice().sort((a, b) => (a.milestoneValue ?? 999) - (b.milestoneValue ?? 999))[0];
    if (!main) continue;
    const player = (main.participants || [])[0] || (mkt.participants || [])[0];
    if (!player) continue;
    const odds = parseOdds(main.displayOdds?.american);
    if (!odds) continue;
    const isHome = player.venueRole === 'HomePlayer';
    const team   = isHome ? ev.homeShort : ev.awayShort;
    const opp    = isHome ? ev.awayShort : ev.homeShort;
    const dkId   = player.id || null;
    players.push({
      name: player.name, team, opp, awayShort: ev.awayShort, homeShort: ev.homeShort,
      time: ev.time, startMs: ev.startMs,
      market: 'goalscorer', stat: 'Goalscorer', espnField: 'totalGoals',
      league: ev.league, leagueId: ev.leagueId, espnSlug: ev.espnSlug,
      gameDate: ev.gameDate,
      threshold: null, direction: 'more', type: 'yn',
      americanOdds: odds, subcatId: SUBCAT_GOALSCORER, mainLine: true,
      headshot: dkId ? `/api/dk/player-image?id=${dkId}&size=lg` : null, dkPlayerId: dkId,
      marketId: mktId, selectionId: String(main.id), eventId: String(mkt.eventId),
    });
  }
  return players;
}

async function fetchSubcat(leagueId, subcatId) {
  const res = await fetch(leagueSubcatUrl(leagueId, subcatId), {
    headers: DK_HEADERS, signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
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
  const now     = Math.floor(Date.now() / 1000);

  // Debug: dump raw structure for a specific subcat + league
  // GET /api/dk/soccer-props?debug=1&subcat=16861&league=40253
  if (url.searchParams.has('debug')) {
    const subcatId = url.searchParams.get('subcat') || SUBCAT_GOALSCORER;
    const leagueId = url.searchParams.get('league') || '40031';
    const res  = await fetch(leagueSubcatUrl(leagueId, subcatId), { headers: DK_HEADERS, signal: AbortSignal.timeout(12000) });
    const data = await res.json();
    const sels = data.selections || [], mkts = data.markets || [], evts = data.events || [];
    const firstSel = sels[0] || {};
    return new Response(JSON.stringify({
      subcatId, leagueId,
      selectionCount: sels.length, marketCount: mkts.length, eventCount: evts.length,
      // Full first selection to see all fields (outcomeType, label, points, handicap, participants)
      firstSelFull: firstSel,
      firstSelKeys: Object.keys(firstSel),
      selSample: sels.slice(0, 5),
      mktSample: mkts.slice(0, 2),
      evtSample: evts.slice(0, 1),
    }, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }

  // Cache check
  if (!nocache) {
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(CACHE_KEY).first();
      if (cached && (now - cached.fetched_at) < CACHE_TTL) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
      }
    } catch(e) {}
  }

  const leagueEntries = Object.entries(DK_SOCCER_LEAGUES);
  const ouEntries     = Object.entries(SUBCAT_MAP_OU);

  // Fetch all leagues × all subcats in parallel
  const allTasks = [];
  for (const [leagueId, leagueInfo] of leagueEntries) {
    // O/U subcats
    for (const [subcatId, info] of ouEntries) {
      allTasks.push({ type: 'ou', leagueId, leagueInfo, subcatId, info });
    }
    // Goalscorer
    allTasks.push({ type: 'goalscorer', leagueId, leagueInfo, subcatId: SUBCAT_GOALSCORER });
  }

  const results = await Promise.allSettled(
    allTasks.map(task => fetchSubcat(task.leagueId, task.subcatId).then(data => ({ ...task, data })))
  );

  const allPlayers = [];
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value?.data) continue;
    const { type, leagueId, leagueInfo, subcatId, info, data } = r.value;
    const eventMap = buildEventMap(data.events, leagueId, leagueInfo);
    if (!Object.keys(eventMap).length) continue;

    if (type === 'ou') {
      allPlayers.push(...parseMilestone(data, eventMap, subcatId, info));
    } else {
      allPlayers.push(...parseGoalscorer(data, eventMap));
    }
  }

  const payload = JSON.stringify({ ok: true, players: allPlayers, count: allPlayers.length, ts: now });

  context.waitUntil(
    env.DB.prepare(
      'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
    ).bind(CACHE_KEY, payload, now).run().catch(() => {})
  );

  return new Response(payload, { headers: { 'Content-Type': 'application/json' } });
}
