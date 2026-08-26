// GET /api/parlays/avatar?uid={rs_user_id}
// Proxies RS CDN avatar images through CF edge cache.
// First hit: D1 lookup + RS CDN fetch. Subsequent hits: CF edge cache (1 year).
// avatarKey is content-addressed so the URL is effectively immutable.

export async function onRequestGet({ request, env }) {
  const uid = new URL(request.url).searchParams.get('uid');
  if (!uid || !/^[A-Za-z0-9]{4,20}$/.test(uid)) {
    return new Response('', { status: 400 });
  }

  const cache    = caches.default;
  const cacheKey = new Request(new URL(request.url).href);

  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const row = await env.DB.prepare(
    'SELECT rs_avatar_url FROM real_auth WHERE rs_user_id=?'
  ).bind(uid).first();

  if (!row?.rs_avatar_url) return new Response('', { status: 404 });

  let upstream;
  try {
    upstream = await fetch(row.rs_avatar_url, { signal: AbortSignal.timeout(5000) });
  } catch {
    return new Response('', { status: 502 });
  }
  if (!upstream.ok) return new Response('', { status: 404 });

  const resp = new Response(upstream.body, {
    headers: {
      'Content-Type':  upstream.headers.get('Content-Type') || 'image/webp',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });

  await cache.put(cacheKey, resp.clone());
  return resp;
}
