// functions/api/alerts/taken.js
// GET → return bets the user has marked as taken via Telegram

async function getSession(request, db) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return null;
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    'SELECT u.id as user_id, u.plan, u.is_admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(m[1], now).first();
}

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
  const session = await getSession(request, env.DB);
  if (!session) return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  const now = Math.floor(Date.now() / 1000);
  const midnightET = Math.floor((now + 4 * 3600) / 86400) * 86400 - 4 * 3600;

  const rows = await env.DB.prepare(
    `SELECT id, sport, game, market, side, pt, ev, units, dollar_amt, sent_at
     FROM alert_messages
     WHERE user_id=? AND taken=1 AND sent_at>=?
     ORDER BY sent_at DESC LIMIT 50`
  ).bind(session.user_id, midnightET).all();

  return new Response(JSON.stringify({ ok: true, bets: rows.results || [] }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
