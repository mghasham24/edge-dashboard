import { getSession } from './session.js';
// functions/_lib/auth.js — session resolver that also accepts cron key bypass
// Returns a session object (real or synthetic) or null if unauthenticated.
// Callers still do their own plan/admin checks since those are business logic.
export async function getSessionOrCron(request, env) {
  const cronKey = new URL(request.url).searchParams.get('_cron_key');
  if (cronKey && env.CRON_SECRET && cronKey === env.CRON_SECRET) {
    return { user_id: 0, plan: 'pro', is_admin: 1 };
  }
  return getSession(request, env.DB);
}
