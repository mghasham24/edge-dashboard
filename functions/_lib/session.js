// functions/_lib/session.js — shared session resolver
// Selects all commonly needed user fields so callers don't need their own query.
// Returns null if the cookie is missing or the session is expired/invalid.
// Field naming: user_id (alias for u.id) so the majority of existing callers need no changes.
export async function getSession(request, db) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)(?:__Host-)?session=([^;]+)/);
  if (!m) return null;
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    'SELECT u.id as user_id, u.email, u.plan, u.is_admin, u.banned, u.stripe_customer_id, u.had_free_trial FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(m[1], now).first();
}
