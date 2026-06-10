import { getSessionOrCron } from '../../_lib/auth.js';
import { hashidsEncode } from '../../_lib/hashids.js';
// functions/api/fd/wc-futures.js
// WC Winner futures: DK outright odds vs RS Yes% probability
// DK: leagueId=209533, subcat=4529 (World Cup Winner)
// RS: /home/soccer/futures or /home/soccer/specials

const DK_BASE = 'https://sportsbook-nash.draftkings.com/sites/US-SB/api/sportscontent';
const DK_FUTURES_URL = DK_BASE + '/controldata/home/leagueSubcategory/v1/markets?isBatchable=false&templateVars=209533%2C4529&marketsQuery=%24filter%3DclientMetadata%2FsubCategoryId%20eq%20%274529%27%20AND%20tags%2Fall%28t%3A%20t%20ne%20%27SportcastBetBuilder%27%29&include=Markets&entity=markets';
const RS_BASE   = 'https://web.realapp.com';
const CACHE_TTL = 30;

function parseAmerican(str) {
  if (!str) return null;
  // Replace unicode minus (U+2212) and strip non-numeric chars
  let s = String(str);
  s = s.split('\u2212').join('-');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ((c >= '0' && c <= '9') || c === '+' || c === '-') out += c;
  }
  const n = parseInt(out, 10);
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
      if (row && row.data) {
        const p = JSON.parse(row.data);
        if (p.token) { token = p.token; deviceUuid = p.deviceUuid || deviceUuid; }
      }
    } catch(e) {}
  }
  if (token) { _rsToken = token; _rsDevice = deviceUuid; _rsTokenAt = now; }
  return { token, deviceUuid };
}

function collapseSpaces(s) {
  let out = '', prev = false;
  for (let i = 0; i < s.length; i++) {
    const ws = s[i] === ' ' || s[i] === '\t';
    if (ws) { if (!prev) out += ' '; } else out += s[i];
    prev = ws;
  }
  return out.trim();
}

function normTeam(name) {
  if (!name) return '';
  let s = name.toLowerCase().trim();
  const prefixes = ['the ', 'fc ', 'cf ', 'sc ', 'rc ', 'ac ', 'afc ', 'bfc '];
  for (let i = 0; i < prefixes.length; i++) {
    if (s.startsWith(prefixes[i])) { s = s.slice(prefixes[i].length); break; }
  }
  return collapseSpaces(s);
}

function extractTeamFromLabel(label) {
  let s = label;
  const idx = s.toLowerCase().indexOf(' win');
  if (idx > 0) s = s.slice(0, idx);
  const idx2 = s.toLowerCase().indexOf(' to ');
  if (idx2 > 0) s = s.slice(0, idx2);
  const wIdx = s.toLowerCase().indexOf('will ');
  if (wIdx >= 0) s = s.slice(wIdx + 5);
  return s.trim();
}

function extractRSFutures(data) {
  const teams = {};

  function tryMarkets(markets) {
    if (!Array.isArray(markets)) return;
    for (let mi = 0; mi < markets.length; mi++) {
      const m = markets[mi];
      const labelLc = (m.label || m.name || m.title || '').toLowerCase();
      const isWCMkt = labelLc.indexOf('world cup') >= 0 || labelLc.indexOf(' wc') >= 0
        || labelLc.indexOf('winner') >= 0 || labelLc.indexOf('win the') >= 0
        || labelLc.indexOf('outright') >= 0;
      if (!isWCMkt) continue;

      const outcomes = m.outcomes || m.options || [];

      // Binary YES market -- find YES outcome
      for (let oi = 0; oi < outcomes.length; oi++) {
        const o = outcomes[oi];
        const oLabelLc = (o.label || o.key || '').toLowerCase();
        if (oLabelLc === 'yes' || oLabelLc === 'win') {
          const prob = o.probability != null ? o.probability : o.prob;
          if (prob != null) {
            const team = extractTeamFromLabel(m.label || m.name || '');
            if (team) teams[normTeam(team)] = { name: team, prob: parseFloat(prob) };
          }
        }
      }

      // Multi-outcome market -- each outcome is a team
      if (outcomes.length > 2) {
        for (let oi = 0; oi < outcomes.length; oi++) {
          const o = outcomes[oi];
          const prob = o.probability != null ? o.probability : o.prob;
          if (prob != null) {
            const team = o.label || o.name || '';
            if (team) teams[normTeam(team)] = { name: team, prob: parseFloat(prob) };
          }
        }
      }
    }
  }

  tryMarkets(data.markets);
  if (data.data) tryMarkets(data.data.markets);
  if (data.content) tryMarkets(data.content.markets);

  const predictions = data.predictions || (data.data && data.data.predictions) || [];
  if (Array.isArray(predictions)) {
    for (let pi = 0; pi < predictions.length; pi++) {
      const p = predictions[pi];
      tryMarkets(p.markets || []);
      if (p.market) {
        const outcomes = p.market.outcomes || [];
        for (let oi = 0; oi < outcomes.length; oi++) {
          const o = outcomes[oi];
          const prob = o.probability != null ? o.probability : null;
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
  try {
    return await _handler(context);
  } catch(e) {
    return new Response(JSON.stringify({ ok: false, caught: true, error: String(e), stack: e && e.stack ? String(e.stack) : null }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function _handler(context) {
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

  const [dkRes, rsFuturesRes, rsSpecialsRes] = await Promise.all([
    fetch(DK_FUTURES_URL, { headers: dkHeaders }).catch(function(e) { return { ok: false, _err: e.message }; }),
    rsHeaders ? fetch(RS_BASE + '/home/soccer/futures', { headers: rsHeaders }).catch(function(e) { return { ok: false, _err: e.message }; }) : Promise.resolve(null),
    rsHeaders ? fetch(RS_BASE + '/home/soccer/specials', { headers: rsHeaders }).catch(function(e) { return { ok: false, _err: e.message }; }) : Promise.resolve(null),
  ]);

  let dkRaw = null;
  const dkStatus = dkRes.ok ? 200 : (dkRes.status || 0);
  try { if (dkRes.ok) dkRaw = await dkRes.json(); } catch(e) {}

  let rsFuturesRaw = null, rsSpecialsRaw = null;
  let rsFuturesStatus = 0, rsSpecialsStatus = 0;
  try {
    if (rsFuturesRes && rsFuturesRes.ok) { rsFuturesRaw = await rsFuturesRes.json(); rsFuturesStatus = 200; }
    else if (rsFuturesRes) { rsFuturesStatus = rsFuturesRes.status || 0; }
  } catch(e) {}
  try {
    if (rsSpecialsRes && rsSpecialsRes.ok) { rsSpecialsRaw = await rsSpecialsRes.json(); rsSpecialsStatus = 200; }
    else if (rsSpecialsRes) { rsSpecialsStatus = rsSpecialsRes.status || 0; }
  } catch(e) {}

  if (debugMode === '1') {
    return new Response(JSON.stringify({
      dkStatus, dkKeys: dkRaw ? Object.keys(dkRaw) : null,
      rsFuturesStatus, rsFuturesKeys: rsFuturesRaw ? Object.keys(rsFuturesRaw) : null,
      rsSpecialsStatus, rsSpecialsKeys: rsSpecialsRaw ? Object.keys(rsSpecialsRaw) : null,
      rsToken: rsToken ? rsToken.slice(0, 20) + '...' : null,
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (debugMode === '2') {
    return new Response(JSON.stringify({ dk: dkRaw, rsFutures: rsFuturesRaw, rsSpecials: rsSpecialsRaw }),
      { headers: { 'Content-Type': 'application/json' } });
  }

  if (!dkRaw) return fail(502, 'DK fetch failed (status ' + dkStatus + ')');

  // Parse DK selections
  const dkTeams = {};
  const selections = dkRaw.selections || [];
  const markets    = dkRaw.markets    || [];

  const winnerMarket = markets.find(function(m) {
    const n = (m.name || m.marketName || '').toLowerCase();
    return n.indexOf('winner') >= 0 || n.indexOf('outright') >= 0 || n.indexOf('to win') >= 0;
  }) || markets[0];

  for (let si = 0; si < selections.length; si++) {
    const sel = selections[si];
    const marketId = sel.marketId || sel.providerMarketId;
    if (winnerMarket && marketId && markets.length > 1) {
      const wmId = winnerMarket.marketId || winnerMarket.providerMarketId || winnerMarket.id;
      if (marketId !== wmId) continue;
    }
    const label = sel.label || sel.participantName || sel.displayName || '';
    const odds  = (sel.displayOdds && sel.displayOdds.american) || (sel.trueOdds && sel.trueOdds.american) || null;
    const am    = parseAmerican(odds);
    if (label && am != null) dkTeams[normTeam(label)] = { name: label, am };
  }

  if (Object.keys(dkTeams).length === 0) {
    for (let mi = 0; mi < markets.length; mi++) {
      const m = markets[mi];
      const opts = m.outcomes || m.selections || [];
      for (let oi = 0; oi < opts.length; oi++) {
        const o = opts[oi];
        const label = o.label || o.participantName || '';
        const odds  = (o.displayOdds && o.displayOdds.american) || (o.trueOdds && o.trueOdds.american) || o.oddsAmerican || null;
        const am    = parseAmerican(odds);
        if (label && am != null) dkTeams[normTeam(label)] = { name: label, am };
      }
    }
  }

  let rsTeams = {};
  if (rsFuturesRaw) rsTeams = extractRSFutures(rsFuturesRaw);
  if (Object.keys(rsTeams).length === 0 && rsSpecialsRaw) rsTeams = extractRSFutures(rsSpecialsRaw);

  if (debugMode === '3') {
    return new Response(JSON.stringify({ dkTeams, rsTeams, dkCount: Object.keys(dkTeams).length, rsCount: Object.keys(rsTeams).length }),
      { headers: { 'Content-Type': 'application/json' } });
  }

  const result = [];
  const hasRS  = Object.keys(rsTeams).length > 0;

  const dkEntries = Object.entries(dkTeams);
  for (let di = 0; di < dkEntries.length; di++) {
    const normName = dkEntries[di][0];
    const dk       = dkEntries[di][1];
    const rs = rsTeams[normName] || null;
    if (hasRS && !rs) continue;
    const dkFair = americanToProb(dk.am);
    const rsp    = rs ? rs.prob : null;
    result.push({
      team:   dk.name,
      rsName: rs ? rs.name : null,
      am:     dk.am,
      dkFair: dkFair != null ? Math.round(dkFair * 1000) / 1000 : null,
      rsp:    rsp    != null ? Math.round(rsp    * 1000) / 1000 : null,
      edge:   (rsp != null && dkFair != null) ? Math.round((rsp - dkFair) * 1000) / 1000 : null,
    });
  }

  result.sort(function(a, b) {
    const bv = b.rsp != null ? b.rsp : (b.dkFair != null ? b.dkFair : 0);
    const av = a.rsp != null ? a.rsp : (a.dkFair != null ? a.dkFair : 0);
    return bv - av;
  });

  const body = JSON.stringify({ ok: true, teams: result, hasRS, updatedAt: now });
  try {
    await env.DB.prepare(
      'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
    ).bind(cacheKey, body, now).run();
  } catch(e) {}

  return new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
