// functions/api/_middleware.js
// Protects /api/odds and /api/scores — requires a valid session cookie
import { getSessionToken, getSession, err } from './auth/_auth.js';

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);

  // Only guard odds + scores endpoints
  const guarded = ['/api/odds', '/api/scores'];
  const isGuarded = guarded.some(p => url.pathname.startsWith(p));
  if (!isGuarded) return next();

  const token   = getSessionToken(request);
  const session = await getSession(env.DB, token);
  if (!session) return err('Authentication required', 401);

  return next();
}
