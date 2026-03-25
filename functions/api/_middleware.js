// functions/api/_middleware.js
export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);
  const guarded = ['/api/odds', '/api/scores'];
  if (!guarded.some(p => url.pathname.startsWith(p))) return next();

  const token = getToken(request);
  if (!token) return fail(401);
  const session = await getSession(env.DB, token);
  if (!session) return fail(401);
  return next();
}

function getToken(req) {
  const c = req.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  return m ? m[1] : null;
}

async function getSession(db, token) {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    'SELECT user_id FROM sessions WHERE token=? AND expires_at>?'
  ).bind(token, now).first();
}

function fail(status) {
  return new Response(JSON.stringify({ error: 'Authentication required' }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
