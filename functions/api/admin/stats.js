// functions/api/admin/stats.js
export async function onRequest({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');
  if (!session.is_admin) return fail(403, 'Forbidden');

  const now     = Math.floor(Date.now() / 1000);
  const weekAgo = now - 7 * 86400;

  const [totalRow, weekRow, sessionRow, planRow] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) as c FROM users').first(),
    env.DB.prepare('SELECT COUNT(*) as c FROM users WHERE created_at>?').bind(weekAgo).first(),
    env.DB.prepare('SELECT COUNT(*) as c FROM sessions WHERE expires_at>?').bind(now).first(),
    env.DB.prepare("SELECT plan, COUNT(*) as c FROM users GROUP BY plan").all(),
  ]);

  // Daily signups for last 14 days
  const daily = [];
  for (let i = 13; i >= 0; i--) {
    const dayStart = now - i * 86400 - (now % 86400);
    const dayEnd   = dayStart + 86400;
    const row = await env.DB.prepare(
      'SELECT COUNT(*) as c FROM users WHERE created_at>=? AND created_at<?'
    ).bind(dayStart, dayEnd).first();
    const d = new Date((dayStart + 86400/2) * 1000);
    daily.push({
      date: d.toLocaleDateString('en-US', { month:'short', day:'numeric' }),
      count: row ? row.c : 0
    });
  }

  return new Response(JSON.stringify({
    ok: true,
    total:    totalRow   ? totalRow.c   : 0,
    newWeek:  weekRow    ? weekRow.c    : 0,
    sessions: sessionRow ? sessionRow.c : 0,
    plans:    planRow.results || [],
    daily
  }), { headers: { 'Content-Type': 'application/json' } });
}

async function getSession(request, db) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return null;
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    'SELECT u.id, u.email, u.is_admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(m[1], now).first();
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
