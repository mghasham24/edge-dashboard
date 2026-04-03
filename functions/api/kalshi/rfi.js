// functions/api/kalshi/rfi.js
// Fetches KXMLBRFI markets from Kalshi public API and returns devigged fair values per game

const KALSHI_RFI_URL = 'https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXMLBRFI&limit=100';
const CACHE_TTL = 300; // 5 minutes

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

// Parse game teams from Kalshi market title e.g. "St. Louis vs Detroit First Inning Run?"
function parseTitle(title) {
  const m = title.match(/^(.+?) vs (.+?) First Inning Run\??$/i);
  if (!m) return null;
  return { away: m[1].trim(), home: m[2].trim() };
}

// Convert Kalshi cents midpoint to devigged fair probabilities
function devig(yesBid, yesAsk, noBid, noAsk) {
  const yesMid = (parseFloat(yesBid) + parseFloat(yesAsk)) / 2;
  const noMid  = (parseFloat(noBid)  + parseFloat(noAsk))  / 2;
  const total  = yesMid + noMid;
  if (!total) return null;
  return {
    yesFair: yesMid / total,
    noFair:  noMid  / total,
    yesMid,
    noMid,
    // Convert midpoint cents to approximate American odds
    yesAm: yesMid >= 50 ? Math.round(-100 * yesMid / (100 - yesMid)) : Math.round(100 * (100 - yesMid) / yesMid),
    noAm:  noMid  >= 50 ? Math.round(-100 * noMid  / (100 - noMid))  : Math.round(100 * (100 - noMid)  / noMid)
  };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');

  const now = Math.floor(Date.now() / 1000);
  const cacheKey = 'kalshi_rfi';

  // Try cache first
  try {
    const cached = await env.DB.prepare(
      'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
    ).bind(cacheKey).first();
    if (cached && (now - cached.fetched_at) < CACHE_TTL) {
      return new Response(cached.data, {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch(e) {}

  try {
    const res = await fetch(KALSHI_RFI_URL, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      }
    });

    if (!res.ok) {
      return fail(res.status, 'Kalshi fetch failed: ' + res.status);
    }

    const data = await res.json();
    const markets = data.markets || [];

    // Build map: "Away @ Home" -> fair values
    const rfiMap = {};
    for (const mkt of markets) {
      if (!mkt.title) continue;
      const teams = parseTitle(mkt.title);
      if (!teams) continue;

      const fair = devig(
        mkt.yes_bid_dollars, mkt.yes_ask_dollars,
        mkt.no_bid_dollars,  mkt.no_ask_dollars
      );
      if (!fair) continue;

      const gameKey = teams.away + ' @ ' + teams.home;
      rfiMap[gameKey] = {
        yesFair: fair.yesFair,
        noFair:  fair.noFair,
        yesMid:  fair.yesMid,
        noMid:   fair.noMid,
        yesAm:   fair.yesAm,
        noAm:    fair.noAm,
        ticker:  mkt.ticker,
        volume:  parseFloat(mkt.volume_fp) || 0
      };
    }

    const responseBody = JSON.stringify({ ok: true, rfi: rfiMap });

    // Write to cache
    try {
      await env.DB.prepare(
        'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
      ).bind(cacheKey, responseBody, now).run();
    } catch(e) {}

    return new Response(responseBody, {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch(e) {
    return fail(500, e.message);
  }
}
