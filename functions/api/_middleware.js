// functions/api/_middleware.js
const FREE_SPORTS = ['basketball_nba', 'icehockey_nhl', 'baseball_mlb'];

export async function onRequest({ request, env, next }) {
  const url     = new URL(request.url);
  const guarded = ['/api/odds', '/api/scores', '/api/admin', '/api/stripe'];
  if (!guarded.some(p => url.pathname.startsWith(p))) return next();

  // Auth endpoints don't need session
  if (url.pathname.startsWith('/api/auth')) return next();

  const token   = getToken(request);
  const session = await getSession(env.DB, token);
  if (!session) return fail(401, 'Authentication required');

  // Banned user check
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

  // Rate limiting on /api/odds (not for admins)
  if (url.pathname.startsWith('/api/odds') && !session.is_admin) {
    const limited = await checkRateLimit(env.DB, session.user_id);
    if (limited) return fail(429, 'Daily refresh limit reached. Try again tomorrow.');
  }

  return next();
}

// ── Rate limiting ─────────────────────────────────────
// Free: 30 refreshes/day, Pro: 150 refreshes/day
async function checkRateLimit(db, userId) {
  const today     = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const row       = await db.prepare(
    'SELECT count, plan FROM rate_limits rl JOIN users u ON u.id=rl.user_id WHERE rl.user_id=? AND rl.date=?'
  ).bind(userId, today).first();

  const plan      = row ? row.plan : 'free';
  const limit     = plan === 'pro' ? 150 : 30;
  const count     = row ? row.count : 0;

  if (count >= limit) return true;

  // Upsert count
  await db.prepare(
    'INSERT INTO rate_limits (user_id, date, count) VALUES (?,?,1) ON CONFLICT(user_id, date) DO UPDATE SET count=count+1'
  ).bind(userId, today).run();

  return false;
}

// ── Helpers ───────────────────────────────────────────
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
