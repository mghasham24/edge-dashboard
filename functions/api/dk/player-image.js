// functions/api/dk/player-image.js
// GET /api/dk/player-image?id={dkPlayerId}&size=sm
// Proxies DK player headshots through our worker to avoid cross-origin/Akamai issues.

export async function onRequestGet({ request }) {
  const url  = new URL(request.url);
  const id   = url.searchParams.get('id');
  const size = url.searchParams.get('size') || 'sm';

  if (!id || !/^\d+$/.test(id)) {
    return new Response('Not found', { status: 404 });
  }

  const imgUrl = `https://gaming.draftkings.com/api/images/v1/players/${id}/image?size=${size}`;

  try {
    const res = await fetch(imgUrl, {
      headers: {
        'Accept':          'image/webp,image/avif,image/*,*/*;q=0.8',
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
        'Referer':         'https://sportsbook.draftkings.com/',
        'Origin':          'https://sportsbook.draftkings.com',
        'Sec-Fetch-Site':  'same-site',
        'Sec-Fetch-Mode':  'no-cors',
        'Sec-Fetch-Dest':  'image',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return new Response('Not found', { status: 404 });

    const body        = await res.arrayBuffer();
    const contentType = res.headers.get('content-type') || 'image/webp';

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type':  contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch(e) {
    return new Response('Not found', { status: 404 });
  }
}
