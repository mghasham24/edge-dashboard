// functions/api/fd/rfi.js
// Fetches YRFI/NRFI odds from FanDuel's native API
// Step 1: Get today's MLB event IDs from content-managed-page
// Step 2: Fetch each event-page to collect RFI market IDs + runner selection IDs
// Step 3: Batch POST to getMarketPrices for real-time prices (same as mlb.js)

const FD_AK = 'FhMFpcPWXMeyZxOx';
const FD_LIST_URLS = [
  `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=COMPETITION&competitionId=91&_ak=${FD_AK}&timezone=America/New_York`,
  `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=mlb-game-lines&_ak=${FD_AK}&timezone=America/New_York`,
  `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=mlb&_ak=${FD_AK}&timezone=America/New_York`
];
const FD_EVENT_URL = (id) => `https://sbapi.nj.sportsbook.fanduel.com/api/event-page?_ak=${FD_AK}&eventId=${id}&tab=all&timezone=America/New_York`;
const FD_PRICES_URL = 'https://smp.nj.sportsbook.fanduel.com/api/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=0';
const RFI_MARKET_TYPE = '***OVER/UNDER_0.5_RUNS_1ST_INNINGS';
const CACHE_TTL = 30;

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

function novig(amA, amB) {
  const impA = amA < 0 ? (-amA) / (-amA + 100) : 100 / (amA + 100);
  const impB = amB < 0 ? (-amB) / (-amB + 100) : 100 / (amB + 100);
  const total = impA + impB;
  if (!total) return null;
  return { fa: impA / total, fb: impB / total };
}

function parseEventName(name) {
  const m = name.match(/^(.+?)\s*(?:\([^)]*\))?\s*@\s*(.+?)\s*(?:\([^)]*\))?\s*$/);
  if (!m) return null;
  return { away: m[1].trim(), home: m[2].trim() };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const reqUrl0 = new URL(request.url);
  const cronKey = reqUrl0.searchParams.get('_cron_key');
  let session;
  if (cronKey && env.CRON_SECRET && cronKey === env.CRON_SECRET) {
    session = { user_id: 0, plan: 'pro' };
  } else {
    session = await getSession(request, env.DB);
    if (!session) return fail(401, 'Not authenticated');
  }

  const now = Math.floor(Date.now() / 1000);
  const cacheKey = 'fd_rfi';

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
    // Step 1: Get today's event IDs
    const nowMs = Date.now();
    const allEvents = {};
    for (const url of FD_LIST_URLS) {
      try {
        const listRes = await fetch(url, { headers });
        if (!listRes.ok) continue;
        const listData = await listRes.json();
        const evts = listData?.attachments?.events || {};
        Object.entries(evts).forEach(([id, e]) => { if (!allEvents[id]) allEvents[id] = e; });
      } catch(e) {}
    }

    const todayEvents = Object.values(allEvents).filter(e => {
      if (!e.openDate) return false;
      const t = new Date(e.openDate).getTime();
      return t >= nowMs - 5 * 60 * 60 * 1000 && t <= nowMs + 16 * 60 * 60 * 1000;
    });

    if (!todayEvents.length) {
      return new Response(JSON.stringify({ ok: true, rfi: {} }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Step 2: Fetch each event-page to collect RFI market ID + selection IDs
    const gameData = {}; // gameKey → { marketId, overSelId, underSelId }

    for (let i = 0; i < todayEvents.length; i++) {
      const event = todayEvents[i];
      const teams = parseEventName(event.name);
      if (!teams) continue;

      try {
        const evRes = await fetch(FD_EVENT_URL(event.eventId), { headers });
        if (!evRes.ok) continue;
        const evData = await evRes.json();

        const markets = evData?.attachments?.markets || {};
        const rfiEntry = Object.entries(markets).find(([, m]) => m.marketType === RFI_MARKET_TYPE);
        if (!rfiEntry) continue;

        const [marketId, rfiMarket] = rfiEntry;
        const runners = rfiMarket.runners || [];
        const over  = runners.find(r => r.runnerName === 'Over');
        const under = runners.find(r => r.runnerName === 'Under');
        if (!over || !under) continue;

        const gameKey = teams.away + ' @ ' + teams.home;
        gameData[gameKey] = {
          marketId,
          overSelId:  over.selectionId,
          underSelId: under.selectionId
        };
      } catch(e) {}

      if (i < todayEvents.length - 1) await new Promise(r => setTimeout(r, 150));
    }

    if (!Object.keys(gameData).length) {
      return new Response(JSON.stringify({ ok: true, rfi: {} }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Step 3: Batch getMarketPrices for real-time odds
    const allMarketIds = Object.values(gameData).map(d => d.marketId);
    const pricesRes = await fetch(FD_PRICES_URL, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketIds: allMarketIds })
    });
    if (!pricesRes.ok) return fail(pricesRes.status, 'getMarketPrices failed');
    const marketPricesList = await pricesRes.json();

    // Build reverse map: marketId → gameKey
    const marketToGame = {};
    Object.entries(gameData).forEach(([gameKey, d]) => { marketToGame[d.marketId] = gameKey; });

    const rfiMap = {};
    (Array.isArray(marketPricesList) ? marketPricesList : []).forEach(mp => {
      const gameKey = marketToGame[mp.marketId];
      if (!gameKey || mp.marketStatus !== 'OPEN') return;
      const d = gameData[gameKey];

      let yesAm = null, noAm = null;
      (mp.runnerDetails || []).forEach(rd => {
        if (rd.runnerStatus !== 'ACTIVE') return;
        const price = rd.winRunnerOdds?.americanDisplayOdds?.americanOddsInt;
        if (price == null) return;
        if (rd.selectionId === d.overSelId  || rd.selectionId === String(d.overSelId))  yesAm = price;
        if (rd.selectionId === d.underSelId || rd.selectionId === String(d.underSelId)) noAm  = price;
      });

      if (yesAm == null || noAm == null) return;
      const nv = novig(yesAm, noAm);
      if (!nv) return;
      rfiMap[gameKey] = { yesFair: nv.fa, noFair: nv.fb, yesAm, noAm, volume: 0 };
    });

    const body = JSON.stringify({ ok: true, rfi: rfiMap });
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
