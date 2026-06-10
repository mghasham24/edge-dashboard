// functions/api/fd/wc-futures.js
// WC Winner futures: DK outright odds vs RS Yes%
// Zero imports — auth inlined to eliminate bundling as a variable.

const DK_BASE = 'https://sportsbook-nash.draftkings.com/sites/US-SB/api/sportscontent';
const DK_LEAGUE_ID = '209533'; // FIFA World Cup 2026
const DK_SUBCAT_ID = '4529';   // Outright Winner
const RS_BASE   = 'https://web.realapp.com';

function buildDKUrl() {
  const mq = encodeURIComponent(
    `$filter=clientMetadata/subCategoryId eq '${DK_SUBCAT_ID}' AND tags/all(t: t ne 'SportcastBetBuilder')`
  );
  // include=Events&entity=events is required even for futures — DK rejects include=Markets
  // templateVars is leagueId alone (not leagueId,subcatId)
  return `${DK_BASE}/controldata/league/leagueSubcategory/v1/markets?isBatchable=false&templateVars=${DK_LEAGUE_ID}&marketsQuery=${mq}&include=Events&entity=events`;
}

// Inlined from functions/_lib/hashids.js — required for real-request-token RS header
function hashidsEncode(number) {
  const saltChars = Array.from('realwebapp');
  const minLen = 16;
  const keepUnique = c => [...new Set(c)];
  const without = (c, x) => c.filter(ch => !x.includes(ch));
  const only = (c, k) => c.filter(ch => k.includes(ch));
  function shuffle(alpha, salt) {
    if (!salt.length) return alpha;
    let int, t = [...alpha];
    for (let i = t.length-1, v=0, p=0; i>0; i--, v++) {
      v %= salt.length; p += int = salt[v].codePointAt(0);
      const j = (int+v+p) % i; [t[i],t[j]] = [t[j],t[i]];
    }
    return t;
  }
  function toAlpha(n, alpha) {
    const id=[]; let v=n;
    do { id.unshift(alpha[v%alpha.length]); v=Math.floor(v/alpha.length); } while(v>0);
    return id;
  }
  let alpha = Array.from('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890');
  let seps  = Array.from('cfhistuCFHISTU');
  const uniq = keepUnique(alpha);
  alpha = without(uniq, seps);
  seps  = shuffle(only(seps, uniq), saltChars);
  if (!seps.length || alpha.length/seps.length > 3.5) {
    const sl = Math.ceil(alpha.length/3.5);
    if (sl > seps.length) { seps.push(...alpha.slice(0,sl-seps.length)); alpha=alpha.slice(sl-seps.length); }
  }
  alpha = shuffle(alpha, saltChars);
  const gc = Math.ceil(alpha.length/12);
  let guards;
  if (alpha.length < 3) { guards=seps.slice(0,gc); seps=seps.slice(gc); }
  else { guards=alpha.slice(0,gc); alpha=alpha.slice(gc); }
  const numId = number % 100;
  let ret = [alpha[numId % alpha.length]];
  const lottery = [...ret];
  alpha = shuffle(alpha, lottery.concat(saltChars, alpha));
  ret.push(...toAlpha(number, alpha));
  if (ret.length < minLen) ret.unshift(guards[(numId+ret[0].codePointAt(0)) % guards.length]);
  if (ret.length < minLen) ret.push(guards[(numId+ret[2].codePointAt(0)) % guards.length]);
  const half = Math.floor(alpha.length/2);
  while (ret.length < minLen) {
    alpha = shuffle(alpha, alpha);
    ret.unshift(...alpha.slice(half)); ret.push(...alpha.slice(0,half));
    const ex = ret.length-minLen;
    if (ex>0) ret=ret.slice(ex/2, ex/2+minLen);
  }
  return ret.join('');
}
const CACHE_TTL = 30;

function parseAmerican(str) {
  if (!str) return null;
  let s = String(str);
  // replace U+2212 minus sign
  let clean = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 8722) { clean += '-'; continue; }
    const c = s[i];
    if ((c >= '0' && c <= '9') || c === '+' || c === '-') clean += c;
  }
  const n = parseInt(clean, 10);
  return isFinite(n) ? n : null;
}

function americanToProb(am) {
  if (am == null) return null;
  if (am > 0) return 100 / (am + 100);
  return Math.abs(am) / (Math.abs(am) + 100);
}

// Inline session extraction — no import of session.js
function extractToken(request) {
  const cookie = request.headers.get('Cookie') || '';
  let start = 0;
  while (start < cookie.length) {
    let end = cookie.indexOf(';', start);
    if (end === -1) end = cookie.length;
    let part = cookie.slice(start, end).trim();
    const eq = part.indexOf('=');
    if (eq > 0) {
      const name = part.slice(0, eq).trim();
      if (name === 'session' || name === '__Host-session') {
        return part.slice(eq + 1).trim();
      }
    }
    start = end + 1;
  }
  return null;
}

async function getSession(db, token) {
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    'SELECT u.id as user_id, u.email, u.plan, u.is_admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(token, now).first();
}

async function getRSAuth(env) {
  let token = env.RS_AUTH_TOKEN || env.REAL_AUTH_TOKEN || '';
  let deviceUuid = env.REAL_DEVICE_UUID || '2e0a38e2-0ee8-4f93-9a34-218ac1d10161';
  if (!token) {
    try {
      const row = await env.DB.prepare("SELECT data FROM odds_cache WHERE cache_key='meta:rs_auth_token'").first();
      if (row && row.data) {
        const p = JSON.parse(row.data);
        if (p.token) { token = p.token; deviceUuid = p.deviceUuid || deviceUuid; }
      }
    } catch(e) {}
  }
  return { token, deviceUuid };
}

function buildRSHeaders(token, deviceUuid) {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': 'https://realsports.io',
    'Referer': 'https://realsports.io/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
    'real-auth-info': token,
    'real-device-type': 'desktop_web',
    'real-device-uuid': deviceUuid,
    'real-request-token': hashidsEncode(Date.now()),
    'real-version': '33',
  };
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
    if (s.indexOf(prefixes[i]) === 0) { s = s.slice(prefixes[i].length); break; }
  }
  return collapseSpaces(s);
}

function extractTeamFromLabel(label) {
  let s = label;
  const lc = s.toLowerCase();
  const winIdx = lc.indexOf(' win');
  if (winIdx > 0) s = s.slice(0, winIdx);
  const toIdx = s.toLowerCase().indexOf(' to ');
  if (toIdx > 0) s = s.slice(0, toIdx);
  const willIdx = s.toLowerCase().indexOf('will ');
  if (willIdx >= 0) s = s.slice(willIdx + 5);
  return s.trim();
}

function extractRSFutures(data) {
  const teams = {};

  function tryMarkets(markets) {
    if (!Array.isArray(markets)) return;
    for (let mi = 0; mi < markets.length; mi++) {
      const m = markets[mi];
      const labelLc = (m.label || m.name || m.title || '').toLowerCase();
      const isWC = labelLc.indexOf('world cup') >= 0 || labelLc.indexOf(' wc') >= 0
        || labelLc.indexOf('winner') >= 0 || labelLc.indexOf('win the') >= 0
        || labelLc.indexOf('outright') >= 0;
      if (!isWC) continue;
      const outcomes = m.outcomes || m.options || [];
      for (let oi = 0; oi < outcomes.length; oi++) {
        const o = outcomes[oi];
        const oLc = (o.label || o.key || '').toLowerCase();
        if (oLc === 'yes' || oLc === 'win') {
          const prob = o.probability != null ? o.probability : o.prob;
          if (prob != null) {
            const team = extractTeamFromLabel(m.label || m.name || '');
            if (team) teams[normTeam(team)] = { name: team, prob: parseFloat(prob) };
          }
        }
      }
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
  const preds = data.predictions || (data.data && data.data.predictions) || [];
  if (Array.isArray(preds)) {
    for (let pi = 0; pi < preds.length; pi++) {
      const p = preds[pi];
      tryMarkets(p.markets || []);
    }
  }
  return teams;
}

function fail(status, msg) {
  return new Response(JSON.stringify({ ok: false, error: msg }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const token   = extractToken(request);
    const session = await getSession(env.DB, token);
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

    // debug=5: probe multiple DK URL variants + RS endpoints to discover correct paths
    if (debugMode === '5') {
      const mq = encodeURIComponent(`$filter=clientMetadata/subCategoryId eq '${DK_SUBCAT_ID}' AND tags/all(t: t ne 'SportcastBetBuilder')`);
      const probe = async function(label, url, hdrs) {
        try {
          const r = await fetch(url, { headers: hdrs });
          const txt = await r.text();
          return { label, status: r.status, body: txt.slice(0, 300) };
        } catch(e) { return { label, status: 0, err: e.message }; }
      };
      const results = await Promise.all([
        probe('dk_league_info',    `${DK_BASE}/dkng/v1/leagues/${DK_LEAGUE_ID}`, dkHeaders),
        probe('dk_single_tv_markets', `${DK_BASE}/controldata/league/leagueSubcategory/v1/markets?isBatchable=false&templateVars=${DK_LEAGUE_ID}&marketsQuery=${mq}&include=Markets&entity=markets`, dkHeaders),
        probe('dk_single_tv_events',  `${DK_BASE}/controldata/league/leagueSubcategory/v1/markets?isBatchable=false&templateVars=${DK_LEAGUE_ID}&marketsQuery=${mq}&include=Events&entity=events`, dkHeaders),
        probe('rs_mktorder_grp_5_buy',   RS_BASE + '/predictions/marketorder/group/5/mode/buy', rsHeaders || {}),
        probe('rs_mktordergroup_5_buy',  RS_BASE + '/predictions/marketordergroup/5/mode/buy', rsHeaders || {}),
        probe('rs_soccer_futures_grp',   RS_BASE + '/predictions/soccer/futuresgroup/5/mode/buy', rsHeaders || {}),
        probe('rs_mktorder_5940_buy',    RS_BASE + '/predictions/marketorder/5940/mode/buy', rsHeaders || {}),
      ]);
      return new Response(JSON.stringify({ results }), { headers: { 'Content-Type': 'application/json' } });
    }

const DK_FUTURES_URL = buildDKUrl();

    // RS: scan sequential market IDs around 5940 for futuresGroupId=5
    // France = 5940; 48 WC teams span roughly 5880–5970
    const RS_FUTURES_GROUP = 5;
    const scanIds = [];
    for (let i = 5880; i <= 5970; i++) scanIds.push(i);

    async function fetchRSMarket(id) {
      try {
        const r = await fetch(RS_BASE + '/predictions/marketorder/' + id + '/mode/buy', { headers: rsHeaders });
        if (!r.ok) return null;
        const d = await r.json();
        const m = d && d.market;
        if (!m || m.futuresGroupId !== RS_FUTURES_GROUP) return null;
        const yes = m.outcomes && m.outcomes.find(function(o) { return o.key === 'Yes'; });
        if (!yes) return null;
        return { name: m.marketName || '', prob: yes.probability, marketId: id };
      } catch(e) { return null; }
    }

    const [dkRes, rsScanResults] = await Promise.all([
      fetch(DK_FUTURES_URL, { headers: dkHeaders }).catch(function(e) { return { ok: false, _err: e.message }; }),
      rsHeaders ? Promise.all(scanIds.map(fetchRSMarket)) : Promise.resolve([]),
    ]);

    let dkRaw = null, dkErrText = null, dkJsonErr = null;
    const dkStatus = dkRes.ok ? 200 : (dkRes.status || 0);
    try { if (dkRes.ok) dkRaw = await dkRes.json(); else dkErrText = (await dkRes.text()).slice(0, 200); }
    catch(e) { dkJsonErr = String(e); }

    if (debugMode === '1') {
      const rsFound = rsScanResults.filter(Boolean);
      // Also test single known market 5940 directly
      let mkt5940 = null;
      try {
        const r = await fetch(RS_BASE + '/predictions/marketorder/5940/mode/buy', { headers: rsHeaders });
        mkt5940 = { status: r.status, ok: r.ok };
        if (r.ok) { const d = await r.json(); mkt5940.name = d.market && d.market.marketName; mkt5940.group = d.market && d.market.futuresGroupId; }
      } catch(e) { mkt5940 = { err: String(e) }; }
      return new Response(JSON.stringify({
        dkStatus, dkKeys: dkRaw ? Object.keys(dkRaw) : null, dkJsonErr, dkErrText,
        rsFound: rsFound.length, rsSample: rsFound.slice(0, 3),
        mkt5940,
        rsToken: rsToken ? rsToken.slice(0, 20) + '...' : null,
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (debugMode === '2') {
      return new Response(JSON.stringify({ dk: dkRaw, rsScan: rsScanResults.filter(Boolean) }),
        { headers: { 'Content-Type': 'application/json' } });
    }

    if (debugMode === '4') {
      return new Response(JSON.stringify({ dkUrl: DK_FUTURES_URL, dkStatus, dkErrText }),
        { headers: { 'Content-Type': 'application/json' } });
    }

    if (debugMode === '6') {
      // Get full futuresgroup/5/mode/buy response to understand team structure
      let raw = null, status = 0;
      try {
        const r = await fetch(RS_BASE + '/predictions/futuresgroup/5/mode/buy', { headers: rsHeaders || {} });
        status = r.status;
        if (r.ok) raw = await r.json(); else raw = await r.text();
      } catch(e) { raw = String(e); }
      // Also try mktorder/5940 full response
      let mkt = null;
      try {
        const r = await fetch(RS_BASE + '/predictions/marketorder/5940/mode/buy', { headers: rsHeaders || {} });
        if (r.ok) { const d = await r.json(); mkt = { keys: Object.keys(d), market_keys: d.market ? Object.keys(d.market) : null, outcomes_count: d.market && d.market.outcomes ? d.market.outcomes.length : null, first_outcome: d.market && d.market.outcomes ? d.market.outcomes[0] : null, label: d.market && d.market.label, full: JSON.stringify(d).slice(0, 2000) }; }
      } catch(e) {}
      return new Response(JSON.stringify({ futuresgroup: { status, keys: raw && typeof raw === 'object' ? Object.keys(raw) : null, raw: typeof raw === 'string' ? raw.slice(0, 500) : JSON.stringify(raw).slice(0, 2000) }, mkt }),
        { headers: { 'Content-Type': 'application/json' } });
    }

    if (!dkRaw) return fail(502, 'DK fetch failed (status ' + dkStatus + ')');

    // Find the WC 2026 market (leagueId 209533) in the mixed-league response
    const markets = dkRaw.markets || [];
    const wcMarket = markets.find(function(m) { return String(m.leagueId) === DK_LEAGUE_ID; });
    if (!wcMarket) return fail(404, 'WC futures market not in DK response');
    const wcMarketId = String(wcMarket.id);

    // Filter WC selections only
    const wcSels = (dkRaw.selections || []).filter(function(s) { return String(s.marketId) === wcMarketId && s.trueOdds > 1; });

    // No-vig fair: sum of implied probs (1/decimal) then normalize
    let totalIp = 0;
    for (let i = 0; i < wcSels.length; i++) totalIp += 1 / wcSels[i].trueOdds;

    const dkTeams = {};
    for (let i = 0; i < wcSels.length; i++) {
      const sel = wcSels[i];
      const label = sel.label || '';
      if (!label) continue;
      const am     = parseAmerican(sel.displayOdds && sel.displayOdds.american);
      const dkFair = (1 / sel.trueOdds) / totalIp;
      dkTeams[normTeam(label)] = { name: label, am, dkFair };
    }

    const rsTeams = {};
    for (let i = 0; i < rsScanResults.length; i++) {
      const r = rsScanResults[i];
      if (!r || !r.name) continue;
      rsTeams[normTeam(r.name)] = { name: r.name, prob: r.prob };
    }

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
      const rsp = rs ? rs.prob : null;
      // edge = dkFair - rsYes: positive means DK fair > RS cost → RS underprices → bet YES at RS
      result.push({
        team:   dk.name,
        rsName: rs ? rs.name : null,
        am:     dk.am,
        dkFair: Math.round(dk.dkFair * 1000) / 1000,
        rsp:    rsp != null ? Math.round(rsp    * 1000) / 1000 : null,
        edge:   rsp != null ? Math.round((dk.dkFair - rsp) * 1000) / 1000 : null,
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

  } catch(topErr) {
    return new Response(JSON.stringify({ ok: false, caught: true, error: String(topErr), stack: topErr && topErr.stack ? String(topErr.stack).slice(0, 2000) : null }),
      { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
