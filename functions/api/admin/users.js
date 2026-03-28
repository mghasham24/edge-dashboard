// functions/api/admin/users.js
export async function onRequest({ request, env }) {
  // Auth + admin check
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');
  if (!session.is_admin) return fail(403, 'Forbidden');

  const url    = new URL(request.url);
  const method = request.method;

  // GET /api/admin/users — list all users
  if (method === 'GET') {
    const search = url.searchParams.get('q') || '';
    const plan   = url.searchParams.get('plan') || '';
    const sort   = url.searchParams.get('sort') || 'signup_desc';

    const orderBy = sort === 'signup_asc'  ? 'created_at ASC'
                  : sort === 'pro_desc'    ? 'pro_expires_at DESC NULLS LAST'
                  : sort === 'pro_asc'     ? 'pro_expires_at ASC NULLS LAST'
                  : 'created_at DESC';

    let rows;
    if (search && plan) {
      rows = await env.DB.prepare(
        `SELECT id, email, plan, is_admin, banned, created_at, pro_expires_at FROM users WHERE email LIKE ? AND plan=? ORDER BY ${orderBy}`
      ).bind('%' + search + '%', plan).all();
    } else if (search) {
      rows = await env.DB.prepare(
        `SELECT id, email, plan, is_admin, banned, created_at, pro_expires_at FROM users WHERE email LIKE ? ORDER BY ${orderBy}`
      ).bind('%' + search + '%').all();
    } else if (plan) {
      rows = await env.DB.prepare(
        `SELECT id, email, plan, is_admin, banned, created_at, pro_expires_at FROM users WHERE plan=? ORDER BY ${orderBy}`
      ).bind(plan).all();
    } else {
      rows = await env.DB.prepare(
        `SELECT id, email, plan, is_admin, banned, created_at, pro_expires_at FROM users ORDER BY ${orderBy}`
      ).all();
    }

    // Attach active session count per user
    const ids = (rows.results || []).map(r => r.id);
    const now = Math.floor(Date.now() / 1000);
    const users = await Promise.all((rows.results || []).map(async u => {
      const sc = await env.DB.prepare(
        'SELECT COUNT(*) as c FROM sessions WHERE user_id=? AND expires_at>?'
      ).bind(u.id, now).first();
      return { ...u, sessions: sc ? sc.c : 0 };
    }));

    return ok({ users });
  }

  // PATCH /api/admin/users — update plan or banned
  if (method === 'PATCH') {
    let body;
    try { body = await request.json(); } catch { return fail(400, 'Invalid JSON'); }
    const { id, plan, banned } = body;
    if (!id) return fail(400, 'Missing user id');

    if (plan !== undefined) {
      await env.DB.prepare('UPDATE users SET plan=? WHERE id=?').bind(plan, id).run();
    }
    if (banned !== undefined) {
      await env.DB.prepare('UPDATE users SET banned=? WHERE id=?').bind(banned ? 1 : 0, id).run();
      if (banned) {
        // Force logout banned user
        await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id).run();
      }
    }
    return ok({ updated: true });
  }

  // DELETE /api/admin/users?id=X — delete user + sessions
  if (method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return fail(400, 'Missing user id');
    await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id).run();
    await env.DB.prepare('DELETE FROM users WHERE id=?').bind(id).run();
    return ok({ deleted: true });
  }

  // POST /api/admin/users/logout?id=X — force logout (delete sessions)
  if (method === 'POST') {
    const id = url.searchParams.get('id');
    if (!id) return fail(400, 'Missing user id');
    await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id).run();
    return ok({ loggedOut: true });
  }

  return fail(405, 'Method not allowed');
}

// ── Helpers ───────────────────────────────────────────
async function getSession(request, db) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return null;
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    'SELECT u.id, u.email, u.plan, u.is_admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(m[1], now).first();
}

function ok(data) {
  return new Response(JSON.stringify({ ok: true, ...data }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
