// functions/api/_middleware.js
import { checkRateLimit } from '../_lib/rateLimit.js';

const FREE_SPORTS = ['basketball_nba', 'icehockey_nhl', 'baseball_mlb'];

// Paths that handle their own auth — skip middleware entirely
const SKIP_AUTH_PREFIXES = [
  '/api/auth/',
  '/api/stripe/webhook',
  '/api/admin/rs-token',
  '/api/admin/rs-positions',
  '/api/admin/rs-mark-posted',
  '/api/admin/rs-check-position',
  '/api/admin/rs-check-simple',
];

// Cron/machine calls authenticate internally via their own key param
const MACHINE_PARAMS = ['_cron_key', '_poster_key', '_tm_key'];

// GET endpoints that return identical data for all users in the same plan tier —
// safe to serve from a shared CF edge cache keyed by URL + plan.
const GLOBAL_CACHE_PREFIXES = ['/api/fd/', '/api/dk/', '/api/odds', '/api/ev/current'];
const GLOBAL_CACHE_TTL = 20; // seconds

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return next();

  if (SKIP_AUTH_PREFIXES.some(p => url.pathname.startsWith(p))) return next();
  if (MACHINE_PARAMS.some(p => url.searchParams.has(p)))         return next();

  const token = getToken(request);
  const session = await getSession(env.DB, token);
  if (!session) return fail(401, 'Authentication required');
  if (session.banned) return fail(403, 'Your account has been suspended. Contact support.');

  // Rate limit by session cookie token — 120 req/min per session
  if (!session.is_admin) {
    const cookieId = 'ck_' + (token || '').slice(-20);
    const allowed  = await checkRateLimit(env.DB, request, 'api', 120, 60, cookieId);
    if (!allowed) return fail(429, 'Too many requests. Please slow down.');
  }

  // Global 20s CF edge cache for shared data endpoints (GET only).
  // Cache key includes plan tier so pro-cached responses never leak to free users.
  const plan = (session.plan === 'pro' || session.is_admin) ? 'pro' : 'free';
  const isCacheable = request.method === 'GET'
    && !url.searchParams.has('debug')
    && !url.searchParams.has('fresh')
    && GLOBAL_CACHE_PREFIXES.some(p => url.pathname.startsWith(p));

  if (isCacheable) {
    const cacheKey = 'https://raxedge-cache.internal' + url.pathname + url.search + '&_plan=' + plan;
    const cache    = caches.default;
    const cached   = await cache.match(new Request(cacheKey));
    if (cached) return new Response(cached.body, { status: cached.status, headers: cached.headers });

    // Enforce plan before calling the endpoint
    const planErr = enforcePlan(url, session, env);
    if (planErr) return planErr;

    const response = await next();
    if (response.ok) {
      const toCache = new Response(response.body, response);
      toCache.headers.set('Cache-Control', 'public, max-age=' + GLOBAL_CACHE_TTL);
      context.waitUntil(cache.put(new Request(cacheKey), toCache.clone()));
      return toCache;
    }
    return response;
  }

  // Plan enforcement for non-cached paths
  const planErr = enforcePlan(url, session, env);
  if (planErr) return planErr;

  return next();
}

function enforcePlan(url, session, env) {
  if (!url.pathname.startsWith('/api/odds')) return null;
  const FREE_PROMO_END = new Date(env.FREE_PROMO_END || '2026-04-06T04:59:00Z');
  const isPro = session.plan === 'pro' || session.is_admin || new Date() < FREE_PROMO_END;
  if (isPro) return null;
  const sport = url.searchParams.get('sport') || '';
  if (FREE_SPORTS.indexOf(sport) === -1) return fail(403, 'This sport requires a Pro plan.');
  const markets = (url.searchParams.get('markets') || 'h2h').split(',');
  if (markets.some(m => m.trim() !== 'h2h')) return fail(403, 'Spreads and totals require a Pro plan.');
  return null;
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
