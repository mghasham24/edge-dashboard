// functions/api/dk/nhalalts.js
// Fetches DraftKings alternate puck line + total lines for NHL games
// Used as fallback fair value source when FD line ≠ Real Sports line
// Step 1: Get today's NHL events from DK league endpoint (league 42133, subcat 13189)
// Step 2: Fetch alt puck lines (13189) + alt totals (13192) per game in parallel

const DK_BASE       = 'https://sportsbook-nash.draftkings.com/sites/US-SB/api/sportscontent';
const DK_LEAGUE_ID  = '42133'; // NHL
const DK_ALT_SPREAD = '13189'; // alt puck line
const DK_ALT_TOTAL  = '13192'; // alt total goals
const CACHE_TTL     = 5;

// Filter by alt totals (13192) so we still get games where DK has suspended puck lines (13189)
const DK_EVENTS_URL = `${DK_BASE}/controldata/league/leagueSubcategory/v1/markets?isBatchable=false&templateVars=${DK_LEAGUE_ID}&eventsQuery=%24filter%3DleagueId%20eq%20%27${DK_LEAGUE_ID}%27%20AND%20clientMetadata%2FSubcategories%2Fany%28s%3A%20s%2FId%20eq%20%27${DK_ALT_TOTAL}%27%29&marketsQuery=%24filter%3DclientMetadata%2FsubCategoryId%20eq%20%27${DK_ALT_TOTAL}%27%20AND%20tags%2Fall%28t%3A%20t%20ne%20%27SportcastBetBuilder%27%29&include=Events&entity=events`;

function dkAltUrl(eventId, subCatId) {
  const mq = encodeURIComponent(
    `$filter=eventId eq '${eventId}' AND clientMetadata/subCategoryId eq '${subCatId}' AND tags/all(t: t ne 'SportcastBetBuilder')`
  );
  return `${DK_BASE}/controldata/event/eventSubcategory/v1/markets?isBatchable=false&templateVars=${eventId}%2C${subCatId}&marketsQuery=${mq}&entity=markets`;
}

function parseAmerican(str) {
  if (!str) return null;
  const s = String(str).replace(/\u2212/g, '-').replace(/[^0-9+\-]/g, '');
  const n = parseInt(s, 10);
  return isFinite(n) ? n : null;
}

async function getSession(request, db) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return null;
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    'SELECT u.id as user_id, u.plan FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(m[1], now).first();
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');

  const reqUrl = new URL(request.url);
  const debugMode = reqUrl.searchParams.get('debug');

  const now = Math.floor(Date.now() / 1000);
  const cacheKey = 'dk_nhl_alts';

  // Read existing cache — use as fresh response if within TTL, keep as fallback for live-game alt line persistence
  let oldGamesFallback = {};
  try {
    const cached = await env.DB.prepare(
      'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
    ).bind(cacheKey).first();
    if (cached) {
      if (!debugMode && (now - cached.fetched_at) < CACHE_TTL) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
      }
      try {
        const old = JSON.parse(cached.data);
        oldGamesFallback = old.games || {};
      } catch(e) {}
    }
  } catch(e) {}

  const headers = {
    'Accept': '*/*',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
    'Origin': 'https://sportsbook.draftkings.com',
    'Referer': 'https://sportsbook.draftkings.com/'
  };

  try {
    // Step 1: Get today's NHL events
    const evRes = await fetch(DK_EVENTS_URL, { headers });
    if (!evRes.ok) return fail(evRes.status, 'DK NHL events fetch failed: ' + evRes.status);
    const evData = await evRes.json();

    const nowMs = Date.now();
    const etFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
    const todayET = etFmt.format(new Date());
    const allEvents = (evData.events || []);
    const events = allEvents.filter(e => {
      if (!e.startEventDate) return false;
      const t = new Date(e.startEventDate).getTime();
      if (t < nowMs - 3 * 60 * 60 * 1000) return false;
      return etFmt.format(new Date(e.startEventDate)) === todayET;
    });

    if (debugMode === '1') {
      return new Response(JSON.stringify({
        totalEvents: allEvents.length,
        filteredEvents: events.length,
        events: events.map(e => ({ id: e.id, name: e.name, startEventDate: e.startEventDate }))
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (!events.length) {
      return new Response(JSON.stringify({ ok: true, games: {} }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Step 2: Fetch all games in parallel — spread + total per game also parallel
    const gamesMap = {};

    await Promise.all(events.map(async function(event) {
      const away = (event.participants || []).find(p => p.venueRole === 'Away');
      const home = (event.participants || []).find(p => p.venueRole === 'Home');
      if (!away || !home) return;

      const gameKey = away.name + ' @ ' + home.name;

      try {
        const [spreadRes, totalRes] = await Promise.all([
          fetch(dkAltUrl(event.id, DK_ALT_SPREAD), { headers }),
          fetch(dkAltUrl(event.id, DK_ALT_TOTAL),  { headers })
        ]);

        const altData = { spreads: { Away: {}, Home: {} }, totals: { Over: {}, Under: {} } };

        if (spreadRes.ok) {
          const sd = await spreadRes.json();
          (sd.selections || []).forEach(function(sel) {
            const price = parseAmerican(sel.displayOdds && sel.displayOdds.american);
            if (price == null || sel.points == null) return;
            const t = sel.outcomeType;
            if (t === 'Away' || t === 'Home') altData.spreads[t][sel.points] = price;
          });
        }

        if (totalRes.ok) {
          const td = await totalRes.json();
          (td.selections || []).forEach(function(sel) {
            const price = parseAmerican(sel.displayOdds && sel.displayOdds.american);
            if (price == null || sel.points == null) return;
            const tRaw = sel.outcomeType || '';
            const tLow = tRaw.toLowerCase();
            const t = tLow.includes('over') ? 'Over' : tLow.includes('under') ? 'Under' : null;
            if (t) altData.totals[t][sel.points] = price;
          });
        }

        gamesMap[gameKey] = altData;
      } catch(e) {}
    }));

    // Fallback: restore pre-game data when DK suspends in-game alt lines
    Object.entries(oldGamesFallback).forEach(([gameKey, oldGame]) => {
      const hadSpreads = Object.keys((oldGame.spreads && oldGame.spreads.Away) || {}).length > 0;
      const hadTotals  = Object.keys((oldGame.totals  && oldGame.totals.Over)   || {}).length > 0;
      if (!hadSpreads && !hadTotals) return;

      if (!gamesMap[gameKey]) {
        gamesMap[gameKey] = oldGame;
        return;
      }
      const curr = gamesMap[gameKey];
      if (hadSpreads && Object.keys((curr.spreads && curr.spreads.Away) || {}).length === 0) {
        curr.spreads = oldGame.spreads;
      }
      if (hadTotals && Object.keys((curr.totals && curr.totals.Over) || {}).length === 0) {
        curr.totals = oldGame.totals;
      }
    });

    if (debugMode === '2') {
      return new Response(JSON.stringify({ ok: true, games: gamesMap }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (debugMode === '3') {
      // Raw DK total selections per game — use to debug outcomeType / points format
      const rawDebug = {};
      await Promise.all(events.map(async function(event) {
        const away = (event.participants || []).find(p => p.venueRole === 'Away');
        const home = (event.participants || []).find(p => p.venueRole === 'Home');
        if (!away || !home) return;
        const gameKey = away.name + ' @ ' + home.name;
        try {
          const totalRes2 = await fetch(dkAltUrl(event.id, DK_ALT_TOTAL), { headers });
          if (totalRes2.ok) {
            const td2 = await totalRes2.json();
            rawDebug[gameKey] = (td2.selections || []).slice(0, 10).map(s => ({
              outcomeType: s.outcomeType, points: s.points, american: s.displayOdds && s.displayOdds.american
            }));
          } else {
            rawDebug[gameKey] = { error: totalRes2.status };
          }
        } catch(e) { rawDebug[gameKey] = { error: e.message }; }
      }));
      return new Response(JSON.stringify({ rawDebug }), { headers: { 'Content-Type': 'application/json' } });
    }

    const body = JSON.stringify({ ok: true, games: gamesMap });
    try {
      await env.DB.prepare(
        'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
      ).bind(cacheKey, body, now).run();
    } catch(e) {}

    return new Response(body, { headers: { 'Content-Type': 'application/json' } });

  } catch(e) {
    return fail(500, e.message);
  }
}
