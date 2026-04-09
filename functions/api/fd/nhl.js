// functions/api/fd/nhl.js
// Fetches FanDuel real-time NHL moneyline odds via FD's native API
// Step 1: Get today's NHL event IDs from content-managed-page
// Step 2: Fetch event-page per game to collect MONEY_LINE market IDs + runner names
// Step 3: Batch POST to getMarketPrices for real-time prices

const FD_AK         = 'FhMFpcPWXMeyZxOx';
// competitionId=42 is FD's NHL competition — filters out college hockey
const FD_LIST_URL   = `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=COMPETITION&competitionId=42&_ak=${FD_AK}&timezone=America/New_York`;
const FD_LIST_FALLBACK = `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=nhl&_ak=${FD_AK}&timezone=America/New_York`;
const FD_EVENT_URL  = (id) => `https://sbapi.nj.sportsbook.fanduel.com/api/event-page?_ak=${FD_AK}&eventId=${id}&tab=all&timezone=America/New_York`;
const FD_PRICES_URL = 'https://smp.nj.sportsbook.fanduel.com/api/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=0';
const ML_TYPE       = 'MONEY_LINE';
const CACHE_TTL     = 5;

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

function parseEventName(name) {
  const m = name.match(/^(.+?)\s*(?:\([^)]*\))?\s*@\s*(.+?)\s*(?:\([^)]*\))?\s*$/);
  if (!m) return null;
  return { away: m[1].trim(), home: m[2].trim() };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');

  const now = Math.floor(Date.now() / 1000);
  const cacheKey = 'fd_nhl';

  try {
    const cached = await env.DB.prepare(
      'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
    ).bind(cacheKey).first();
    if (cached && (now - cached.fetched_at) < CACHE_TTL) {
      return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
    }
  } catch(e) {}

  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
  };

  try {
    const nowMs = Date.now();
    let events = {};
    for (const url of [FD_LIST_URL, FD_LIST_FALLBACK]) {
      try {
        const listRes = await fetch(url, { headers });
        if (!listRes.ok) continue;
        const listData = await listRes.json();
        events = listData?.attachments?.events || {};
        if (Object.keys(events).length > 0) break;
      } catch(e) {}
    }

    // Filter to NHL-only: competitionId 42 or competitionName containing "NHL"
    // (the fallback page may contain college hockey — exclude by competition)
    const todayEvents = Object.values(events).filter(e => {
      if (!e.openDate) return false;
      const t = new Date(e.openDate).getTime();
      if (t < nowMs - 3 * 60 * 60 * 1000 || t > nowMs + 36 * 60 * 60 * 1000) return false;
      // If competitionId is present, only allow NHL (42)
      if (e.competitionId != null && e.competitionId !== 42) return false;
      // If competitionName is present, exclude non-NHL competitions
      if (e.competitionName && !e.competitionName.toLowerCase().includes('nhl')) return false;
      return true;
    });

    if (!todayEvents.length) {
      return new Response(JSON.stringify({ ok: true, games: {} }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Fetch event-pages to collect ML market IDs + runner names
    const gameData = {};

    for (let i = 0; i < todayEvents.length; i++) {
      const event = todayEvents[i];
      const teams = parseEventName(event.name);
      if (!teams) continue;

      try {
        const evRes = await fetch(FD_EVENT_URL(event.eventId), { headers });
        if (!evRes.ok) continue;
        const evData = await evRes.json();

        const markets = evData?.attachments?.markets || {};
        const gameKey = teams.away + ' @ ' + teams.home;
        const entry = { eventId: event.eventId, openDate: event.openDate, away: teams.away, home: teams.home, runnerNames: {} };

        Object.entries(markets).forEach(function([marketId, mkt]) {
          if (mkt.marketType !== ML_TYPE) return;
          entry.mlId = marketId;
          (mkt.runners || []).forEach(function(ref) {
            if (ref.selectionId != null && ref.runnerName) {
              entry.runnerNames[ref.selectionId] = ref.runnerName;
            }
          });
        });

        if (entry.mlId) gameData[gameKey] = entry;
      } catch(e) {}

      if (i < todayEvents.length - 1) await new Promise(r => setTimeout(r, 150));
    }

    // Batch all ML market IDs into one getMarketPrices request
    const allMarketIds = [];
    const marketToGame = {};

    Object.entries(gameData).forEach(function([gameKey, entry]) {
      allMarketIds.push(entry.mlId);
      marketToGame[entry.mlId] = gameKey;
    });

    if (!allMarketIds.length) {
      return new Response(JSON.stringify({ ok: true, games: {} }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

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
      if (!gamesMap[gameKey]) gamesMap[gameKey] = { id: entry.eventId, away: entry.away, home: entry.home, cm: entry.openDate, ml: {} };

      (mp.runnerDetails || []).forEach(function(rd) {
        if (rd.runnerStatus !== 'ACTIVE') return;
        const price = rd.winRunnerOdds?.americanDisplayOdds?.americanOddsInt;
        if (price == null) return;
        const name = entry.runnerNames[rd.selectionId] || entry.runnerNames[String(rd.selectionId)] || '';
        if (name) gamesMap[gameKey].ml[name] = price;
      });
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
