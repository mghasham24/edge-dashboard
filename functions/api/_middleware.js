// functions/api/_middleware.js
import { checkRateLimit } from '../_lib/rateLimit.js';

const FREE_SPORTS  = ['basketball_nba', 'icehockey_nhl', 'baseball_mlb'];

// These paths handle their own auth — skip middleware session check entirely
const SKIP_AUTH_PREFIXES = [
  '/api/auth/',
  '/api/stripe/webhook',
  '/api/admin/rs-token',
  '/api/admin/rs-positions',
  '/api/admin/rs-mark-posted',
  '/api/admin/rs-check-position',
  '/api/admin/rs-check-simple',
];

// Cron/machine calls use their own key param — endpoints handle auth internally
const MACHINE_PARAMS = ['_cron_key', '_poster_key', '_tm_key'];

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return next();

  if (SKIP_AUTH_PREFIXES.some(p => url.pathname.startsWith(p))) return next();
  if (MACHINE_PARAMS.some(p => url.searchParams.has(p)))         return next();

  const token   = getToken(request);
  const session = await getSession(env.DB, token);
  if (!session) return fail(401, 'Authentication required');
  if (session.banned) return fail(403, 'Your account has been suspended. Contact support.');

  // 120 req/min per user across all data endpoints — keyed by user_id so VPN/proxy
  // hops don't split the bucket or unfairly throttle other users on shared IPs.
  if (!session.is_admin) {
    const allowed = await checkRateLimit(env.DB, request, 'api', 120, 60, 'u' + session.user_id);
    if (!allowed) return fail(429, 'Too many requests. Please slow down.');
  }

  // Plan enforcement on /api/odds
  if (url.pathname.startsWith('/api/odds')) {
    const FREE_PROMO_END = new Date(env.FREE_PROMO_END || '2026-04-06T04:59:00Z');
    const isPro = session.plan === 'pro' || session.is_admin || new Date() < FREE_PROMO_END;
    if (!isPro) {
      const sport = url.searchParams.get('sport') || '';
      if (FREE_SPORTS.indexOf(sport) === -1) return fail(403, 'This sport requires a Pro plan.');
      const markets = (url.searchParams.get('markets') || 'h2h').split(',');
      if (markets.some(m => m.trim() !== 'h2h')) return fail(403, 'Spreads and totals require a Pro plan.');
    }
  }

  return next();
}

function getToken(req) {
  const c = req.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)(?:__Host-)?session=([^;]+)/);
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
