// functions/api/bets/taken.js

export async function onRequest({ request, env }) {
  const token = getToken(request);
  const session = await getSession(env.DB, token);
  if (!session) return fail(401, 'Authentication required');

  if (request.method === 'GET') {
    const row = await env.DB.prepare(
      'SELECT bet_ids FROM bets_taken WHERE user_id = ?'
    ).bind(session.user_id).first();
    const ids = row ? JSON.parse(row.bet_ids) : [];
    return json({ bet_ids: ids });
  }

  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { id, taken } = body;
    if (!id) return fail(400, 'Missing id');

    const row = await env.DB.prepare(
      'SELECT bet_ids FROM bets_taken WHERE user_id = ?'
    ).bind(session.user_id).first();
    let ids = row ? JSON.parse(row.bet_ids) : [];

    if (taken) {
      if (!ids.includes(id)) ids.push(id);
    } else {
      ids = ids.filter(i => i !== id);
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

function getToken(req) {
  const c = req.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  return m ? m[1] : null;
}

async function getSession(db, token) {
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    'SELECT u.id as user_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(token, now).first();
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
