// GET /api/headshot?id={mlbId}
// Proxies MLB player headshots from content.mlb.com (CF edge can reach it; browsers get 403).
// No auth required. Returns image bytes with long cache headers.

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const id  = url.searchParams.get('id');
  if (!id || !/^\d+$/.test(id)) {
    return new Response('Not found', { status: 404 });
  }

  const upstream = `https://img.mlbstatic.com/mlb-photos/image/upload/f_auto,q_auto:best/v1/people/${id}/headshot/67/current`;

  try {
    const res = await fetch(upstream, {
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return new Response('Not found', { status: 404 });
    }

    const img = await res.arrayBuffer();
    const ct  = res.headers.get('content-type') || 'image/jpeg';

    return new Response(img, {
      status: 200,
      headers: {
        'Content-Type':  ct,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return new Response('Not found', { status: 404 });
  }
}
