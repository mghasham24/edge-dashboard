// Reverse proxy for PostHog — routes through raxedge.com to bypass ad blockers
// Static assets: /ingest/static/* -> us-assets.i.posthog.com
// Event ingestion: /ingest/* -> us.i.posthog.com
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const path = url.pathname.replace('/ingest', '') || '/';
  const isStatic = path.startsWith('/static');
  const targetBase = isStatic ? 'https://us-assets.i.posthog.com' : 'https://us.i.posthog.com';
  const targetUrl = targetBase + path + url.search;

  const res = await fetch(targetUrl, {
    method: context.request.method,
    headers: context.request.headers,
    body: context.request.method !== 'GET' && context.request.method !== 'HEAD'
      ? context.request.body : undefined,
  });

  return new Response(res.body, { status: res.status, headers: res.headers });
}
