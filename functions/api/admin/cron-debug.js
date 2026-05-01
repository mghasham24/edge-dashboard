// functions/api/admin/cron-debug.js
// Returns the last cron debug snapshot + alert_sent_log entries

async function getSession(request, db) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return null;
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    'SELECT u.id as user_id, u.plan, u.is_admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(m[1], now).first();
}

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return new Response('Unauthorized', { status: 401 });
  if (!session.is_admin) return new Response('Forbidden', { status: 403 });

  const now = Math.floor(Date.now() / 1000);

  const [debugRow, logRows, fdMlbRow, rsMlbRow] = await Promise.all([
    env.DB.prepare("SELECT data, fetched_at FROM odds_cache WHERE cache_key='cron_debug'").first(),
    env.DB.prepare("SELECT user_id, bet_key, last_ev, sent_at FROM alert_sent_log ORDER BY sent_at DESC LIMIT 50").all(),
    env.DB.prepare("SELECT fetched_at FROM odds_cache WHERE cache_key='fd_mlb'").first(),
    env.DB.prepare("SELECT cache_key, fetched_at FROM odds_cache WHERE cache_key LIKE 'real_sync_mlb_%' ORDER BY fetched_at DESC LIMIT 1").first(),
  ]);

  const cronDebug = debugRow ? JSON.parse(debugRow.data) : null;
  const cronAge   = debugRow ? now - debugRow.fetched_at : null;

  return new Response(JSON.stringify({
    cronAgeSeconds: cronAge,
    cronDebug,
    fdMlbAgeSeconds: fdMlbRow ? now - fdMlbRow.fetched_at : null,
    rsMlbCacheKey: rsMlbRow?.cache_key,
    rsMlbAgeSeconds: rsMlbRow ? now - rsMlbRow.fetched_at : null,
    alertSentLog: logRows.results || [],
  }, null, 2), { headers: { 'Content-Type': 'application/json' } });
}
