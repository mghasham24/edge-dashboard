// functions/api/bets/taken.js
import { getSession } from '../../_lib/session.js';

export async function onRequest({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Authentication required');

  if (request.method === 'GET') {
    const row = await env.DB.prepare(
      'SELECT bet_ids FROM bets_taken WHERE user_id = ?'
    ).bind(session.user_id).first();
    let ids = [];
    try { ids = row ? JSON.parse(row.bet_ids) : []; } catch { ids = []; }
    return json({ bet_ids: ids });
  }

  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { id, taken, also } = body;
    if (!id) return fail(400, 'Missing id');

    const row = await env.DB.prepare(
      'SELECT bet_ids FROM bets_taken WHERE user_id = ?'
    ).bind(session.user_id).first();
    let ids = [];
    try { ids = row ? JSON.parse(row.bet_ids) : []; } catch { ids = []; }

    if (taken) {
      if (!ids.includes(id)) ids.push(id);
      // also: auto-taken opposite side, sent in same request to avoid race condition
      if (also && !ids.includes(also)) ids.push(also);
      if (ids.length > 1000) ids.splice(0, ids.length - 1000);
    } else {
      // Remove both plain and auto|| variant so un-taking cleans up cross-device state
      const plainId = id.startsWith('auto||') ? id.slice(6) : id;
      ids = ids.filter(i => i !== plainId && i !== 'auto||' + plainId);
    }

    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO bets_taken (user_id, bet_ids, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET bet_ids=excluded.bet_ids, updated_at=excluded.updated_at`
    ).bind(session.user_id, JSON.stringify(ids), now).run();

    return json({ ok: true });
  }

  return fail(405, 'Method not allowed');
}


function json(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' }
  });
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
