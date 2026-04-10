// functions/api/fd/fc.js
// Fetches FanDuel real-time soccer spread odds for top 6 European leagues
// Step 1: SPORT page → attachments.events has both competition containers AND individual game events
//         Filter events by openDate (today ET) + target league competition ID
// Step 2: Fetch event-page per game event → get Asian handicap market ID + runner names
// Step 3: Batch POST getMarketPrices

const FD_AK = 'FhMFpcPWXMeyZxOx';
const FD_SPORT_URL = `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=SPORT&eventTypeId=1&_ak=${FD_AK}&timezone=America/New_York`;
const FD_EVENT_URL = (id) => `https://sbapi.nj.sportsbook.fanduel.com/api/event-page?_ak=${FD_AK}&eventId=${id}&tab=all&timezone=America/New_York`;
const FD_PRICES_URL = 'https://smp.nj.sportsbook.fanduel.com/api/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=0';
const CACHE_TTL = 30;

// FD soccer only has WIN-DRAW-WIN (3-way ML) for individual games — no Asian handicap
// Home win = Home -0.5 (same bet). Away win ≠ Away +0.5 (off by draw probability).
const TARGET_MKT = 'WIN-DRAW-WIN';
const DRAW_NAME = 'Draw';
const DRAW_ID = 58805;

// Exact competition names → league label
const EXACT_COMP_NAMES = {
  'premier league':          'EPL',
  'english premier league':  'EPL',
  'la liga':                 'La Liga',
  'spanish la liga':         'La Liga',
  'bundesliga':              'Bundesliga',
  'german bundesliga':       'Bundesliga',
  'serie a':                 'Serie A',
  'italian serie a':         'Serie A',
  'ligue 1':                 'Ligue 1',
  'french ligue 1':          'Ligue 1',
};

function getLeagueLabel(competitionName) {
  if (!competitionName) return null;
  const lower = competitionName.toLowerCase();
  if (EXACT_COMP_NAMES[lower]) return EXACT_COMP_NAMES[lower];
  if (lower.includes('champions league')) return 'UCL';
  return null;
}

function isToday_ET(dateStr) {
  if (!dateStr) return false;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  return fmt.format(new Date(dateStr)) === fmt.format(new Date());
}

function parseEventName(name) {
  // FD soccer: "Home v Away"
  let m = name.match(/^(.+?)\s+v\s+(.+?)\s*$/i);
  if (m) return { home: m[1].trim(), away: m[2].trim() };
  // US format: "Away @ Home"
  m = name.match(/^(.+?)\s*@\s*(.+?)\s*$/);
  if (m) return { away: m[1].trim(), home: m[2].trim() };
  return null;
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
  const cacheKey = 'fd_fc';

  if (!debugMode) {
    try {
      const cached = await env.DB.prepare(
        'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
      ).bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < CACHE_TTL) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
      }
    } catch(e) {}
  }

  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
  };

  try {
    const nowMs = Date.now();

    const sportRes = await fetch(FD_SPORT_URL, { headers });
    if (!sportRes.ok) return fail(sportRes.status, 'FD soccer sport fetch failed');
    const sportData = await sportRes.json();

    const allEvents = sportData?.attachments?.events || {};
    const competitions = sportData?.attachments?.competitions || {};

    // Build competitionId → league label
    const compLeagueMap = {};
    Object.values(competitions).forEach(function(c) {
      const label = getLeagueLabel(c.name);
      if (label) compLeagueMap[c.competitionId] = label;
    });

    // debug=1: show ALL today's individual game events (not competition containers)
    // Game events have names like "Team A v Team B", containers have league names
    if (debugMode === '1') {
      const todayGameEvents = Object.values(allEvents).filter(e => {
        if (!e.openDate) return false;
        const league = compLeagueMap[e.competitionId];
        if (!league) return false;
        if (!isToday_ET(e.openDate)) return false;
        const t = new Date(e.openDate).getTime();
        if (t < nowMs - 4 * 60 * 60 * 1000) return false;
        const teams = parseEventName(e.name);
        return !!teams; // only events with parseable team matchup names
      });

      const allLeagueEvents = Object.values(allEvents).filter(e => compLeagueMap[e.competitionId]);

      return new Response(JSON.stringify({
        totalEvents: Object.keys(allEvents).length,
        targetLeagueEventsTotal: allLeagueEvents.length,
        todayGameEventsFound: todayGameEvents.length,
        todayEvents: todayGameEvents.map(e => ({
          eventId: e.eventId,
          name: e.name,
          openDate: e.openDate,
          competitionId: e.competitionId,
          league: compLeagueMap[e.competitionId],
          parsed: parseEventName(e.name)
        })),
        // Sample of all events in target leagues (to see the range)
        allLeagueSample: allLeagueEvents.slice(0, 10).map(e => ({ eventId: e.eventId, name: e.name, openDate: e.openDate, league: compLeagueMap[e.competitionId] }))
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // debug=2: fetch event-page for one today game event and show all market types
    if (debugMode === '2') {
      const todayGameEvents = Object.values(allEvents).filter(e => {
        if (!e.openDate || !compLeagueMap[e.competitionId] || !isToday_ET(e.openDate)) return false;
        const t = new Date(e.openDate).getTime();
        if (t < nowMs - 4 * 60 * 60 * 1000) return false;
        return !!parseEventName(e.name);
      });

      if (!todayGameEvents.length) {
        return new Response(JSON.stringify({ error: 'No today game events found' }), { headers: { 'Content-Type': 'application/json' } });
      }

      const testEvent = todayGameEvents[0];
      const evRes = await fetch(FD_EVENT_URL(testEvent.eventId), { headers });
      const evData = evRes.ok ? await evRes.json() : null;
      const evMarkets = evData?.attachments?.markets || {};
      const mktTypes = [...new Set(Object.values(evMarkets).map(m => m.marketType))].sort();
      const spreadSample = Object.values(evMarkets)
        .filter(m => m.marketType === TARGET_MKT)
        .map(m => ({ marketId: m.marketId, marketType: m.marketType, marketName: m.marketName, runners: (m.runners||[]).map(r => ({ name: r.runnerName, handicap: r.handicap, selectionId: r.selectionId })) }));

      return new Response(JSON.stringify({
        testEventId: testEvent.eventId,
        testEventName: testEvent.name,
        league: compLeagueMap[testEvent.competitionId],
        evPageStatus: evRes.status,
        totalMarketsInEventPage: Object.keys(evMarkets).length,
        allMarketTypes: mktTypes,
        spreadMarkets: spreadSample,
        // Also show all market types with sample runner names
        allMarketsSample: Object.values(evMarkets).slice(0, 8).map(m => ({ marketType: m.marketType, marketName: m.marketName, runners: (m.runners||[]).slice(0,2).map(r => ({ name: r.runnerName, handicap: r.handicap })) }))
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Step 1: Find today's individual game events in target leagues
    const todayGameEvents = Object.values(allEvents).filter(function(e) {
      if (!e.openDate || !compLeagueMap[e.competitionId]) return false;
      if (!isToday_ET(e.openDate)) return false;
      const t = new Date(e.openDate).getTime();
      if (t < nowMs - 4 * 60 * 60 * 1000) return false;
      return !!parseEventName(e.name);
    });

    if (!todayGameEvents.length) {
      return new Response(JSON.stringify({ ok: true, games: {} }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Step 2: Fetch event-pages to find spread markets
    const gameData = {};

    for (let i = 0; i < todayGameEvents.length; i++) {
      const event = todayGameEvents[i];
      const teams = parseEventName(event.name);
      if (!teams) continue;

      try {
        const evRes = await fetch(FD_EVENT_URL(event.eventId), { headers });
        if (!evRes.ok) continue;
        const evData = await evRes.json();
        const markets = evData?.attachments?.markets || {};

        const gameKey = teams.away + ' @ ' + teams.home;
        const entry = {
          eventId: event.eventId,
          openDate: event.openDate,
          away: teams.away,
          home: teams.home,
          league: compLeagueMap[event.competitionId],
          runnerNames: {}
        };

        // Find WIN-DRAW-WIN market (only individual game ML FD offers for soccer)
        const wdwEntry = Object.entries(markets).find(([, m]) => m.marketType === TARGET_MKT);
        if (wdwEntry) {
          entry.mlId = wdwEntry[0];
          (wdwEntry[1].runners || []).forEach(function(r) {
            if (r.selectionId != null && r.runnerName) {
              entry.runnerNames[r.selectionId] = r.runnerName;
              entry.runnerNames[String(r.selectionId)] = r.runnerName;
            }
          });
          gameData[gameKey] = entry;
        }
      } catch(e) {}

      if (i < todayGameEvents.length - 1) await new Promise(r => setTimeout(r, 120));
    }

    if (!Object.keys(gameData).length) {
      return new Response(JSON.stringify({ ok: true, games: {} }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Step 3: Batch getMarketPrices
    const allMarketIds = [];
    const marketToGame = {};
    Object.entries(gameData).forEach(function([gameKey, entry]) {
      allMarketIds.push(entry.mlId);
      marketToGame[entry.mlId] = gameKey;
    });

    const pricesRes = await fetch(FD_PRICES_URL, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketIds: allMarketIds })
    });

    if (!pricesRes.ok) return fail(pricesRes.status, 'getMarketPrices failed');
    const marketPricesList = await pricesRes.json();

    const gamesMap = {};

    (Array.isArray(marketPricesList) ? marketPricesList : []).forEach(function(mp) {
      const gameKey = marketToGame[mp.marketId];
      if (!gameKey || mp.marketStatus !== 'OPEN') return;
      const entry = gameData[gameKey];
      if (!gamesMap[gameKey]) {
        gamesMap[gameKey] = {
          id: entry.eventId,
          away: entry.away,
          home: entry.home,
          cm: entry.openDate,
          league: entry.league,
          ml: {}
        };
      }

      // Collect all 3 prices (home win, draw, away win)
      const raw3 = {};
      (mp.runnerDetails || []).forEach(function(rd) {
        if (rd.runnerStatus !== 'ACTIVE') return;
        const price = rd.winRunnerOdds?.americanDisplayOdds?.americanOddsInt;
        if (price == null) return;
        const name = entry.runnerNames[rd.selectionId] || entry.runnerNames[String(rd.selectionId)] || '';
        if (!name) return;
        raw3[name] = price;
      });

      // Derive Away +0.5 from 3-way novig:
      //   Home -0.5  = Home Win (exact same bet, use directly)
      //   Away +0.5  = Draw OR Away Win = P(draw_novig) + P(away_novig)
      const homePr = raw3[entry.home];
      const awayPr = raw3[entry.away];
      const drawPr = raw3[DRAW_NAME];
      if (homePr != null && awayPr != null && drawPr != null) {
        function toImpl(am) { return am < 0 ? (-am) / (-am + 100) : 100 / (am + 100); }
        var pH = toImpl(homePr), pD = toImpl(drawPr), pA = toImpl(awayPr);
        var tot = pH + pD + pA;
        var pAwayPlus = (pD + pA) / tot; // novig P(away+0.5)
        var awayPlus05Am = pAwayPlus >= 0.5
          ? Math.round(-(pAwayPlus / (1 - pAwayPlus)) * 100)
          : Math.round(((1 - pAwayPlus) / pAwayPlus) * 100);
        gamesMap[gameKey].ml[entry.home] = homePr;
        gamesMap[gameKey].ml[entry.away] = awayPlus05Am;
      } else if (homePr != null) {
        gamesMap[gameKey].ml[entry.home] = homePr;
      }
    });

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
