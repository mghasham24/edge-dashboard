// functions/api/admin/rs-token.js
// Receives a fresh RS auth token from the Tampermonkey script and saves it to D1.
// Protected by RS_TOKEN_SECRET env variable.

export async function onRequestGet({ request, env }) {
  const secret = new URL(request.url).searchParams.get('key');
  if (!secret || secret !== env.RS_TOKEN_SECRET) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }
  const row = await env.DB.prepare(
    "SELECT data FROM odds_cache WHERE cache_key='meta:rs_auth_token'"
  ).first();
  if (!row?.data) return new Response(JSON.stringify({ error: 'No token' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  let parsed;
  try { parsed = JSON.parse(row.data); } catch { return new Response(JSON.stringify({ error: 'Bad data' }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }
  if (!parsed.token) return new Response(JSON.stringify({ error: 'No token' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify({ token: parsed.token, deviceUuid: parsed.deviceUuid || '' }), { headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost({ request, env }) {
  const secret = new URL(request.url).searchParams.get('key');
  const tmKey = env.TM_PUSH_KEY;
  if (!secret || (secret !== env.RS_TOKEN_SECRET && secret !== tmKey)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }

  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }

  const { token, deviceUuid } = body;
  if (!token) return new Response(JSON.stringify({ error: 'Missing token' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const now = Math.floor(Date.now() / 1000);
  const data = JSON.stringify({ token, deviceUuid: deviceUuid || '' });

  await env.DB.prepare(
    "INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES ('meta:rs_auth_token',?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at"
  ).bind(data, now).run();

  // If pool_id provided, also store in token pool for multi-token RS rate limit scaling
  const poolId = (new URL(request.url).searchParams.get('pool_id') || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
  if (poolId) {
    await env.DB.prepare(
      "INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at"
    ).bind(`rs_pool_token_${poolId}`, token, now).run();
  }

  // Also save to real_auth for the admin user so giveaway counter can use it
  try {
    const admin = await env.DB.prepare('SELECT id FROM users WHERE is_admin=1 LIMIT 1').first();
    if (admin) {
      const rsUserId = token.split('!')[0] || null;
      await env.DB.prepare(
        `INSERT INTO real_auth (user_id, auth_token, device_uuid, rs_user_id, updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET
           auth_token  = excluded.auth_token,
           device_uuid = excluded.device_uuid,
           rs_user_id  = COALESCE(excluded.rs_user_id, real_auth.rs_user_id),
           updated_at  = excluded.updated_at`
      ).bind(admin.id, token, deviceUuid || null, rsUserId, now).run();
    }
  } catch(e) {}

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://realsports.io' } });
}

export async function onRequestOptions() {
  return new Response(null, { headers: { 'Access-Control-Allow-Origin': 'https://realsports.io', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
}
