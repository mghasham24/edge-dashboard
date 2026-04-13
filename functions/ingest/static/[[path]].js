// Reverse proxy for PostHog static assets — bypasses ad blockers
// Routes: /ingest/static/* -> https://us-assets.i.posthog.com/static/*
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const targetUrl = 'https://us-assets.i.posthog.com/static' + url.pathname.replace('/ingest/static', '') + url.search;
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
