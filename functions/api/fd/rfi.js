import { getSessionOrCron } from '../../_lib/auth.js';
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
  const cleaned = name.replace(/\s*\([^)]*\)/g, '').trim();
  const m = cleaned.match(/^(.+?)\s*@\s*(.+?)\s*$/);
  if (!m) return null;
  return { away: m[1].trim(), home: m[2].trim() };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSessionOrCron(request, env);
  if (!session) return fail(401, 'Not authenticated');

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
      // RFI is a pre-game market — exclude games that started more than 10 min ago
      return t >= nowMs - 10 * 60 * 1000 && t <= nowMs + 16 * 60 * 60 * 1000;
    });

    if (!todayEvents.length) {
      return new Response(JSON.stringify({ ok: true, rfi: {} }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Step 2: Fetch each event-page to collect RFI market ID + selection IDs.
    // Don't assign (Game N) suffixes yet — we only know if it's a real doubleheader
    // after seeing which events have OPEN markets in Step 3.
    const parsedToday = todayEvents.map(e => {
      const t = parseEventName(e.name);
      return t ? { event: e, away: t.away, home: t.home } : null;
    }).filter(Boolean);

    // rawCandidates: one entry per event that has an RFI market on FD
    const rawCandidates = []; // { baseKey, cm, marketId, overSelId, underSelId }

    for (let i = 0; i < parsedToday.length; i++) {
      const { event, away, home } = parsedToday[i];
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

        rawCandidates.push({
          baseKey:    away + ' @ ' + home,
          cm:         event.openDate ? Math.floor(new Date(event.openDate).getTime() / 1000) : 0,
          marketId,
          overSelId:  over.selectionId,
          underSelId: under.selectionId,
        });
      } catch(e) {}

      if (i < parsedToday.length - 1) await new Promise(r => setTimeout(r, 150));
    }

    if (!rawCandidates.length) {
      return new Response(JSON.stringify({ ok: true, rfi: {} }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Step 3: Batch getMarketPrices for real-time odds
    const allMarketIds = rawCandidates.map(d => d.marketId);
    const pricesRes = await fetch(FD_PRICES_URL, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketIds: allMarketIds })
    });
    if (!pricesRes.ok) return fail(pricesRes.status, 'getMarketPrices failed');
    const marketPricesList = await pricesRes.json();

    // Index prices by marketId — only keep OPEN markets
    const priceMap = {};
    (Array.isArray(marketPricesList) ? marketPricesList : []).forEach(mp => {
      if (mp.marketStatus === 'OPEN') priceMap[mp.marketId] = mp;
    });

    // Keep only candidates with an OPEN market, then group by base matchup.
    // (Game N) suffix is assigned HERE, after filtering — so a phantom cancelled-DH
    // event whose market is SUSPENDED gets excluded before we decide on suffixes.
    // Result: a single genuine game never gets a spurious "(Game 2)" label.
    const openCandidates = rawCandidates.filter(d => priceMap[d.marketId]);
    const byMatchup = {};
    openCandidates.forEach(d => {
      if (!byMatchup[d.baseKey]) byMatchup[d.baseKey] = [];
      byMatchup[d.baseKey].push(d);
    });

    const rfiMap = {};
    for (const [baseKey, group] of Object.entries(byMatchup)) {
      const isDH = group.length >= 2;
      if (isDH) group.sort((a, b) => (a.cm || 0) - (b.cm || 0)); // earliest = Game 1

      for (let i = 0; i < group.length; i++) {
        const d       = group[i];
        const gameKey = isDH ? baseKey + ' (Game ' + (i + 1) + ')' : baseKey;
        const mp      = priceMap[d.marketId];

        let yesAm = null, noAm = null;
        (mp.runnerDetails || []).forEach(rd => {
          if (rd.runnerStatus !== 'ACTIVE') return;
          const price = rd.winRunnerOdds?.americanDisplayOdds?.americanOddsInt;
          if (price == null) return;
          if (rd.selectionId === d.overSelId  || rd.selectionId === String(d.overSelId))  yesAm = price;
          if (rd.selectionId === d.underSelId || rd.selectionId === String(d.underSelId)) noAm  = price;
        });

        if (yesAm == null || noAm == null) continue;
        const nv = novig(yesAm, noAm);
        if (!nv) continue;
        rfiMap[gameKey] = { yesFair: nv.fa, noFair: nv.fb, yesAm, noAm, volume: 0, cm: d.cm || 0 };
      }
    }

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
