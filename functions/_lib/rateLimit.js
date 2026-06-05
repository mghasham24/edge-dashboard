// functions/_lib/rateLimit.js
// IP-based rate limiter backed by D1 auth_rate_limits table.
// key    — unique prefix (e.g. 'login', 'forgot', 'register')
// max    — max requests allowed in the window
// window — window size in seconds
// Returns true if the request is allowed, false if rate-limited.
// identifier — optional, defaults to client IP. Pass a user ID string to rate-limit per user
//              regardless of IP (better for authenticated endpoints).
export async function checkRateLimit(db, request, key, max, windowSecs, identifier) {
  const id = identifier
           || request.headers.get('CF-Connecting-IP')
           || request.headers.get('X-Forwarded-For')
           || 'unknown';
  const windowId = Math.floor(Date.now() / 1000 / windowSecs);
  const rlKey    = key + '_' + id + '_' + windowId;
  const now      = Math.floor(Date.now() / 1000);

  try {
    const row = await db.prepare(
      'SELECT count FROM auth_rate_limits WHERE key=?'
    ).bind(rlKey).first();

    const count = row ? row.count : 0;
    if (count >= max) return false;

    await db.prepare(
      'INSERT INTO auth_rate_limits (key, count, created_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1'
    ).bind(rlKey, now).run();

    // Prune keys older than 2 windows to keep the table lean
    await db.prepare(
      'DELETE FROM auth_rate_limits WHERE created_at < ?'
    ).bind(now - windowSecs * 2).run();

    return true;
  } catch {
    return true; // fail open — never block a real user due to DB errors
  }
}
