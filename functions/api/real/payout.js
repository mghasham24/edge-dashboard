// functions/api/real/payout.js
// GET /api/real/payout?marketId=X&outcomeId=Y&amount=Z
// Opens an RS Socket.IO WebSocket and returns the exact expected payout for a given stake.
// Result includes market slippage at that stake size.
// D1-cached per (marketId, outcomeId, amount) with 30s TTL.

import { getSessionOrCron } from '../../_lib/auth.js';

const CACHE_TTL = 30;

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSessionOrCron(request, env);
  if (!session) return fail(401, 'Not authenticated');

  const url = new URL(request.url);
  const marketId  = parseInt(url.searchParams.get('marketId'));
  const outcomeId = parseInt(url.searchParams.get('outcomeId'));
  const amount    = Math.min(Math.max(parseInt(url.searchParams.get('amount') || '700'), 1), 100000);

  if (!marketId || !outcomeId) return fail(400, 'Missing marketId or outcomeId');

  const cacheKey = `payout:${marketId}:${outcomeId}:${amount}`;
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

  // Get RS auth token from D1 (from TM bridge), fallback to CF env var
  let token = null;
  try {
    const row = await env.DB.prepare(
      "SELECT data FROM odds_cache WHERE cache_key='meta:rs_auth_token'"
    ).first();
    if (row) token = row.data;
  } catch(e) {}
  if (!token) token = env.RS_AUTH_TOKEN;
  if (!token) return fail(503, 'No RS auth token available');

  const params = new URLSearchParams({ auth: token, EIO: '3', transport: 'websocket' });
  const wsUrl  = `wss://web.realsports.io/socket.io/?${params}`;

  try {
    // CF Workers outbound WebSocket via fetch with Upgrade header
    const resp = await fetch(wsUrl, { headers: { Upgrade: 'websocket' } });
    const ws = resp.webSocket;
    if (!ws) return fail(502, 'WebSocket upgrade failed');
    ws.accept();

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

      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('WebSocket error'));
      });

      ws.addEventListener('close', (event) => {
        clearTimeout(timer);
        if (!connected) reject(new Error('WebSocket closed before connect'));
      });
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
