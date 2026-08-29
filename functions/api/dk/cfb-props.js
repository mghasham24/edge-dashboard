// functions/api/dk/cfb-props.js
// GET /api/dk/cfb-props
// Returns today's CFB player props from DK for the parlay builder.
// League 87637 (NCAAF). Subcats: 16568 (Pass TDs), 16569 (Pass Yds), 16570 (Recv Yds), 16571 (Rush Yds), 18497 (Combo Rush Yds).
// All CFB player props are milestone markets (150+, 175+, etc.) — direction always 'more'.

import { getSessionOrCron } from '../../_lib/auth.js';

const DK_BASE      = 'https://sportsbook-nash.draftkings.com/sites/US-SB/api/sportscontent';
const DK_LEAGUE    = '87637'; // NCAAF
const LINES_SUBCAT = '4518';  // used only for events list
const CACHE_TTL    = 900;     // 15 minutes
const CACHE_KEY    = 'dk_cfb_props_v1';
const COMBO_RUSH_SUBCAT = '18497'; // Combined Rushing Yards Milestones

const PROP_SUBCAT_MAP = {
  '16568': { market: 'cfb_pass_tds', stat: 'Pass TDs' },
  '16569': { market: 'cfb_pass_yds', stat: 'Pass Yds' },
  '16570': { market: 'cfb_recv_yds', stat: 'Rec Yds' },
  '16571': { market: 'cfb_rush_yds', stat: 'Rush Yds' },
};

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

function propsUrl(eventId, subcatId) {
  const mq = encodeURIComponent(
    `$filter=eventId eq '${eventId}' AND clientMetadata/subCategoryId eq '${subcatId}' AND tags/all(t: t ne 'SportcastBetBuilder')`
  );
  return `${DK_BASE}/controldata/event/eventSubcategory/v1/markets?isBatchable=false` +
         `&templateVars=${eventId}%2C${subcatId}&marketsQuery=${mq}&include=MarketSplits&entity=markets`;
}

// Parse "Player Name (TEAM) Stat Type" → { player, team } or null
function parseMarketName(name) {
  const m = name.match(/^(.+?)\s+\(([A-Z0-9]+)\)\s+.+$/);
  if (!m) return null;
  return { player: m[1].trim(), team: m[2].trim() };
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

  if (!nocache && !debug) {
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(CACHE_KEY).first();
      if (cached && (now - cached.fetched_at) < CACHE_TTL) {
        return new Response(cached.data, { headers: JSON_HEADERS });
      }
    } catch(e) {}
  }

  // Get today's events
  const evRes = await fetch(eventsUrl(), { headers: DK_HEADERS, signal: AbortSignal.timeout(12000) });
  if (!evRes.ok) {
    return new Response(JSON.stringify({ ok: false, error: 'events fetch failed' }), { headers: JSON_HEADERS });
  }
  const evData = await evRes.json();

  const todayEvents = (evData.events || []).filter(e => {
    const d = e.startEventDate
      ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(e.startEventDate))
      : '';
    return d === today;
  });

  if (!todayEvents.length) {
    return new Response(JSON.stringify({ ok: true, players: [], ts: now }), { headers: JSON_HEADERS });
  }

  if (debug === '1') {
    const e = todayEvents[0];
    const raw = await fetch(propsUrl(String(e.id), '16569'), { headers: DK_HEADERS, signal: AbortSignal.timeout(10000) });
    const rawData = await raw.json();
    return new Response(JSON.stringify({ eventId: e.id, participants: e.participants, rawData }, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const allPlayers = [];

  await Promise.allSettled(todayEvents.map(async e => {
    const startMs  = e.startEventDate ? new Date(e.startEventDate).getTime() : 0;
    const timeStr  = startMs
      ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(startMs))
      : '';
    const gameDate = e.startEventDate
      ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(startMs))
      : today;
    const parts    = e.participants || [];
    const homePart = parts.find(p => p.venueRole === 'Home');
    const awayPart = parts.find(p => p.venueRole === 'Away');
    const homeShort = homePart?.metadata?.shortName || homePart?.name || '';
    const awayShort = awayPart?.metadata?.shortName || awayPart?.name || '';
    const eventId   = String(e.id);

    // Fetch all 4 individual prop subcats + 1 combo subcat in parallel with 5s timeout each
    const subcatEntries = Object.entries(PROP_SUBCAT_MAP);
    const allFetchIds   = [...subcatEntries.map(([id]) => id), COMBO_RUSH_SUBCAT];
    const subcatResults = await Promise.allSettled(
      allFetchIds.map(subcatId =>
        fetch(propsUrl(eventId, subcatId), { headers: DK_HEADERS, signal: AbortSignal.timeout(5000) })
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
      )
    );

    // Individual prop subcats (indices 0..3)
    for (let i = 0; i < subcatEntries.length; i++) {
      const [subcatId, subcatMeta] = subcatEntries[i];
      const data = subcatResults[i].status === 'fulfilled' ? subcatResults[i].value : null;
      if (!data) continue;

      // Build selection lookup: marketId → selections[]
      const selsByMarket = new Map();
      for (const s of (data.selections || [])) {
        const arr = selsByMarket.get(String(s.marketId)) || [];
        arr.push(s);
        selsByMarket.set(String(s.marketId), arr);
      }

      for (const mkt of (data.markets || [])) {
        const parsed = parseMarketName(mkt.name || '');
        if (!parsed) continue;
        const { player, team } = parsed;

        const isHome = team === homeShort;
        const isAway = team === awayShort;
        const opp    = isHome ? awayShort : isAway ? homeShort : '';

        const sels = selsByMarket.get(String(mkt.id)) || [];
        for (const sel of sels) {
          const threshold = sel.milestoneValue ?? sel.points ?? null;
          if (threshold == null) continue;
          const odds = parseOdds(sel.displayOdds?.american);
          if (odds == null) continue;

          allPlayers.push({
            name:           player,
            market:         subcatMeta.market,
            stat:           subcatMeta.stat,
            type:           'milestone',
            direction:      'more',
            threshold:      threshold,
            milestoneLabel: threshold + '+',
            americanOdds:   odds,
            selectionId:    String(sel.id),
            marketId:       String(mkt.id),
            subcatId:       subcatId,
            eventId:        eventId,
            team:           team,
            opp:            opp,
            isHome:         isHome,
            startMs:        startMs,
            time:           timeStr,
            gameDate:       gameDate,
            awayShort:      awayShort,
            homeShort:      homeShort,
            headshot:       null,
          });
        }
      }
    }

    // Combo rush yards subcat (last index) — keep only the highest-threshold market per game (the starters)
    const comboData = subcatResults[subcatEntries.length].status === 'fulfilled' ? subcatResults[subcatEntries.length].value : null;
    if (comboData) {
      const comboSelsByMarket = new Map();
      for (const s of (comboData.selections || [])) {
        const arr = comboSelsByMarket.get(String(s.marketId)) || [];
        arr.push(s);
        comboSelsByMarket.set(String(s.marketId), arr);
      }

      // Find market with highest max milestoneValue (= two players with most combined rush volume)
      let bestMkt = null, bestMaxVal = -1;
      for (const mkt of (comboData.markets || [])) {
        const sels = comboSelsByMarket.get(String(mkt.id)) || [];
        const maxVal = sels.reduce((m, s) => Math.max(m, s.milestoneValue ?? 0), 0);
        if (maxVal > bestMaxVal) { bestMaxVal = maxVal; bestMkt = mkt; }
      }

      if (bestMkt) {
        // Parse "Player1 (TEAM1) & Player2 (TEAM2) - Combined Rushing Yards"
        const cm = (bestMkt.name || '').match(/^(.+?)\s*\([^)]+\)\s*&\s*(.+?)\s*\([^)]+\)\s*-/);
        if (cm) {
          const player1 = cm[1].trim(); // e.g. "Waymond Jordan"
          const player2 = cm[2].trim(); // e.g. "King Miller"
          const last1 = player1.split(' ').pop();
          const last2 = player2.split(' ').pop();
          const displayName  = last1 + ' & ' + last2;
          const initials     = ((last1[0] || '') + (last2[0] || '')).toUpperCase();
          const comboPlayers = [player1, player2];

          const bestSels = comboSelsByMarket.get(String(bestMkt.id)) || [];
          for (const sel of bestSels) {
            const threshold = sel.milestoneValue ?? null;
            if (threshold == null) continue;
            const odds = parseOdds(sel.displayOdds?.american);
            if (odds == null) continue;

            allPlayers.push({
              name:           displayName,
              market:         'cfb_combo_rush_yds',
              stat:           'Combined Rush Yds',
              type:           'milestone',
              direction:      'more',
              threshold:      threshold,
              milestoneLabel: threshold + '+',
              americanOdds:   odds,
              selectionId:    String(sel.id),
              marketId:       String(bestMkt.id),
              subcatId:       COMBO_RUSH_SUBCAT,
              eventId:        eventId,
              team:           awayShort,
              opp:            homeShort,
              isHome:         false,
              startMs:        startMs,
              time:           timeStr,
              gameDate:       gameDate,
              awayShort:      awayShort,
              homeShort:      homeShort,
              headshot:       null,
              initials:       initials,
              comboPlayers:   comboPlayers,
            });
          }
        }
      }
    }
  }));

  const payload = JSON.stringify({ ok: true, players: allPlayers, ts: now });

  context.waitUntil(
    env.DB.prepare(
      'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
    ).bind(CACHE_KEY, payload, now).run().catch(() => {})
  );

  return new Response(payload, { headers: JSON_HEADERS });
}
