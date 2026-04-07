// functions/api/fd/rfi.js
// Fetches YRFI/NRFI odds from FanDuel's native API
// Step 1: Get today's MLB event IDs from content-managed-page
// Step 2: Fetch each event-page to extract RFI market odds

const FD_AK = 'FhMFpcPWXMeyZxOx';
const FD_LIST_URL = `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=mlb&_ak=${FD_AK}&timezone=America/New_York`;
const FD_EVENT_URL = (id) => `https://sbapi.nj.sportsbook.fanduel.com/api/event-page?_ak=${FD_AK}&eventId=${id}&tab=all&timezone=America/New_York`;
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

function toAm(p) {
  if (p >= 0.5) return Math.round(-100 * p / (1 - p));
  return Math.round(100 * (1 - p) / p);
}

function novig(amA, amB) {
  const impA = amA < 0 ? (-amA) / (-amA + 100) : 100 / (amA + 100);
  const impB = amB < 0 ? (-amB) / (-amB + 100) : 100 / (amB + 100);
  const total = impA + impB;
  if (!total) return null;
  return { fa: impA / total, fb: impB / total };
}

// Parse team names from FD event name
// e.g. "Milwaukee Brewers (K Harrison) @ Kansas City Royals (K Bubic)"
// → { away: "Milwaukee Brewers", home: "Kansas City Royals" }
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
  const cacheKey = 'fd_rfi';

  // Try cache first
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
    const listRes = await fetch(FD_LIST_URL, { headers });
    if (!listRes.ok) return fail(listRes.status, 'FD list fetch failed');
    const listData = await listRes.json();

    const events = listData?.attachments?.events || {};
    const nowMs = Date.now();
    const todayEvents = Object.values(events).filter(e => {
      if (!e.openDate) return false;
      const t = new Date(e.openDate).getTime();
      // Include games starting within the next 36 hours
      return t >= nowMs - 3 * 60 * 60 * 1000 && t <= nowMs + 36 * 60 * 60 * 1000;
    });

    if (!todayEvents.length) {
      const body = JSON.stringify({ ok: true, rfi: {} });
      return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    }

    // Step 2: Fetch each event-page to get RFI odds (sequential with 150ms gaps)
    const rfiMap = {};
    for (let i = 0; i < todayEvents.length; i++) {
      const event = todayEvents[i];
      const teams = parseEventName(event.name);
      if (!teams) continue;

      try {
        const evRes = await fetch(FD_EVENT_URL(event.eventId), { headers });
        if (!evRes.ok) continue;
        const evData = await evRes.json();

        const markets = evData?.attachments?.markets || {};
        const rfiMarket = Object.values(markets).find(m => m.marketType === RFI_MARKET_TYPE);
        if (!rfiMarket) continue;

        const runners = rfiMarket.runners || [];
        const over  = runners.find(r => r.runnerName === 'Over');  // YRFI
        const under = runners.find(r => r.runnerName === 'Under'); // NRFI

        if (!over || !under) continue;
        if (over.runnerStatus !== 'ACTIVE' || under.runnerStatus !== 'ACTIVE') continue;

        const yesAm = over.winRunnerOdds?.americanDisplayOdds?.americanOddsInt;
        const noAm  = under.winRunnerOdds?.americanDisplayOdds?.americanOddsInt;
        if (yesAm == null || noAm == null) continue;

        const nv = novig(yesAm, noAm);
        if (!nv) continue;

        const gameKey = teams.away + ' @ ' + teams.home;
        rfiMap[gameKey] = {
          yesFair: nv.fa,
          noFair:  nv.fb,
          yesAm,
          noAm,
          volume: 0
        };
      } catch(e) {}

      if (i < todayEvents.length - 1) await new Promise(r => setTimeout(r, 150));
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
