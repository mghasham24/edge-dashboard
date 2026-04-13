// Reverse proxy for PostHog event ingestion — bypasses ad blockers
// Routes: /ingest/* -> https://us.i.posthog.com/*
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const targetUrl = 'https://us.i.posthog.com' + url.pathname.replace('/ingest', '') + url.search;
  const res = await fetch(targetUrl, {
    method: context.request.method,
    headers: context.request.headers,
    body: context.request.method !== 'GET' && context.request.method !== 'HEAD' ? context.request.body : undefined,
  });
  return new Response(res.body, {
    status: res.status,
    headers: res.headers,
  });
}
