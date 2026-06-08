import { getSession } from '../../_lib/session.js';
import { hashidsEncode } from '../../_lib/hashids.js';
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
    await ensureRsHashidColumn(env.DB);
    const search = url.searchParams.get('q') || '';
    const plan   = url.searchParams.get('plan') || '';
    const sort   = url.searchParams.get('sort') || 'signup_desc';
    const group  = url.searchParams.get('group');
    const limit  = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const orderBy = sort === 'signup_asc'  ? 'u.created_at ASC'
                  : sort === 'pro_desc'    ? 'u.pro_expires_at DESC NULLS LAST'
                  : sort === 'pro_asc'     ? 'u.pro_expires_at ASC NULLS LAST'
                  : sort === 'group_desc'  ? 'u.group_access DESC, u.created_at DESC'
                  : 'u.created_at DESC';

    const where = [];
    const binds = [];
    if (search)          { where.push('(u.email LIKE ? OR u.rs_group_username LIKE ?)'); binds.push('%' + search + '%', '%' + search + '%'); }
    if (plan)            { where.push('u.plan=?'); binds.push(plan); }
    if (group !== null && group !== '') { where.push('u.group_access=?'); binds.push(parseInt(group)); }
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const now = Math.floor(Date.now() / 1000);
    const [countRow, rows] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) as total FROM users u ${whereClause}`).bind(...binds).first(),
      env.DB.prepare(`SELECT u.id, u.email, u.plan, u.is_admin, u.banned, u.created_at, u.pro_expires_at, u.group_access, u.rs_group_username, u.rs_hashid, ra.rs_user_id, ra.rs_username, COUNT(s.id) as sessions FROM users u LEFT JOIN sessions s ON s.user_id=u.id AND s.expires_at>? LEFT JOIN real_auth ra ON ra.user_id=u.id ${whereClause} GROUP BY u.id ORDER BY ${orderBy} LIMIT ? OFFSET ?`).bind(now, ...binds, limit, offset).all(),
    ]);

    const total = countRow?.total || 0;
    const users = rows.results || [];

    return ok({ users, total, hasMore: offset + users.length < total });
  }

  // PATCH /api/admin/users — update plan or banned
  if (method === 'PATCH') {
    let body;
    try { body = await request.json(); } catch { return fail(400, 'Invalid JSON'); }
    const { id, plan, banned, group_access, rs_group_username } = body;
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
    if (group_access !== undefined || rs_group_username !== undefined) {
      // Prevent the same RS username from being used by two different accounts
      if (rs_group_username) {
        const conflict = await env.DB.prepare(
          'SELECT id FROM users WHERE rs_group_username=? AND id!=?'
        ).bind(rs_group_username, id).first();
        if (conflict) return fail(409, 'RS username already used by another account');
      }
      await ensureRsHashidColumn(env.DB);
      // When a username is set/changed, fetch their permanent RS hashid in background
      let rsHashid = null;
      if (rs_group_username) {
        rsHashid = await fetchRsHashid(rs_group_username, env).catch(() => null);
      }
      if (group_access !== undefined && rs_group_username !== undefined) {
        const q = rsHashid
          ? 'UPDATE users SET group_access=?, rs_group_username=?, rs_hashid=? WHERE id=?'
          : 'UPDATE users SET group_access=?, rs_group_username=? WHERE id=?';
        const args = rsHashid
          ? [group_access ? 1 : 0, rs_group_username || null, rsHashid, id]
          : [group_access ? 1 : 0, rs_group_username || null, id];
        await env.DB.prepare(q).bind(...args).run();
      } else if (group_access !== undefined) {
        await env.DB.prepare('UPDATE users SET group_access=? WHERE id=?').bind(group_access ? 1 : 0, id).run();
      } else {
        const q = rsHashid
          ? 'UPDATE users SET rs_group_username=?, rs_hashid=? WHERE id=?'
          : 'UPDATE users SET rs_group_username=? WHERE id=?';
        const args = rsHashid
          ? [rs_group_username || null, rsHashid, id]
          : [rs_group_username || null, id];
        await env.DB.prepare(q).bind(...args).run();
      }
    }
    return ok({ updated: true, rs_hashid: rsHashid || null });
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

async function ensureRsHashidColumn(db) {
  await db.prepare('ALTER TABLE users ADD COLUMN rs_hashid TEXT').run().catch(() => {});
}

async function fetchRsHashid(username, env) {
  // Get shared RS auth token (same source as sync.js)
  let token = env.RS_AUTH_TOKEN || env.REAL_AUTH_TOKEN || '';
  const deviceUuid = env.REAL_DEVICE_UUID || '2e0a38e2-0ee8-4f93-9a34-218ac1d10161';
  if (!token) {
    try {
      const row = await env.DB.prepare("SELECT data FROM odds_cache WHERE cache_key='meta:rs_auth_token'").first();
      if (row) token = JSON.parse(row.data).token || '';
    } catch(e) {}
  }
  if (!token) return null;
  const res = await fetch(`https://web.realapp.com/user/${encodeURIComponent(username)}`, {
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Origin': 'https://realsports.io',
      'Referer': 'https://realsports.io/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
      'real-auth-info': token,
      'real-device-uuid': deviceUuid,
      'real-device-type': 'desktop_web',
      'real-version': '33',
      'real-request-token': hashidsEncode(Date.now()),
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.id || data.hashId || data.userId || null;
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
