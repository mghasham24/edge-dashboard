// functions/api/dk/nbaalts.js
// Fetches DraftKings alternate spread + total lines for NBA games
// Used as fallback fair value source when FD line ≠ Real Sports line
// Step 1: Get today's NBA events from DK league endpoint
// Step 2: Fetch alt spreads (13202) + alt totals (13201) per game in parallel

const DK_BASE    = 'https://sportsbook-nash.draftkings.com/sites/US-SB/api/sportscontent';
const DK_LEAGUE_ID = '42648'; // NBA
const DK_ALT_SPREAD  = '13202';
const DK_ALT_TOTAL   = '13201';
const DK_MAIN_SPREAD = '4511';
const DK_MAIN_TOTAL  = '4513';
const CACHE_TTL = 5;

const DK_EVENTS_URL = `${DK_BASE}/controldata/league/leagueSubcategory/v1/markets?isBatchable=false&templateVars=${DK_LEAGUE_ID}&eventsQuery=%24filter%3DleagueId%20eq%20%27${DK_LEAGUE_ID}%27%20AND%20clientMetadata%2FSubcategories%2Fany%28s%3A%20s%2FId%20eq%20%274511%27%29&marketsQuery=%24filter%3DclientMetadata%2FsubCategoryId%20eq%20%274511%27%20AND%20tags%2Fall%28t%3A%20t%20ne%20%27SportcastBetBuilder%27%29&include=Events&entity=events`;

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
  const reqUrl = new URL(request.url);
  const cronKey = reqUrl.searchParams.get('_cron_key');
  let session;
  if (cronKey && env.CRON_SECRET && cronKey === env.CRON_SECRET) {
    session = { user_id: 0, plan: 'pro', is_admin: 1 };
  } else {
    session = await getSession(request, env.DB);
    if (!session) return fail(401, 'Not authenticated');
  }

  const debugMode = reqUrl.searchParams.get('debug');

  const now = Math.floor(Date.now() / 1000);
  const cacheKey = 'dk_nba_alts';

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
    // Step 1: Get today's NBA events
    const evRes = await fetch(DK_EVENTS_URL, { headers });
    if (!evRes.ok) return fail(evRes.status, 'DK events fetch failed: ' + evRes.status);
    const evData = await evRes.json();

    const nowMs = Date.now();
    const etFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
    const todayET     = etFmt.format(new Date());
    const yesterdayET = etFmt.format(new Date(nowMs - 24 * 60 * 60 * 1000));
    const allEvents = (evData.events || []);
    const events = allEvents.filter(e => {
      if (!e.startEventDate) return false;
      const t = new Date(e.startEventDate).getTime();
      if (t < nowMs - 4 * 60 * 60 * 1000) return false;
      // Include yesterday's ET games — late west-coast NBA games cross the midnight ET boundary
      const startET = etFmt.format(new Date(e.startEventDate));
      return startET === todayET || startET === yesterdayET;
    });

    if (debugMode === '1') {
      return new Response(JSON.stringify({
        totalEvents: allEvents.length,
        filteredEvents: events.length,
        events: events.map(e => ({
          id: e.id,
          name: e.name,
          startEventDate: e.startEventDate,
          msSinceStart: nowMs - new Date(e.startEventDate).getTime(),
          status: e.eventStatus || e.status
        }))
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
        const [spreadRes, totalRes, mainSpreadRes, mainTotalRes] = await Promise.all([
          fetch(dkAltUrl(event.id, DK_ALT_SPREAD),  { headers }),
          fetch(dkAltUrl(event.id, DK_ALT_TOTAL),   { headers }),
          fetch(dkAltUrl(event.id, DK_MAIN_SPREAD), { headers }),
          fetch(dkAltUrl(event.id, DK_MAIN_TOTAL),  { headers }),
        ]);

        const altData = { spreads: { Away: {}, Home: {} }, totals: { Over: {}, Under: {} } };

        // Alt spreads (excludes DK main line)
        if (spreadRes.ok) {
          const sd = await spreadRes.json();
          (sd.selections || []).forEach(function(sel) {
            const price = parseAmerican(sel.displayOdds && sel.displayOdds.american);
            if (price == null || sel.points == null) return;
            const t = sel.outcomeType;
            if (t === 'Away' || t === 'Home') altData.spreads[t][sel.points] = price;
          });
        }

        // Alt totals (excludes DK main line)
        if (totalRes.ok) {
          const td = await totalRes.json();
          (td.selections || []).forEach(function(sel) {
            const price = parseAmerican(sel.displayOdds && sel.displayOdds.american);
            if (price == null || sel.points == null) return;
            const t = sel.outcomeType;
            if (t === 'Over' || t === 'Under') altData.totals[t][sel.points] = price;
          });
        }

        // DK main spread — fill in the line that alt market omits
        if (mainSpreadRes.ok) {
          const msd = await mainSpreadRes.json();
          (msd.selections || []).forEach(function(sel) {
            const price = parseAmerican(sel.displayOdds && sel.displayOdds.american);
            if (price == null || sel.points == null) return;
            const t = sel.outcomeType;
            if ((t === 'Away' || t === 'Home') && altData.spreads[t][sel.points] == null) {
              altData.spreads[t][sel.points] = price;
            }
          });
        }

        // DK main total — fill in the line that alt market omits
        if (mainTotalRes.ok) {
          const mtd = await mainTotalRes.json();
          (mtd.selections || []).forEach(function(sel) {
            const price = parseAmerican(sel.displayOdds && sel.displayOdds.american);
            if (price == null || sel.points == null) return;
            const t = sel.outcomeType;
            if ((t === 'Over' || t === 'Under') && altData.totals[t][sel.points] == null) {
              altData.totals[t][sel.points] = price;
            }
          });
        }

        gamesMap[gameKey] = altData;
      } catch(e) {}
    }));

    // Fallback: restore pre-game spread/total data separately so live totals are preserved.
    // DK suspends alt spreads for in-game but may still have live alt totals — merge rather than replace.
    Object.entries(oldGamesFallback).forEach(([gameKey, oldGame]) => {
      const hadSpreads = Object.keys((oldGame.spreads && oldGame.spreads.Away) || {}).length > 0;
      const hadTotals  = Object.keys((oldGame.totals  && oldGame.totals.Over)   || {}).length > 0;
      if (!hadSpreads && !hadTotals) return;

      if (!gamesMap[gameKey]) {
        // Game not in current DK response at all — restore whole old entry
        gamesMap[gameKey] = oldGame;
        return;
      }
      const curr = gamesMap[gameKey];
      // Only restore what's missing — keep any live data DK is currently providing
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
