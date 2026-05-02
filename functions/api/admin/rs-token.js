// functions/api/admin/rs-token.js
// Receives a fresh RS auth token from the Tampermonkey script and saves it to D1.
// Protected by RS_TOKEN_SECRET env variable.

export async function onRequestPost({ request, env }) {
  const secret = new URL(request.url).searchParams.get('key');
  if (!secret || secret !== env.RS_TOKEN_SECRET) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }

  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }

  const { token, deviceUuid } = body;
  if (!token) return new Response(JSON.stringify({ error: 'Missing token' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const now = Math.floor(Date.now() / 1000);
  const data = JSON.stringify({ token, deviceUuid: deviceUuid || '' });

  await env.DB.prepare(
    "INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES ('rs_auth_token',?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at"
  ).bind(data, now).run();

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
}

export async function onRequestOptions() {
  return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
}
