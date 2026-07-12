import { getSession } from '../_lib/session.js';
// functions/api/odds.js
export async function onRequest(context) {
  const { request, env } = context;

  const url        = new URL(request.url);
  const sport      = url.searchParams.get('sport')      || 'basketball_nba';
  const markets    = url.searchParams.get('markets')    || 'h2h';
  const bookmakers = url.searchParams.get('bookmakers') || 'fanduel,draftkings,betmgm,caesars';

  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');

  // UFC — DK native fetch (free, real-time). No Odds API credits consumed.
  if (sport === 'mma_mixed_martial_arts') {
    return fetchUFCNative(env);
  }

  const API_KEY = env.ODDS_API_KEY;
  if (!API_KEY) {
    return new Response(JSON.stringify({ error: 'Missing API key' }), { status: 500 });
  }

  // Strip spreads/totals for non-Pro users server-side — defeats client console bypass
  const allowedMarkets = session.plan === 'pro'
    ? markets
    : markets.split(',').filter(m => m !== 'spreads' && m !== 'totals').join(',') || 'h2h';

  const now = Math.floor(Date.now() / 1000);

  // Dynamic TTL based on game state:
  // - Error / non-array: 30s (don't cache bad data for long)
  // - No games today: 3600s (1 hour) — don't waste credits on empty sports
  // - All pregame: 300s (5 min)
  // - Any live game: 30s
  function getTTL(responseText) {
    try {
      const games = JSON.parse(responseText);
      if (!Array.isArray(games)) return 30; // error object — short TTL so it clears fast
      if (games.length === 0) return 3600;
      // If games exist but no bookmaker data yet (e.g. API reset), use short TTL
      const hasOdds = games.some(function(g) {
        return g.bookmakers && g.bookmakers.length > 0;
      });
      if (!hasOdds) return 30;
      const hasLive = games.some(function(g) {
        return g.commence_time && new Date(g.commence_time).getTime() / 1000 <= now;
      });
      return hasLive ? 30 : 300;
    } catch(e) {
      return 30;
    }
  }

  function isValidGamesArray(text) {
    try { return Array.isArray(JSON.parse(text)); } catch(e) { return false; }
  }

  const cacheKey = 'odds_' + sport + '_' + allowedMarkets;

  // Try cache first
  try {
    const cached = await env.DB.prepare(
      'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
    ).bind(cacheKey).first();
    if (cached && isValidGamesArray(cached.data)) {
      const ttl = getTTL(cached.data);
      if ((now - cached.fetched_at) < ttl) {
        // Return last-known requests-remaining so the admin UI never shows '--'
        let apiRemaining = '';
        try {
          const meta = await env.DB.prepare('SELECT data FROM odds_cache WHERE cache_key=?').bind('odds_api_remaining').first();
          if (meta) apiRemaining = meta.data;
        } catch(e) {}
        return new Response(cached.data, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'x-requests-remaining': apiRemaining }
        });
      }
    }
  } catch(e) {}

  // Cache miss — fetch from Odds API, with DraftKings fallback if FanDuel is empty
  async function fetchOdds(bookmakerList) {
    const apiUrl = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${API_KEY}&regions=us&markets=${allowedMarkets}&bookmakers=${bookmakerList}&oddsFormat=american`;
    const res = await fetch(apiUrl);
    const text = await res.text();
    return { res, text };
  }

  function hasBookmakerOdds(text) {
    try {
      const games = JSON.parse(text);
      return Array.isArray(games) && games.some(g => g.bookmakers && g.bookmakers.length > 0);
    } catch(e) { return false; }
  }

  try {
    // First try FanDuel
    let { res, text } = await fetchOdds('fanduel');

    // If FanDuel has no odds, fall back to DraftKings
    if (!hasBookmakerOdds(text)) {
      const fallback = await fetchOdds('draftkings');
      if (hasBookmakerOdds(fallback.text)) {
        res = fallback.res;
        text = fallback.text;
        // Normalize DraftKings key to fanduel so frontend works unchanged
        text = text.replace(/"key":"draftkings"/g, '"key":"fanduel"').replace(/"title":"DraftKings"/g, '"title":"FanDuel (DK)"');
      }
    }

    // Only cache valid game arrays — never cache error objects
    if (isValidGamesArray(text)) {
      const remaining = res.headers.get('x-requests-remaining') || '';
      try {
        await env.DB.prepare(
          'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
        ).bind(cacheKey, text, now).run();
        // Persist the requests-remaining count so cached responses can return it too
        if (remaining) {
          await env.DB.prepare(
            'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
          ).bind('odds_api_remaining', remaining, now).run();
        }
      } catch(e) {}
      return new Response(text, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'x-requests-remaining': remaining
        }
      });
    }

    // Odds API returned a non-array (error response) — parse and surface the message
    let errMsg = 'Odds API error';
    try {
      const parsed = JSON.parse(text);
      errMsg = parsed.message || parsed.error_code || parsed.detail || errMsg;
    } catch(e) { errMsg = text.slice(0, 120); }
    return new Response(JSON.stringify({ error: errMsg }), { status: 502 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 502 });
  }
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

// ── UFC native (DK) ───────────────────────────────────────────────────────────

function parseAmericanDK(str) {
  if (!str) return null;
  const s = String(str).replace(/−/g, '-').replace(/[^0-9+\-]/g, '');
  const n = parseInt(s, 10);
  return isFinite(n) ? n : null;
}

async function fetchUFCNative(env) {
  const DK_BASE   = 'https://sportsbook-nash.draftkings.com/sites/US-SB/api/sportscontent';
  const LEAGUE_ID = '9034';
  const SUBCAT    = '13025';
  const CACHE_KEY = 'dk_ufc_native';
  const CACHE_TTL = 60;

  const now = Math.floor(Date.now() / 1000);

  try {
    const cached = await env.DB.prepare(
      'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
    ).bind(CACHE_KEY).first();
    if (cached && (now - cached.fetched_at) < CACHE_TTL) {
      return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
    }
  } catch(e) {}

  const headers = {
    'Accept': '*/*',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
    'Origin': 'https://sportsbook.draftkings.com',
    'Referer': 'https://sportsbook.draftkings.com/',
    'x-client-name': 'web',
    'x-pe-ep': 'SB',
    'x-pe-cn': 'web',
    'x-pe-loc': 'US-TX',
  };

  // Step 1: get UFC event list from DK league 9034
  const evQ = encodeURIComponent(`$filter=leagueId eq '${LEAGUE_ID}'`);
  const mQ1 = encodeURIComponent(`$filter=clientMetadata/subCategoryId eq '${SUBCAT}' AND tags/all(t: t ne 'SportcastBetBuilder')`);
  const eventsUrl = `${DK_BASE}/controldata/league/leagueSubcategory/v1/markets?isBatchable=false&templateVars=${LEAGUE_ID}&eventsQuery=${evQ}&marketsQuery=${mQ1}&include=Events&entity=events`;

  let events = [];
  try {
    const r = await fetch(eventsUrl, { headers });
    if (r.ok) events = (await r.json()).events || [];
  } catch(e) {}

  if (!events.length) {
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Step 2: fetch moneyline for each event in parallel
  const games = await Promise.all(events.map(async (ev) => {
    const mQ2 = encodeURIComponent(
      `$filter=eventId eq '${ev.id}' AND clientMetadata/subCategoryId eq '${SUBCAT}' AND tags/all(t: t ne 'SportcastBetBuilder') and tags/any(t: t eq 'OSB')`
    );
    const marketsUrl = `${DK_BASE}/controldata/event/eventSubcategory/v1/markets?isBatchable=false&templateVars=${ev.id}&marketsQuery=${mQ2}&include=MarketSplits&entity=markets`;

    try {
      const r = await fetch(marketsUrl, { headers });
      if (!r.ok) return null;
      const d = await r.json();

      const mlMarket = (d.markets || []).find(m => m.name === 'Moneyline');
      if (!mlMarket) return null;

      const outcomes = (d.selections || [])
        .filter(s => s.marketId === mlMarket.id)
        .map(s => ({ name: s.label, price: parseAmericanDK(s.displayOdds && s.displayOdds.american) }))
        .filter(o => o.price != null);

      if (outcomes.length < 2) return null;

      const homeP = (ev.participants || []).find(p => p.venueRole === 'Home');
      const awayP = (ev.participants || []).find(p => p.venueRole === 'Away');

      return {
        id: ev.id,
        sport_key: 'mma_mixed_martial_arts',
        sport_title: 'MMA',
        commence_time: ev.startEventDate,
        home_team: homeP ? homeP.name : outcomes[0].name,
        away_team: awayP ? awayP.name : outcomes[1].name,
        bookmakers: [{
          key: 'fanduel',
          title: 'FanDuel',
          last_update: new Date().toISOString(),
          markets: [{ key: 'h2h', last_update: new Date().toISOString(), outcomes }],
        }],
      };
    } catch(e) { return null; }
  }));

  const result = games.filter(Boolean);
  const text   = JSON.stringify(result);

  try {
    await env.DB.prepare(
      'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
    ).bind(CACHE_KEY, text, now).run();
  } catch(e) {}

  return new Response(text, { headers: { 'Content-Type': 'application/json' } });
}
