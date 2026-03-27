// functions/api/_middleware.js
const FREE_SPORTS = ['basketball_nba', 'icehockey_nhl', 'baseball_mlb'];

export async function onRequest({ request, env, next }) {
  const url     = new URL(request.url);
  const guarded = ['/api/odds', '/api/scores', '/api/admin', '/api/stripe'];
  if (!guarded.some(p => url.pathname.startsWith(p))) return next();

  if (url.pathname.startsWith('/api/auth')) return next();
  if (url.pathname === '/api/stripe/webhook') return next();

  const token   = getToken(request);
  const session = await getSession(env.DB, token);
  if (!session) return fail(401, 'Authentication required');

  if (session.banned) return fail(403, 'Your account has been suspended. Contact support.');

  // Plan enforcement on /api/odds
  if (url.pathname.startsWith('/api/odds')) {
    const isPro = session.plan === 'pro' || session.is_admin;
    if (!isPro) {
      const sport = url.searchParams.get('sport') || '';
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
    'SELECT u.id as user_id, u.plan, u.is_admin, u.banned FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(token, now).first();
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
