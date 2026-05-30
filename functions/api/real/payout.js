// functions/api/real/payout.js
// GET /api/real/payout?marketId=X&outcomeKey=SAS&rsGameId=Y&rsSport=nba&amount=Z
// Proxies to the VPS payout server (ev-group-poster:3002) which uses a residential
// proxy to reach the RS WebSocket. CF Workers can't WebSocket to web.realsports.io
// directly due to Cloudflare loopback restriction.
// D1-cached per (marketId, outcomeKey, amount) for 30s.

import { getSessionOrCron } from '../../_lib/auth.js';

const CACHE_TTL = 30;

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

  // VPS payout proxy — uses residential proxy to reach RS WebSocket
  const proxyKey  = env.EV_POSTER_KEY || env.PAYOUT_PROXY_KEY;
  const proxyHost = env.PAYOUT_PROXY_HOST || 'http://178.156.194.254:3002';
  if (!proxyKey) return fail(503, 'No payout proxy key configured');

  const proxyQs = new URLSearchParams({
    marketId: String(marketId),
    outcomeKey,
    rsGameId:  String(rsGameId),
    rsSport,
    amount:    String(amount),
    key:       proxyKey,
  });

  try {
    const proxyRes = await fetch(`${proxyHost}/payout?${proxyQs}`, {
      signal: AbortSignal.timeout(12000),
    });
    if (!proxyRes.ok) {
      const errBody = await proxyRes.text().catch(() => '');
      return fail(proxyRes.status, 'Proxy error: ' + errBody.slice(0, 200));
    }
    const data = await proxyRes.json();
    if (!data.ok || data.expectedPayout == null) return fail(502, 'No payout in proxy response');

    const body = JSON.stringify({ ok: true, expectedPayout: data.expectedPayout, marketId, amount });
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
