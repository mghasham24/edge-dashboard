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

  // UFC — FD native (free, real-time, updates during live fights)
  if (sport === 'mma_mixed_martial_arts') {
    return fetchUFCFromFD(env, url.searchParams.get('debug'));
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

// ── UFC native (FD) ───────────────────────────────────────────────────────────

async function fetchUFCFromFD(env, debugMode) {
  const FD_AK      = 'FhMFpcPWXMeyZxOx';
  const LIST_URL   = `https://api.sportsbook.fanduel.com/sbapi/content-managed-page?page=SPORT&eventTypeId=26420387&_ak=${FD_AK}&timezone=America%2FNew_York`;
  const PRICES_URL = 'https://smp.nj.sportsbook.fanduel.com/api/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=0';
  const CACHE_KEY  = 'fd_ufc_native';
  const CACHE_TTL  = 30;

  const now   = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();

  if (!debugMode) {
    try {
      const cached = await env.DB.prepare(
        'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
      ).bind(CACHE_KEY).first();
      if (cached && (now - cached.fetched_at) < CACHE_TTL) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
      }
    } catch(e) {}
  }

  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
    'Origin': 'https://sportsbook.fanduel.com',
    'Referer': 'https://sportsbook.fanduel.com/',
    'X-Sportsbook-Region': 'NJ',
  };

  // Try two URL variants in parallel — whichever returns 200 wins
  const LIST_URL_NJ = `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=SPORT&eventTypeId=26420387&_ak=${FD_AK}&timezone=America/New_York`;

  // Step 1: get UFC event list
  let events = [], listRaw = null;
  try {
    const [r1, r2] = await Promise.all([
      fetch(LIST_URL,    { headers, signal: AbortSignal.timeout(8000) }).catch(e => ({ ok: false, status: 0, _err: e.message })),
      fetch(LIST_URL_NJ, { headers, signal: AbortSignal.timeout(8000) }).catch(e => ({ ok: false, status: 0, _err: e.message })),
    ]);
    const r = (r1.ok) ? r1 : (r2.ok ? r2 : r1);
    listRaw = { status_api: r1.status || r1._err, status_nj: r2.status || r2._err, used: r1.ok ? 'api' : (r2.ok ? 'nj' : 'neither') };
    if (r.ok) {
      const d = await r.json();
      const all = Object.values(d?.attachments?.events || {});
      listRaw.total = all.length;
      events = all.filter(e => {
        if (!e.openDate) return false;
        const t = new Date(e.openDate).getTime();
        return t > nowMs - 6 * 60 * 60 * 1000 && t < nowMs + 48 * 60 * 60 * 1000;
      });
      listRaw.filtered = events.length;
    } else {
      listRaw.body1 = r1._err || (typeof r1.text === 'function' ? await r1.text().then(t => t.slice(0, 200)) : '');
      listRaw.body2 = r2._err || (typeof r2.text === 'function' ? await r2.text().then(t => t.slice(0, 200)) : '');
    }
  } catch(e) { listRaw = { error: e.message }; }

  if (debugMode === '1') {
    return new Response(JSON.stringify({ LIST_URL, LIST_URL_NJ, listRaw, events: events.map(e => ({ id: e.eventId, name: e.name, openDate: e.openDate })) }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!events.length) return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });

  // Step 2: fetch event-page per fight in parallel to collect moneyline market IDs
  const fightData = {};

  await Promise.all(events.map(async (event) => {
    const evUrl = `https://api.sportsbook.fanduel.com/sbapi/event-page?_ak=${FD_AK}&eventId=${event.eventId}&tab=all&timezone=America%2FNew_York`;
    try {
      const r = await fetch(evUrl, { headers, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return;
      const d = await r.json();
      const markets = d?.attachments?.markets || {};
      const entry = { name: event.name, openDate: event.openDate, mlId: null, mlRunners: {}, marketTypes: [] };

      Object.entries(markets).forEach(([marketId, mkt]) => {
        const mktType = mkt.marketType || '';
        if (!entry.marketTypes.includes(mktType)) entry.marketTypes.push(mktType);
        // FD may call the UFC ML market MONEY_LINE, MATCH_WINNER, or FIGHT_WINNER
        if (!entry.mlId && (mktType === 'MONEY_LINE' || mktType === 'MATCH_WINNER' || mktType === 'FIGHT_WINNER' || (mkt.marketName || '').toLowerCase().includes('winner'))) {
          entry.mlId = marketId;
          (mkt.runners || []).forEach(ref => {
            if (ref.selectionId != null && ref.runnerName) entry.mlRunners[ref.selectionId] = ref.runnerName;
          });
        }
      });

      if (entry.mlId) fightData[event.eventId] = entry;
    } catch(e) {}
  }));

  if (debugMode === '2') {
    return new Response(JSON.stringify({
      fightCount: Object.keys(fightData).length,
      fights: Object.entries(fightData).map(([id, e]) => ({ id, name: e.name, mlId: e.mlId, marketTypes: e.marketTypes, runners: e.mlRunners }))
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  const allMarketIds = Object.values(fightData).map(e => e.mlId).filter(Boolean);
  if (!allMarketIds.length) return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });

  // Step 3: batch getMarketPrices for real-time odds
  let marketPricesList = [];
  try {
    const pr = await fetch(PRICES_URL, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketIds: allMarketIds }),
    });
    if (pr.ok) {
      const raw = await pr.json();
      marketPricesList = Array.isArray(raw) ? raw : (raw.marketPrices || []);
    }
  } catch(e) {}

  const marketToEvent = {};
  Object.entries(fightData).forEach(([eventId, e]) => { if (e.mlId) marketToEvent[e.mlId] = eventId; });

  // Build Odds API-compatible output
  const gamesMap = {};
  marketPricesList.forEach(mp => {
    const eventId = marketToEvent[mp.marketId];
    if (!eventId || !fightData[eventId] || mp.marketStatus !== 'OPEN') return;
    const entry = fightData[eventId];
    const outcomes = (mp.runnerDetails || [])
      .filter(rd => rd.runnerStatus === 'ACTIVE' && rd.winRunnerOdds?.americanDisplayOdds?.americanOddsInt != null)
      .map(rd => ({
        name:  entry.mlRunners[rd.selectionId] || entry.mlRunners[String(rd.selectionId)] || '',
        price: rd.winRunnerOdds.americanDisplayOdds.americanOddsInt,
      }))
      .filter(o => o.name);
    if (outcomes.length >= 2) gamesMap[eventId] = { outcomes, name: entry.name, openDate: entry.openDate };
  });

  const result = Object.entries(gamesMap).map(([eventId, g]) => {
    // FD event names: "Fighter A @ Fighter B" or "Fighter A vs Fighter B"
    const sep   = g.name.includes('@') ? '@' : 'vs';
    const parts = g.name.split(sep).map(s => s.trim());
    return {
      id:           String(eventId),
      sport_key:    'mma_mixed_martial_arts',
      sport_title:  'MMA',
      commence_time: g.openDate,
      home_team:    parts[1] || g.outcomes[0]?.name || '',
      away_team:    parts[0] || g.outcomes[1]?.name || '',
      bookmakers: [{
        key:         'fanduel',
        title:       'FanDuel',
        last_update: new Date().toISOString(),
        markets:     [{ key: 'h2h', last_update: new Date().toISOString(), outcomes: g.outcomes }],
      }],
    };
  });

  const text = JSON.stringify(result);
  try {
    await env.DB.prepare(
      'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
    ).bind(CACHE_KEY, text, now).run();
  } catch(e) {}

  return new Response(text, { headers: { 'Content-Type': 'application/json' } });
}
