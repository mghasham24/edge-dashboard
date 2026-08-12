// functions/api/dk/mlb-props.js
// GET /api/dk/mlb-props
// Returns MLB player prop options for the parlays builder.
// Headshots served via /api/dk/player-image?id={dkPlayerId} (proxied through our CF worker).

import { getSessionOrCron } from '../../_lib/auth.js';

const DK_BASE   = 'https://sportsbook-nash.draftkings.com/sites/US-SB/api/sportscontent';
const DK_LEAGUE = '84240';
const CACHE_TTL = 300; // 5 min
const CACHE_KEY = 'dk_mlb_props_v12';

// Standard subcategories — available at league level
const SUBCAT_MAP = {
  '6719':  { market: 'hits',         stat: 'Hits',         type: 'ou' },
  '6607':  { market: 'total_bases',  stat: 'Total Bases',  type: 'ou' },
  '8025':  { market: 'rbis',         stat: 'RBIs',         type: 'ou' },
  '17406': { market: 'hrbi',         stat: 'H+R+RBI',      type: 'ou' },
  '15221': { market: 'pitcher_ks',   stat: 'Pitcher Ks',   type: 'ou' },
  '17413': { market: 'outs_ou',      stat: 'Outs',         type: 'ou' },
  '17409': { market: 'singles',      stat: 'Singles',      type: 'ou' },
  '17408': { market: 'stolen_bases', stat: 'Stolen Bases', type: 'ou' },
  '17410': { market: 'doubles',      stat: 'Doubles',      type: 'ou' },
  '17411': { market: 'walks',        stat: 'Walks',        type: 'ou' },
  '9886':  { market: 'hits_allowed', stat: 'Hits Allowed', type: 'ou' },
  '17412': { market: 'er_allowed',   stat: 'ER Allowed',   type: 'ou' },
  '15219': { market: 'bb_allowed',   stat: 'BB Allowed',   type: 'ou' },
  '19459': { market: 'hwer',         stat: 'H+W+ER',       type: 'ou' },
};

// Runs O/U only exists at the event level — fetched per-event after getting today's event list
const RUNS_SUBCAT = '17407';
const RUNS_INFO   = { market: 'runs', stat: 'Runs', type: 'ou' };

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

    // DK player ID — used to construct headshot URL via our proxy
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

// Fetch league-level subcategory, returns { players, events }
async function fetchSubcat(subcatId, info) {
  const res = await fetch(subcatUrl(subcatId), {
    headers: DK_HEADERS,
    signal:  AbortSignal.timeout(12000),
  });
  if (!res.ok) return { players: [], events: [] };
  const data = await res.json();
  return { players: parseSubcat(data, subcatId, info), events: data.events || [] };
}

// Event-level URL for subcategories only available per-event (e.g. Runs O/U)
function eventSubcatUrl(eventId, subcatId) {
  const mq = encodeURIComponent(
    `$filter=eventId eq '${eventId}' AND clientMetadata/subCategoryId eq '${subcatId}' AND tags/all(t: t ne 'SportcastBetBuilder')`
  );
  return `${DK_BASE}/controldata/event/eventSubcategory/v1/markets?isBatchable=false` +
         `&templateVars=${eventId}%2C${subcatId}&marketsQuery=${mq}&entity=markets`;
}

// Parse event-level response (no events array — metadata passed in)
function parseEventMarkets(data, eventId, homeShort, awayShort, timeStr, startMs, subcatId, info) {
  const players = [];
  const selsByMarket = new Map();
  for (const s of (data.selections || [])) {
    const arr = selsByMarket.get(String(s.marketId)) || [];
    arr.push(s);
    selsByMarket.set(String(s.marketId), arr);
  }
  for (const mkt of (data.markets || [])) {
    const sels    = selsByMarket.get(String(mkt.id)) || [];
    const over    = sels.find(s => s.outcomeType === 'Over'  || s.label === 'Over');
    const under   = sels.find(s => s.outcomeType === 'Under' || s.label === 'Under');
    if (!over || !under) continue;
    const player  = (over.participants || [])[0];
    if (!player) continue;
    const line    = over.points ?? under.points;
    if (line == null) continue;
    const oddsOver  = parseOdds(over.displayOdds?.american);
    const oddsUnder = parseOdds(under.displayOdds?.american);
    if (!oddsOver || !oddsUnder) continue;
    const dkPlayerId = player.id || player.metadata?.playerId || null;
    const headshot   = dkPlayerId ? `/api/dk/player-image?id=${dkPlayerId}&size=lg` : null;
    const isHome = player.venueRole === 'HomePlayer';
    const team   = isHome ? homeShort : awayShort;
    const opp    = isHome ? awayShort : homeShort;
    const mktId  = String(mkt.id);
    const mainLine = (over.tags || []).includes('MainPointLine');
    players.push(
      { name: player.name, team, opp, time: timeStr, startMs, market: info.market, stat: info.stat,
        threshold: line, label: `Over ${line}`, direction: 'more', americanOdds: oddsOver,
        marketId: mktId, selectionId: String(over.id), eventId: String(eventId),
        subcatId, mainLine, headshot, dkPlayerId },
      { name: player.name, team, opp, time: timeStr, startMs, market: info.market, stat: info.stat,
        threshold: line, label: `Under ${line}`, direction: 'less', americanOdds: oddsUnder,
        marketId: mktId, selectionId: String(under.id), eventId: String(eventId),
        subcatId, mainLine, headshot, dkPlayerId }
    );
  }
  return players;
}

async function fetchRunsForEvent(eventId, homeShort, awayShort, timeStr, startMs) {
  const res = await fetch(eventSubcatUrl(eventId, RUNS_SUBCAT), {
    headers: DK_HEADERS,
    signal:  AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return parseEventMarkets(data, eventId, homeShort, awayShort, timeStr, startMs, RUNS_SUBCAT, RUNS_INFO);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSessionOrCron(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url       = new URL(request.url);
  const debugMode = url.searchParams.get('debug');
  const now       = Math.floor(Date.now() / 1000);

  // Debug: dump raw participant structure so we can verify dkPlayerId field
  if (debugMode === '1') {
    const subcatId = url.searchParams.get('subcat') || '6719';
    const res  = await fetch(subcatUrl(subcatId), { headers: DK_HEADERS, signal: AbortSignal.timeout(12000) });
    const data = await res.json();
    const sels = data.selections || [];
    const sample = sels.slice(0, 6).map(s => ({
      selId: s.id, label: s.label, outcomeType: s.outcomeType,
      participants: s.participants,
    }));
    return new Response(JSON.stringify({ selectionCount: sels.length, sample }, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Serve from cache if fresh
  const nocache = url.searchParams.has('nocache');
  try {
    const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(CACHE_KEY).first();
    if (!nocache && cached && (now - cached.fetched_at) < CACHE_TTL) {
      return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
    }
  } catch(e) {}

  // Step 1: fetch hits first — its events array gives us today's game metadata for the Runs fetch
  const hitsResult = await fetchSubcat('6719', SUBCAT_MAP['6719']).catch(() => ({ players: [], events: [] }));
  const today = todayET();
  const todayEvents = hitsResult.events.filter(e => {
    const d = e.startEventDate
      ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(e.startEventDate))
      : '';
    return !d || d >= today;
  });

  // Step 2: fetch remaining league subcategories + per-event Runs in parallel
  const otherEntries = Object.entries(SUBCAT_MAP).filter(([id]) => id !== '6719');
  const [otherResults, runsResults] = await Promise.all([
    Promise.allSettled(otherEntries.map(([subcatId, info]) => fetchSubcat(subcatId, info))),
    Promise.allSettled(todayEvents.map(e => {
      const startMs   = e.startEventDate ? new Date(e.startEventDate).getTime() : 0;
      const timeStr   = startMs
        ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(startMs))
        : '';
      const evParts   = e.participants || [];
      const homePart  = evParts.find(p => p.venueRole === 'Home');
      const awayPart  = evParts.find(p => p.venueRole === 'Away');
      const homeShort = homePart?.metadata?.shortName || homePart?.name || '';
      const awayShort = awayPart?.metadata?.shortName || awayPart?.name || '';
      return fetchRunsForEvent(String(e.id), homeShort, awayShort, timeStr, startMs);
    })),
  ]);

  const allPlayers = [...hitsResult.players];
  for (const r of [...otherResults, ...runsResults]) {
    if (r.status === 'fulfilled') allPlayers.push(...(r.value.players ?? r.value));
  }

  // Include DK event full team names so player-rs-ids can map eventId → RS game ID
  const games = todayEvents.map(e => {
    const parts   = e.participants || [];
    const homePart = parts.find(p => p.venueRole === 'Home');
    const awayPart = parts.find(p => p.venueRole === 'Away');
    return { eventId: String(e.id), home: homePart?.name || '', away: awayPart?.name || '' };
  }).filter(g => g.home && g.away);

  const payload = JSON.stringify({ ok: true, players: allPlayers, count: allPlayers.length, games, ts: now });

  // Cache so next request within TTL is instant
  context.waitUntil(
    env.DB.prepare(
      'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
    ).bind(CACHE_KEY, payload, now).run().catch(() => {})
  );

  return new Response(payload, { headers: { 'Content-Type': 'application/json' } });
}
