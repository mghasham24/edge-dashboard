import { getSessionOrCron } from '../../_lib/auth.js';
import { hashidsEncode } from '../../_lib/hashids.js';
// functions/api/fd/wc-futures.js
// WC Winner futures: DK outright odds vs RS Yes% probability
// DK: leagueId=209533, subcat=4529 (World Cup Winner)
// RS: /home/soccer/futures or /home/soccer/specials

const DK_BASE    = 'https://sportsbook-nash.draftkings.com/sites/US-SB/api/sportscontent';
const DK_FUTURES_URL = `${DK_BASE}/controldata/home/leagueSubcategory/v1/markets?leagueId=209533&subcategoryId=4529`;
const RS_BASE    = 'https://web.realapp.com';
const CACHE_TTL  = 30; // 30s — futures don't change rapidly

function parseAmerican(str) {
  if (!str) return null;
  const s = String(str).replace(/−/g, '-').replace(/[^0-9+\-]/g, '');
  const n = parseInt(s, 10);
  return isFinite(n) ? n : null;
}

function americanToProb(am) {
  if (am == null) return null;
  if (am > 0) return 100 / (am + 100);
  return Math.abs(am) / (Math.abs(am) + 100);
}

function buildRSHeaders(token, deviceUuid) {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': 'https://realsports.io',
    'Referer': 'https://realsports.io/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-auth-info': token,
    'real-device-name': '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-device-type': 'desktop_web',
    'real-device-uuid': deviceUuid,
    'real-request-token': hashidsEncode(Date.now()),
    'real-version': '33',
  };
}

// Module-level RS auth cache
let _rsToken = '';
let _rsDevice = '2e0a38e2-0ee8-4f93-9a34-218ac1d10161';
let _rsTokenAt = 0;
const RS_TOKEN_TTL = 20;

async function getRSAuth(env) {
  const now = Math.floor(Date.now() / 1000);
  if (_rsToken && (now - _rsTokenAt) < RS_TOKEN_TTL) return { token: _rsToken, deviceUuid: _rsDevice };
  let token = env.RS_AUTH_TOKEN || env.REAL_AUTH_TOKEN || '';
  let deviceUuid = env.REAL_DEVICE_UUID || _rsDevice;
  if (!token) {
    try {
      const row = await env.DB.prepare("SELECT data FROM odds_cache WHERE cache_key='meta:rs_auth_token'").first();
      if (row?.data) {
        const p = JSON.parse(row.data);
        if (p.token) { token = p.token; deviceUuid = p.deviceUuid || deviceUuid; }
      }
    } catch(e) {}
  }
  if (token) { _rsToken = token; _rsDevice = deviceUuid; _rsTokenAt = now; }
  return { token, deviceUuid };
}

// Normalize team names to match between DK and RS
function normTeam(name) {
  return (name || '')
    .toLowerCase()
    .replace(/^(the |fc |cf |sc |rc |ac |afc |bfc )/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Try to extract RS futures markets from a response body
function extractRSFutures(data) {
  // Handle /home/soccer/futures or similar — look for binary Yes/No markets
  const teams = {};

  function tryMarkets(markets) {
    if (!Array.isArray(markets)) return;
    for (const m of markets) {
      // Market label might be "Will France win the World Cup?" or "France to win"
      const label = (m.label || m.name || m.title || '').toLowerCase();
      if (!label.includes('world cup') && !label.includes('wc') && !label.includes('winner') && !label.includes('win the') && !label.includes('outright')) continue;
      const outcomes = m.outcomes || m.options || [];
      // Find the YES outcome probability
      for (const o of outcomes) {
        const oLabel = (o.label || o.key || '').toLowerCase();
        if (oLabel === 'yes' || oLabel === 'win') {
          const prob = o.probability ?? o.prob ?? null;
          if (prob != null) {
            // Extract team name from market label
            let team = (m.label || m.name || '')
              .replace(/will\s+/i, '')
              .replace(/\s+win\s+the\s+world\s+cup.*$/i, '')
              .replace(/\s+to\s+win.*$/i, '')
              .replace(/\s+outright.*$/i, '')
              .trim();
            if (team) teams[normTeam(team)] = { name: team, prob: parseFloat(prob) };
          }
        }
      }
      // Also handle if each outcome IS a team (multi-outcome market)
      if (outcomes.length > 2) {
        for (const o of outcomes) {
          const prob = o.probability ?? o.prob ?? null;
          if (prob != null) {
            const team = o.label || o.name || '';
            if (team) teams[normTeam(team)] = { name: team, prob: parseFloat(prob) };
          }
        }
      }
    }
  }

  // Try various shapes of RS response
  tryMarkets(data.markets);
  tryMarkets(data.data?.markets);
  tryMarkets(data.content?.markets);

  // Also check predictions array
  const predictions = data.predictions || data.data?.predictions || [];
  if (Array.isArray(predictions)) {
    for (const p of predictions) {
      tryMarkets(p.markets || []);
      // Some RS responses embed markets in game objects
      if (p.market) {
        const outcomes = p.market.outcomes || [];
        for (const o of outcomes) {
          const prob = o.probability ?? null;
          const teamName = o.label || p.teamName || p.name || '';
          if (prob != null && teamName) {
            teams[normTeam(teamName)] = { name: teamName, prob: parseFloat(prob) };
          }
        }
      }
    }
  }

  return teams;
}

function fail(status, msg) {
  return new Response(JSON.stringify({ ok: false, error: msg }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSessionOrCron(request, env);
  if (!session) return fail(401, 'Not authenticated');
  if (session.plan !== 'pro' && !session.is_admin) return fail(403, 'Pro plan required');

  const url       = new URL(request.url);
  const debugMode = url.searchParams.get('debug');
  const now       = Math.floor(Date.now() / 1000);
  const cacheKey  = 'fd_wc_futures';

  if (!debugMode) {
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < CACHE_TTL) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      }
    } catch(e) {}
  }

  const dkHeaders = {
    'Accept': '*/*',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
    'Origin': 'https://sportsbook.draftkings.com',
    'Referer': 'https://sportsbook.draftkings.com/'
  };

  const { token: rsToken, deviceUuid: rsDevice } = await getRSAuth(env);
  const rsHeaders = rsToken ? buildRSHeaders(rsToken, rsDevice) : null;

  // Fetch DK futures + RS futures in parallel
  const [dkRes, rsFuturesRes, rsSpecialsRes] = await Promise.all([
    fetch(DK_FUTURES_URL, { headers: dkHeaders }).catch(e => ({ ok: false, _err: e.message })),
    rsHeaders ? fetch(`${RS_BASE}/home/soccer/futures`, { headers: rsHeaders }).catch(e => ({ ok: false, _err: e.message })) : Promise.resolve(null),
    rsHeaders ? fetch(`${RS_BASE}/home/soccer/specials`, { headers: rsHeaders }).catch(e => ({ ok: false, _err: e.message })) : Promise.resolve(null),
  ]);

  // Parse DK
  let dkRaw = null;
  let dkStatus = dkRes.ok ? 200 : (dkRes.status || 0);
  try { if (dkRes.ok) dkRaw = await dkRes.json(); } catch(e) {}

  // Parse RS candidates
  let rsFuturesRaw = null, rsSpecialsRaw = null;
  let rsFuturesStatus = 0, rsSpecialsStatus = 0;
  try { if (rsFuturesRes?.ok) { rsFuturesRaw = await rsFuturesRes.json(); rsFuturesStatus = 200; } else if (rsFuturesRes) { rsFuturesStatus = rsFuturesRes.status || 0; } } catch(e) {}
  try { if (rsSpecialsRes?.ok) { rsSpecialsRaw = await rsSpecialsRes.json(); rsSpecialsStatus = 200; } else if (rsSpecialsRes) { rsSpecialsStatus = rsSpecialsRes.status || 0; } } catch(e) {}

  if (debugMode === '1') {
    return new Response(JSON.stringify({
      dkStatus, dkKeys: dkRaw ? Object.keys(dkRaw) : null,
      rsFuturesStatus, rsFuturesKeys: rsFuturesRaw ? Object.keys(rsFuturesRaw) : null,
      rsSpecialsStatus, rsSpecialsKeys: rsSpecialsRaw ? Object.keys(rsSpecialsRaw) : null,
      rsToken: rsToken ? rsToken.slice(0, 20) + '...' : null,
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (debugMode === '2') {
    return new Response(JSON.stringify({
      dk: dkRaw,
      rsFutures: rsFuturesRaw,
      rsSpecials: rsSpecialsRaw,
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (!dkRaw) {
    return fail(502, `DK fetch failed (status ${dkStatus})`);
  }

  // Parse DK selections
  // DK leagueSubcategory response has markets[] + selections[] at top level
  const dkTeams = {};
  const selections = dkRaw.selections || [];
  const markets    = dkRaw.markets    || [];

  // Find the "World Cup Winner" market
  const winnerMarket = markets.find(m => {
    const n = (m.name || m.marketName || '').toLowerCase();
    return n.includes('winner') || n.includes('outright') || n.includes('to win');
  }) || markets[0];

  for (const sel of selections) {
    const marketId = sel.marketId || sel.providerMarketId;
    // Filter to winner market only (if we found it)
    if (winnerMarket && marketId && marketId !== (winnerMarket.marketId || winnerMarket.providerMarketId || winnerMarket.id)) {
      // Some DK responses have single market — skip filter if only 1 market
      if (markets.length > 1) continue;
    }
    const label = sel.label || sel.participantName || sel.displayName || '';
    const am    = parseAmerican(sel.displayOdds?.american || sel.trueOdds?.american);
    if (label && am != null) {
      dkTeams[normTeam(label)] = { name: label, am };
    }
  }

  // If no selections, try outcomes in markets
  if (!Object.keys(dkTeams).length) {
    for (const m of markets) {
      for (const o of (m.outcomes || m.selections || [])) {
        const label = o.label || o.participantName || '';
        const am    = parseAmerican(o.displayOdds?.american || o.trueOdds?.american || o.oddsAmerican);
        if (label && am != null) {
          dkTeams[normTeam(label)] = { name: label, am };
        }
      }
    }
  }

  // Parse RS teams from whichever endpoint worked
  let rsTeams = {};
  if (rsFuturesRaw) rsTeams = extractRSFutures(rsFuturesRaw);
  if (!Object.keys(rsTeams).length && rsSpecialsRaw) rsTeams = extractRSFutures(rsSpecialsRaw);

  if (debugMode === '3') {
    return new Response(JSON.stringify({ dkTeams, rsTeams, dkCount: Object.keys(dkTeams).length, rsCount: Object.keys(rsTeams).length }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Build result — only include teams present in BOTH DK and RS
  // (or all DK teams if RS returned nothing, with null RS prob)
  const result = [];
  const hasRS  = Object.keys(rsTeams).length > 0;

  for (const [normName, dk] of Object.entries(dkTeams)) {
    const rs = rsTeams[normName] || null;
    if (hasRS && !rs) continue; // only show teams in RS markets
    const dkFair  = americanToProb(dk.am);
    const rsp     = rs ? rs.prob : null;
    result.push({
      team:   dk.name,
      rsName: rs ? rs.name : null,
      am:     dk.am,
      dkFair: dkFair != null ? Math.round(dkFair * 1000) / 1000 : null,
      rsp:    rsp    != null ? Math.round(rsp    * 1000) / 1000 : null,
      edge:   (rsp != null && dkFair != null) ? Math.round((rsp - dkFair) * 1000) / 1000 : null,
    });
  }

  // Sort by RS prob descending (best RS markets first)
  result.sort((a, b) => (b.rsp ?? b.dkFair ?? 0) - (a.rsp ?? a.dkFair ?? 0));

  const body = JSON.stringify({ ok: true, teams: result, hasRS, updatedAt: now });
  try {
    await env.DB.prepare(
      'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
    ).bind(cacheKey, body, now).run();
  } catch(e) {}

  return new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
