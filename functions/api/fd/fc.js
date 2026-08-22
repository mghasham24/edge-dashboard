import { getSessionOrCron } from '../../_lib/auth.js';
// functions/api/fd/fc.js
// EPL Asian Handicap odds via DK native, proxied through Hetzner VPS.
// DK native is Akamai-blocked from CF datacenter IPs — VPS at vps.raxedge.com:3003 bypasses this.
// VPS endpoint: GET /dk-soccer?league=40253&subcat=17968&key=VPS_DK_KEY
// Cache 5 minutes in D1.

const VPS_HOST   = 'http://vps.raxedge.com:3003';
const DK_LEAGUE  = '40253'; // EPL
const DK_SUBCAT  = '17968'; // Asian Handicap
const CACHE_TTL  = 300; // 5 minutes

const noGames = () => new Response(JSON.stringify({ ok: true, games: {} }), {
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSessionOrCron(request, env);
  if (!session) return fail(401, 'Not authenticated');
  if (session.plan !== 'pro' && !session.is_admin) return fail(403, 'Pro plan required');

  const reqUrl    = new URL(request.url);
  const debugMode = reqUrl.searchParams.get('debug');
  const freshMode = reqUrl.searchParams.get('fresh');

  const now      = Math.floor(Date.now() / 1000);
  const cacheKey = 'fd_fc';

  if (!debugMode && !freshMode) {
    try {
      const cached = await env.DB.prepare(
        'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
      ).bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < CACHE_TTL) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      }
    } catch(e) {}
  }

  const vpsKey = env.VPS_DK_KEY || 'rax-dk-9x3m7p2q';
  if (!vpsKey) return noGames();

  const vpsUrl = `${VPS_HOST}/dk-soccer?league=${DK_LEAGUE}&subcat=${DK_SUBCAT}&key=${encodeURIComponent(vpsKey)}`;

  let raw;
  try {
    const r = await fetch(vpsUrl, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) {
      if (debugMode === '1') {
        const body = await r.text().catch(() => '');
        return new Response(JSON.stringify({ vpsStatus: r.status, body }), { headers: { 'Content-Type': 'application/json' } });
      }
      return noGames();
    }
    raw = await r.json();
  } catch(e) {
    if (debugMode === '1') {
      return new Response(JSON.stringify({ error: e.message }), { headers: { 'Content-Type': 'application/json' } });
    }
    return noGames();
  }

  if (!raw || !raw.ok || !raw.games) return noGames();

  if (debugMode === '1') {
    const games = raw.games || {};
    return new Response(JSON.stringify({ count: Object.keys(games).length, games: Object.fromEntries(Object.entries(games).slice(0, 3)) }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (debugMode === '2') {
    return new Response(JSON.stringify(raw), { headers: { 'Content-Type': 'application/json' } });
  }

  const body = JSON.stringify({ ok: true, games: raw.games });
  try {
    await env.DB.prepare(
      'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
    ).bind(cacheKey, body, now).run();
  } catch(e) {}

  return new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
