import { getSessionOrCron } from '../../_lib/auth.js';
// functions/api/fd/wc.js
// Fetches DraftKings real-time FIFA World Cup Asian Handicap ±0.5 spread odds
// Subcat 13170 = 2-way AH (Home -0.5 / Away +0.5), same as FC tab — no draw
// Step 1: Get today's WC events from DK league endpoint
// Step 2: For each event, fetch subcat 13170 to get actual ±0.5 prices

const DK_BASE      = 'https://sportsbook-nash.draftkings.com/sites/US-SB/api/sportscontent';
// Try both subcats: 5430 = "To Win the Cup" (final), 5826 = "To Advance" (other KO rounds)
const DK_SUBCAT_IDS = ['5430', '5826'];
const CACHE_TTL    = 4; // 4s ensures 5s frontend poller always gets a fresh DK fetch

const DK_WC_LEAGUE_ID = '209533'; // FIFA World Cup 2026
const DK_NAV_URL = `${DK_BASE}/navigation/dkusnj/v2/nav/leagues/${DK_WC_LEAGUE_ID}`;

function dkEventSubcatUrl(eventId, subcatId) {
  const mq = encodeURIComponent(
    `$filter=eventId eq '${eventId}' AND clientMetadata/subCategoryId eq '${subcatId}' AND tags/all(t: t ne 'SportcastBetBuilder')`
  );
  return `${DK_BASE}/controldata/event/eventSubcategory/v1/markets?isBatchable=false&templateVars=${eventId}%2C${subcatId}&marketsQuery=${mq}&entity=markets`;
}

function parseAmerican(str) {
  if (!str) return null;
  const s = String(str).replace(/−/g, '-').replace(/[^0-9+\-]/g, '');
  const n = parseInt(s, 10);
  return isFinite(n) ? n : null;
}

function isToday_ET(dateStr) {
  if (!dateStr) return false;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  return fmt.format(new Date(dateStr)) === fmt.format(new Date());
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSessionOrCron(request, env);
  if (!session) return fail(401, 'Not authenticated');
  if (session.plan !== 'pro' && !session.is_admin) return fail(403, 'Pro plan required');

  const reqUrl    = new URL(request.url);
  const debugMode = reqUrl.searchParams.get('debug');
  const freshMode = reqUrl.searchParams.get('fresh');

  const now      = Math.floor(Date.now() / 1000);
  const cacheKey = 'fd_wc';

  if (!debugMode && !freshMode) {
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
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15',
    'Origin': 'https://sportsbook.draftkings.com',
    'Referer': 'https://sportsbook.draftkings.com/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors',
    'x-client-name': 'web',
    'x-client-version': '2626.3.1.8',
    'x-client-widget-name': 'cms',
    'x-client-widget-version': '2.15.4',
    'x-client-page': 'league',
    'x-client-feature': 'eventSubcategory',
  };

  const nowMs = Date.now();

  try {
    // Step 1: Discover today's WC events via the navigation endpoint
    const navRes = await fetch(DK_NAV_URL, { headers });

    if (debugMode === 'nav') {
      const raw = navRes.ok ? await navRes.json() : { error: navRes.status };
      return new Response(JSON.stringify(raw), { headers: { 'Content-Type': 'application/json' } });
    }

    if (!navRes.ok) return new Response(JSON.stringify({ ok: true, games: {} }), { headers: { 'Content-Type': 'application/json' } });

    const navData = await navRes.json();
    const todayEvents = [];
    for (const ev of navData.events || []) {
      if (!ev.id || !ev.startEventDate) continue;
      const evMs = new Date(ev.startEventDate).getTime();
      if (evMs < nowMs - 4 * 3600 * 1000 || evMs > nowMs + 36 * 3600 * 1000) continue;
      const parts = ev.participants || [];
      // Neutral-site games (WC final etc.) may have no venueRole — fall back to index order (DK: [away, home])
      const homeP = parts.find(p => p.venueRole === 'Home') || parts[1];
      const awayP = parts.find(p => p.venueRole === 'Away') || parts[0];
      if (!homeP || !awayP || homeP === awayP) continue;
      todayEvents.push({ eventId: String(ev.id), home: homeP.name, away: awayP.name, league: 'WC', openDate: ev.startEventDate });
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

    // Step 2: Fetch AH markets for all events in parallel
    let prevGames = {};
    try {
      const prev = await env.DB.prepare('SELECT data FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
      if (prev) prevGames = JSON.parse(prev.data).games || {};
    } catch(e) {}

    const gamesMap = {};

    await Promise.all(todayEvents.map(async (ev) => {
      const gameKey = ev.away + ' @ ' + ev.home;
      try {
        // Try each subcat in order; use the first one that returns odds
        // 5430 = "To Win the Cup" (final), 5826 = "To Advance" (other KO rounds)
        const ml = { Home: null, Away: null };
        for (const subcatId of DK_SUBCAT_IDS) {
          if (ml.Home != null || ml.Away != null) break;
          const sr = await fetch(dkEventSubcatUrl(ev.eventId, subcatId), { headers });
          if (!sr.ok) continue;
          const sd = await sr.json();
          for (const sel of sd.selections || []) {
            const ot    = sel.outcomeType;
            const price = parseAmerican(sel.displayOdds && sel.displayOdds.american);
            if (price == null || (ot !== 'Home' && ot !== 'Away')) continue;
            ml[ot] = price;
          }
        }

        if (debugMode === '2') {
          gamesMap[gameKey] = { home: ev.home, away: ev.away, home_ml: ml.Home, away_ml: ml.Away };
          return;
        }

        if (ml.Home == null && ml.Away == null) {
          // DK suspended — freeze last known odds
          const frozen = prevGames[gameKey] || null;
          if (frozen && (frozen.home_ml != null || frozen.away_ml != null)) {
            gamesMap[gameKey] = { ...frozen, id: parseInt(ev.eventId), away: ev.away, home: ev.home, cm: ev.openDate, live: true };
          }
          return;
        }

        gamesMap[gameKey] = {
          id: parseInt(ev.eventId),
          away: ev.away,
          home: ev.home,
          cm: ev.openDate,
          league: ev.league,
          home_ml: ml.Home,
          away_ml: ml.Away,
        };
      } catch(e) {}
    }));

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
