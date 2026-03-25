// functions/api/_middleware.js
const FREE_SPORTS = ['basketball_nba', 'icehockey_nhl', 'baseball_mlb'];

export async function onRequest({ request, env, next }) {
  const url     = new URL(request.url);
  const guarded = ['/api/odds', '/api/scores'];
  if (!guarded.some(p => url.pathname.startsWith(p))) return next();

  const token   = getToken(request);
  const session = await getSession(env.DB, token);
  if (!session) return fail(401, 'Authentication required');

  if (url.pathname.startsWith('/api/odds')) {
    const isPro = session.plan === 'pro' || session.is_admin;
    if (!isPro) {
      const sport = url.searchParams.get('sport') || '';
      // Block locked sports entirely — free sports can fetch all markets for teaser UI
      if (FREE_SPORTS.indexOf(sport) === -1) {
        return fail(403, 'This sport requires a Pro plan.');
      }
    }
  }
  return next();
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
    'SELECT u.id, u.plan, u.is_admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(token, now).first();
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
