// functions/api/real/connect.js
// POST /api/real/connect — saves user's Real Sports auth token
// GET  /api/real/connect — returns connection status

export async function onRequest({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Authentication required');

  await ensureTable(env.DB);

  if (request.method === 'GET') {
    const row = await env.DB.prepare(
      'SELECT updated_at FROM real_auth WHERE user_id = ?'
    ).bind(session.user_id).first();
    return json({ connected: !!row, updatedAt: row ? row.updated_at : null });
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return fail(400, 'Invalid JSON'); }

    const { auth_token, device_uuid, rs_username, rs_user_id } = body;

    // Username-based connect (mobile public lookup path)
    if (rs_username && rs_user_id) {
      await ensureUsernameColumns(env.DB);
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        `INSERT INTO real_auth (user_id, rs_username, rs_user_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           rs_username = excluded.rs_username,
           rs_user_id  = excluded.rs_user_id,
           updated_at  = excluded.updated_at`
      ).bind(session.user_id, String(rs_username), String(rs_user_id), now).run();
      return json({ ok: true, method: 'username' });
    }

    // Token-based connect (desktop bookmarklet path)
    if (!auth_token || typeof auth_token !== 'string' || !auth_token.includes('!')) {
      return fail(400, 'Invalid auth_token format');
    }

    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO real_auth (user_id, auth_token, device_uuid, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         auth_token  = excluded.auth_token,
         device_uuid = excluded.device_uuid,
         updated_at  = excluded.updated_at`
    ).bind(session.user_id, auth_token, device_uuid || null, now).run();

    return json({ ok: true, method: 'token' });
  }

  return fail(405, 'Method not allowed');
}

async function ensureTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS real_auth (
      user_id    INTEGER PRIMARY KEY,
      auth_token TEXT,
      device_uuid TEXT,
      rs_username TEXT,
      rs_user_id  TEXT,
      updated_at INTEGER NOT NULL
    )
  `).run().catch(() => {});
}

async function ensureUsernameColumns(db) {
  // Add columns if they don't exist yet (safe to call repeatedly)
  await db.prepare(`ALTER TABLE real_auth ADD COLUMN rs_username TEXT`).run().catch(() => {});
  await db.prepare(`ALTER TABLE real_auth ADD COLUMN rs_user_id TEXT`).run().catch(() => {});
}

function getToken(req) {
  const c = req.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  return m ? m[1] : null;
}

async function getSession(request, db) {
  const token = getToken(request);
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    'SELECT u.id as user_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(token, now).first();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
