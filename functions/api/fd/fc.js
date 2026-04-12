// functions/api/fd/fc.js
// Fetches DraftKings real-time soccer Asian Handicap ±0.5 spread odds for top European leagues
// Subcat 13170 = actual 2-way ±0.5 AH (Home -0.5 / Away +0.5), exact same market as Real Sports
// Step 1: For each target league, get today's events from DK league endpoint
// Step 2: For each event, fetch subcat 13170 to get actual ±0.5 prices

const DK_BASE = 'https://sportsbook-nash.draftkings.com/sites/US-SB/api/sportscontent';
const DK_SUBCAT = '13170'; // Soccer Asian Handicap ±0.5 (2-way, no draw)
const CACHE_TTL = 4; // 4s ensures the 5s frontend poller always gets a fresh DK fetch

// DK league IDs for target European soccer leagues (confirmed via API discovery)
const DK_SOCCER_LEAGUES = {
  '40253': 'EPL',
  '40031': 'La Liga',
  '40030': 'Serie A',
  '40032': 'Ligue 1',
  '40481': 'Bundesliga',
  '89345': 'MLS',
  // UCL: TBD — UCL plays Tues/Wed; add leagueId when found
};

function dkLeagueEventsUrl(leagueId) {
  // eventsQuery: no subcat filter so live events aren't dropped when AH is suspended
  // marketsQuery: still references subcat so the endpoint has required context
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
  const s = String(str).replace(/\u2212/g, '-').replace(/[^0-9+\-]/g, '');
  const n = parseInt(s, 10);
  return isFinite(n) ? n : null;
}

function isToday_ET(dateStr) {
  if (!dateStr) return false;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  return fmt.format(new Date(dateStr)) === fmt.format(new Date());
}

async function getSession(request, db) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return null;
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    'SELECT u.id as user_id, u.plan, u.is_admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
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
  if (session.plan !== 'pro' && !session.is_admin) return fail(403, 'Pro plan required');

  const reqUrl = new URL(request.url);
  const debugMode = reqUrl.searchParams.get('debug');

  const now = Math.floor(Date.now() / 1000);
  const cacheKey = 'fd_fc';

  if (!debugMode) {
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
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
    'Origin': 'https://sportsbook.draftkings.com',
    'Referer': 'https://sportsbook.draftkings.com/'
  };

  const nowMs = Date.now();

  try {
    // Step 1: Get today's events from each target league
    const todayEvents = [];

    for (const [leagueId, leagueLabel] of Object.entries(DK_SOCCER_LEAGUES)) {
      try {
        const r = await fetch(dkLeagueEventsUrl(leagueId), { headers });
        if (!r.ok) {
          if (debugMode === '1') todayEvents.push({ _error: `league ${leagueId} status ${r.status}` });
          continue;
        }
        const d = await r.json();
        if (debugMode === '1' && !d.events) todayEvents.push({ _warn: `league ${leagueId} no events key`, keys: Object.keys(d) });

        for (const ev of d.events || []) {
          if (!isToday_ET(ev.startEventDate)) continue;
          const t = new Date(ev.startEventDate).getTime();
          if (t < nowMs - 4 * 60 * 60 * 1000) continue; // skip games started >4h ago (covers 90min + stoppage + halftime)

          // Resolve home/away from participants array (most reliable)
          let home, away;
          const parts_arr = ev.participants || [];
          const homeP = parts_arr.find(p => p.venueRole === 'Home');
          const awayP = parts_arr.find(p => p.venueRole === 'Away');
          if (homeP && awayP) {
            home = homeP.name; away = awayP.name;
          } else {
            // Fallback: DK soccer event name format: "Home vs Away"
            const parts = (ev.name || '').split(' vs ');
            if (parts.length !== 2) continue;
            home = parts[0].trim(); away = parts[1].trim();
          }

          todayEvents.push({ eventId: ev.id, home, away, league: leagueLabel, openDate: ev.startEventDate });
        }
      } catch(e) {}

      await new Promise(r => setTimeout(r, 80));
    }

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

    // Step 2: For each event, fetch subcat 13170 to get actual ±0.5 AH prices
    const gamesMap = {};

    for (let i = 0; i < todayEvents.length; i++) {
      const ev = todayEvents[i];
      const gameKey = ev.away + ' @ ' + ev.home;

      try {
        const r = await fetch(dkEventSubcatUrl(ev.eventId), { headers });
        if (!r.ok) continue;
        const d = await r.json();

        // DK subcat 13170 always puts Home at -0.5 and Away at +0.5 by default,
        // but RS assigns -0.5 to the FAVORITE regardless of home/away.
        // Extract all four ±0.5 prices and pick the pair matching RS convention.
        let homeMinus = null, homePlus = null, awayMinus = null, awayPlus = null;

        for (const sel of d.selections || []) {
          const pts = sel.points;
          const ot = sel.outcomeType;
          const price = parseAmerican(sel.displayOdds && sel.displayOdds.american);
          if (price == null || pts == null) continue;

          if (ot === 'Home' && Math.abs(pts + 0.5) < 0.01) homeMinus = price; // Home -0.5 (must win)
          if (ot === 'Home' && Math.abs(pts - 0.5) < 0.01) homePlus  = price; // Home +0.5 (wins or draws)
          if (ot === 'Away' && Math.abs(pts + 0.5) < 0.01) awayMinus = price; // Away -0.5 (must win)
          if (ot === 'Away' && Math.abs(pts - 0.5) < 0.01) awayPlus  = price; // Away +0.5 (wins or draws)
        }

        // Return all 4 prices — the frontend will pick the correct one after RS tells us
        // which team is at -0.5 and which is at +0.5 for each game.
        if (debugMode === '2') {
          const allSels = (d.selections || []).map(s => ({ label: s.label, outcomeType: s.outcomeType, points: s.points, odds: s.displayOdds && s.displayOdds.american }));
          gamesMap[gameKey] = { home: ev.home, away: ev.away, hm: homeMinus, hp: homePlus, awm: awayMinus, awp: awayPlus, allSels };
          continue;
        }

        if (homeMinus == null && homePlus == null && awayMinus == null && awayPlus == null) continue;

        gamesMap[gameKey] = {
          id: parseInt(ev.eventId),
          away: ev.away,
          home: ev.home,
          cm: ev.openDate,
          league: ev.league,
          hm: homeMinus,  // home -0.5 price
          hp: homePlus,   // home +0.5 price
          awm: awayMinus, // away -0.5 price
          awp: awayPlus   // away +0.5 price
        };

      } catch(e) {}

      if (i < todayEvents.length - 1) await new Promise(r => setTimeout(r, 100));
    }

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
