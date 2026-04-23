// functions/api/bets/log.js
// Manual bet tracker — GET/POST/PATCH/DELETE

export async function onRequest({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Authentication required');

  if (request.method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT id, game, market, side, odds, line, stake, sport, result, created_at FROM bet_log WHERE user_id=? ORDER BY created_at DESC LIMIT 200'
    ).bind(session.user_id).all();
    return json({ ok: true, bets: rows.results || [] });
  }

  if (request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const { game, market, side, odds, line, stake, sport } = b;
    if (!game || !market || !side || odds == null || !stake) return fail(400, 'Missing fields');
    const now = Math.floor(Date.now() / 1000);
    const res = await env.DB.prepare(
      'INSERT INTO bet_log (user_id, game, market, side, odds, line, stake, sport, result, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).bind(session.user_id, game, market, side, parseInt(odds), line ?? null, parseFloat(stake), sport || null, 'pending', now).run();
    return json({ ok: true, id: res.meta?.last_row_id });
  }

  if (request.method === 'PATCH') {
    const b = await request.json().catch(() => ({}));
    const { id, result } = b;
    if (!id || !['pending', 'win', 'loss', 'push'].includes(result)) return fail(400, 'Invalid');
    await env.DB.prepare(
      'UPDATE bet_log SET result=? WHERE id=? AND user_id=?'
    ).bind(result, id, session.user_id).run();
    return json({ ok: true });
  }

  if (request.method === 'DELETE') {
    const b = await request.json().catch(() => ({}));
    if (!b.id) return fail(400, 'Missing id');
    await env.DB.prepare('DELETE FROM bet_log WHERE id=? AND user_id=?').bind(b.id, session.user_id).run();
    return json({ ok: true });
  }

  return fail(405, 'Method not allowed');
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

function json(data) {
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), { status, headers: { 'Content-Type': 'application/json' } });
}
