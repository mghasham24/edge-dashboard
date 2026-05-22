import { getSession } from '../../_lib/session.js';
// functions/api/admin/users.js
export async function onRequest(ctx) {
  try {
    return await handleRequest(ctx);
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'Internal error', message: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleRequest({ request, env }) {
  // Auth + admin check
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');
  if (!session.is_admin) return fail(403, 'Forbidden');

  const url    = new URL(request.url);
  const method = request.method;

  // GET /api/admin/users — list users (paginated)
  if (method === 'GET') {
    const search = url.searchParams.get('q') || '';
    const plan   = url.searchParams.get('plan') || '';
    const sort   = url.searchParams.get('sort') || 'signup_desc';
    const limit  = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const orderBy = sort === 'signup_asc'  ? 'u.created_at ASC'
                  : sort === 'pro_desc'    ? 'u.pro_expires_at DESC NULLS LAST'
                  : sort === 'pro_asc'     ? 'u.pro_expires_at ASC NULLS LAST'
                  : 'u.created_at DESC';

    const where = [];
    const binds = [];
    if (search) { where.push('email LIKE ?'); binds.push('%' + search + '%'); }
    if (plan)   { where.push('plan=?');        binds.push(plan); }
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const now = Math.floor(Date.now() / 1000);
    const [countRow, rows] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) as total FROM users ${whereClause}`).bind(...binds).first(),
      env.DB.prepare(`SELECT u.id, u.email, u.plan, u.is_admin, u.banned, u.created_at, u.pro_expires_at, COUNT(s.id) as sessions FROM users u LEFT JOIN sessions s ON s.user_id=u.id AND s.expires_at>? ${whereClause} GROUP BY u.id ORDER BY ${orderBy} LIMIT ? OFFSET ?`).bind(now, ...binds, limit, offset).all(),
    ]);

    const total = countRow?.total || 0;
    const users = rows.results || [];

    return ok({ users, total, hasMore: offset + users.length < total });
  }

  // PATCH /api/admin/users — update plan or banned
  if (method === 'PATCH') {
    let body;
    try { body = await request.json(); } catch { return fail(400, 'Invalid JSON'); }
    const { id, plan, banned } = body;
    if (!id) return fail(400, 'Missing user id');

    if (plan !== undefined) {
      if (!['free', 'pro'].includes(plan)) return fail(400, 'Invalid plan — must be free or pro');
      await env.DB.prepare('UPDATE users SET plan=? WHERE id=?').bind(plan, id).run();
    }
    if (banned !== undefined) {
      await env.DB.prepare('UPDATE users SET banned=? WHERE id=?').bind(banned ? 1 : 0, id).run();
      if (banned) {
        await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id).run();
      }
    }
    return ok({ updated: true });
  }

  // DELETE /api/admin/users?id=X — fully delete user and all dependent rows
  if (method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return fail(400, 'Missing user id');
    const tables = [
      'sessions', 'bets_taken', 'notification_settings', 'telegram_verify_tokens',
      'real_auth', 'password_resets', 'trial_fingerprints', 'alert_messages', 'alert_sent_log'
    ];
    for (const t of tables) {
      await env.DB.prepare(`DELETE FROM ${t} WHERE user_id=?`).bind(id).run().catch(() => {});
    }
    await env.DB.prepare('DELETE FROM referrals WHERE referrer_id=? OR referred_id=?').bind(id, id).run().catch(() => {});
    await env.DB.prepare('DELETE FROM users WHERE id=?').bind(id).run();
    return ok({ deleted: true });
  }

  // POST /api/admin/users?id=X — force logout (delete sessions)
  if (method === 'POST') {
    const id = url.searchParams.get('id');
    if (!id) return fail(400, 'Missing user id');
    await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id).run();
    return ok({ loggedOut: true });
  }

  return fail(405, 'Method not allowed');
}

// ── Helpers ───────────────────────────────────────────

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
