// functions/api/real/payout.js
// GET /api/real/payout?marketId=X&outcomeKey=DET&rsGameId=Y&rsSport=mlb&amount=Z
// Resolves the numeric outcomeId from the RS game markets API, then opens a
// Socket.IO WebSocket to get the exact expectedPayout including slippage.
// D1-cached per (marketId, outcomeKey, amount) for 30s.

import { getSessionOrCron } from '../../_lib/auth.js';
import { hashidsEncode } from '../../_lib/hashids.js';

const CACHE_TTL = 30;
const RS_BASE   = 'https://web.realapp.com';

function buildRsHeaders(token, deviceUuid) {
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
    'real-version': '31',
  };
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

function normKey(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSessionOrCron(request, env);
  if (!session) return fail(401, 'Not authenticated');

  const url        = new URL(request.url);
  const marketId   = parseInt(url.searchParams.get('marketId'));
  const outcomeKey = (url.searchParams.get('outcomeKey') || '').trim();
  const rsGameId   = url.searchParams.get('rsGameId');
  const rsSport    = url.searchParams.get('rsSport');
  const amount     = Math.min(Math.max(parseInt(url.searchParams.get('amount') || '700'), 1), 100000);

  if (!marketId || !outcomeKey || !rsGameId || !rsSport) {
    return fail(400, 'Missing marketId, outcomeKey, rsGameId, or rsSport');
  }

  const cacheKey = `payout:${marketId}:${normKey(outcomeKey)}:${amount}`;
  const now = Math.floor(Date.now() / 1000);

  // D1 cache check
  try {
    const cached = await env.DB.prepare(
      'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
    ).bind(cacheKey).first();
    if (cached && (now - cached.fetched_at) < CACHE_TTL) {
      return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
    }
  } catch(e) {}

  // Get RS auth token
  let token = null;
  try {
    const row = await env.DB.prepare(
      "SELECT data FROM odds_cache WHERE cache_key='meta:rs_auth_token'"
    ).first();
    if (row) token = row.data;
  } catch(e) {}
  if (!token) token = env.RS_AUTH_TOKEN || env.REAL_AUTH_TOKEN;
  if (!token) return fail(503, 'No RS auth token available');
  token = token.trim();

  // Resolve numeric outcomeId from RS game markets API
  const deviceUuid = token.split('!')[1] || '';
  const rsHeaders  = buildRsHeaders(token, deviceUuid);

  let outcomeId = null;
  let debugInfo = {};
  try {
    const marketsRes = await fetch(
      `${RS_BASE}/predictions/game/${rsSport}/${rsGameId}/markets`,
      { headers: rsHeaders, signal: AbortSignal.timeout(6000) }
    );
    debugInfo.marketsStatus = marketsRes.status;
    if (marketsRes.ok) {
      const data = await marketsRes.json();
      const markets = data.markets || [];
      debugInfo.marketCount = markets.length;
      debugInfo.marketIds = markets.map(m => ({ id: m.id, label: m.label }));
      const mkt = markets.find(m => m.id === marketId);
      debugInfo.mktFound = !!mkt;
      if (mkt) {
        debugInfo.outcomes = (mkt.outcomes || []).map(o => ({ id: o.id, outcomeId: o.outcomeId, outcome_id: o.outcome_id, key: o.key, label: o.label }));
        const normTarget = normKey(outcomeKey);
        const outcome = (mkt.outcomes || []).find(o => {
          const normLabel = normKey(o.label).replace(/\d/g, '');
          const normOKey  = normKey(o.key).replace(/\d/g, '');
          return normLabel === normTarget || normOKey === normTarget
              || normTarget.includes(normLabel) || normLabel.includes(normTarget);
        });
        if (outcome) outcomeId = outcome.id;
      }
    } else {
      debugInfo.marketsBody = await marketsRes.text().catch(() => '');
    }
  } catch(e) { debugInfo.error = e.message; }

  if (!outcomeId) return new Response(JSON.stringify({ error: 'Could not resolve outcomeId for ' + outcomeKey, debug: debugInfo }), {
    status: 404, headers: { 'Content-Type': 'application/json' }
  });

  // Open RS Socket.IO WebSocket and get exact payout
  // CF Workers outbound WS: use new WebSocket(wss://) — NOT fetch()+accept()
  // accept() is server-side only; client connections use the standard browser WS API
  const params = new URLSearchParams({ auth: token, EIO: '3', transport: 'websocket' });
  const wsUrl  = `wss://web.realsports.io/socket.io/?${params}`;

  try {
    const ws = new WebSocket(wsUrl);

    const expectedPayout = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { ws.close(1001, 'timeout'); } catch(e) {}
        reject(new Error('timeout'));
      }, 7000);

      let connected = false;

      ws.addEventListener('message', (event) => {
        const data = typeof event.data === 'string' ? event.data : event.data.toString();
        if (!connected) {
          if (data.startsWith('0')) {
            connected = true;
            ws.send(`420["PredictionMarketGetExpectedPayout",{"marketId":${marketId},"outcomeId":${outcomeId},"sharesPct":null,"amount":${amount}}]`);
          }
          return;
        }
        if (data.startsWith('430')) {
          clearTimeout(timer);
          try { ws.close(1000, 'done'); } catch(e) {}
          try {
            const payload = JSON.parse(data.slice(2));
            const payout = payload[0]?.expectedPayout ?? null;
            if (payout == null) { reject(new Error('no expectedPayout in response')); return; }
            resolve(payout);
          } catch(e) { reject(e); }
        }
      });

      ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('WS error: ' + (e.message || ''))); });
      ws.addEventListener('close', (e) => { clearTimeout(timer); if (!connected) reject(new Error('WS closed before connect code=' + (e.code||'?'))); });
    });

    const body = JSON.stringify({ ok: true, expectedPayout, marketId, outcomeId, amount });
    try {
      await env.DB.prepare(
        'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
      ).bind(cacheKey, body, now).run();
    } catch(e) {}

    return new Response(body, { headers: { 'Content-Type': 'application/json' } });

  } catch(e) {
    return fail(502, e.message);
  }
}
