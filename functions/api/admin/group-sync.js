// functions/api/admin/group-sync.js
// GET /api/admin/group-sync
// Fetches RS group members and cross-references with RaxEdge D1 users.

import { getSession } from '../../_lib/session.js';
import { hashidsEncode } from '../../_lib/hashids.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');
  if (!session.is_admin) return fail(403, 'Forbidden');

  // Get RS auth token
  let token = env.RS_AUTH_TOKEN || env.REAL_AUTH_TOKEN || '';
  const deviceUuid = env.REAL_DEVICE_UUID || '2e0a38e2-0ee8-4f93-9a34-218ac1d10161';
  if (!token) {
    try {
      const row = await env.DB.prepare("SELECT data FROM odds_cache WHERE cache_key='meta:rs_auth_token'").first();
      if (row) token = JSON.parse(row.data).token || '';
    } catch(e) {}
  }
  if (!token) return fail(503, 'RS token not available');

  const groupId = env.RS_GROUP_ID || '61979';
  const rsRes = await fetch(`https://web.realapp.com/groups/${groupId}/searchmembers?permissionsFilter=all`, {
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
    signal: AbortSignal.timeout(8000),
  }).catch(e => { throw new Error('RS fetch failed: ' + e.message); });

  if (!rsRes.ok) return fail(502, 'RS API returned ' + rsRes.status);
  const rsData = await rsRes.json();
  const rsMembers = rsData.users || [];

  // Paginate — RS returns a cursor when there are more members
  let cursor = rsData.cursor || rsData.nextCursor || null;
  let pageLimit = 20; // safety cap
  while (cursor && pageLimit-- > 0) {
    const pageRes = await fetch(
      `https://web.realapp.com/groups/${groupId}/searchmembers?permissionsFilter=all&cursor=${encodeURIComponent(cursor)}`,
      {
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
        signal: AbortSignal.timeout(8000),
      }
    ).catch(() => null);
    if (!pageRes || !pageRes.ok) break;
    const pageData = await pageRes.json();
    rsMembers.push(...(pageData.users || []));
    cursor = pageData.cursor || pageData.nextCursor || null;
  }

  // All RaxEdge users with group_access=1 or rs_group_username set
  const { results: adminUsers } = await env.DB.prepare(
    'SELECT id, email, plan, group_access, rs_group_username, rs_hashid FROM users WHERE group_access=1 OR rs_group_username IS NOT NULL'
  ).all();

  // Build lookup maps (case-insensitive username, exact hashid)
  const adminByUsername = new Map();
  const adminByHashid   = new Map();
  for (const u of adminUsers) {
    if (u.rs_group_username) adminByUsername.set(u.rs_group_username.toLowerCase(), u);
    if (u.rs_hashid)         adminByHashid.set(u.rs_hashid, u);
  }

  const rsMemberNames = new Set(rsMembers.map(m => m.userName.toLowerCase()));

  // In RS group but no matching RaxEdge account
  const inRsOnly = rsMembers
    .filter(m => !adminByUsername.has(m.userName.toLowerCase()) && !adminByHashid.has(m.id))
    .map(m => ({ rsId: m.id, rsUsername: m.userName, addedAt: m.addedAt || null }));

  // In admin with group_access=1 but username not found in RS group
  const inAdminOnly = adminUsers
    .filter(u => u.group_access && (!u.rs_group_username || !rsMemberNames.has(u.rs_group_username.toLowerCase())))
    .map(u => ({ id: u.id, email: u.email, plan: u.plan, rs_group_username: u.rs_group_username || null }));

  // Matched
  const matched = rsMembers
    .filter(m => adminByUsername.has(m.userName.toLowerCase()) || adminByHashid.has(m.id))
    .map(m => {
      const u = adminByUsername.get(m.userName.toLowerCase()) || adminByHashid.get(m.id);
      return { rsId: m.id, rsUsername: m.userName, adminId: u.id, adminEmail: u.email };
    });

  return ok({ rsTotal: rsMembers.length, adminGroupTotal: adminUsers.filter(u => u.group_access).length, matched, inRsOnly, inAdminOnly });
}

function ok(d)           { return new Response(JSON.stringify({ ok: true,  ...d }), { headers: { 'Content-Type': 'application/json' } }); }
function fail(status, m) { return new Response(JSON.stringify({ ok: false, error: m }), { status, headers: { 'Content-Type': 'application/json' } }); }
