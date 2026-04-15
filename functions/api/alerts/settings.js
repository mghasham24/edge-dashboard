// functions/api/alerts/settings.js
// GET  → return current alert settings for the authenticated user
// POST → update settings (min_ev, sports, enabled)

const VALID_SPORTS = new Set([
  'basketball_nba', 'icehockey_nhl', 'baseball_mlb',
  'basketball_ncaab', 'mma_mixed_martial_arts', 'soccer_fc'
]);

async function getSession(request, db) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return null;
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    'SELECT u.id as user_id, u.plan, u.is_admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(m[1], now).first();
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequest({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');
  if (session.plan !== 'pro' && !session.is_admin) return fail(403, 'Pro plan required');

  if (request.method === 'GET') {
    const row = await env.DB.prepare(
      'SELECT telegram_chat_id, telegram_verified, enabled, min_ev, sports, one_side, unit_size FROM notification_settings WHERE user_id=?'
    ).bind(session.user_id).first();

    return new Response(JSON.stringify({
      ok: true,
      settings: row ? {
        verified:   row.telegram_verified === 1,
        enabled:    row.enabled === 1,
        min_ev:     row.min_ev,
        sports:     row.sports,
        one_side:   row.one_side === 1,
        unit_size:  row.unit_size ?? 100
      } : {
        verified:  false,
        enabled:   true,
        min_ev:    5.0,
        sports:    'ALL',
        one_side:  false,
        unit_size: 100
      }
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); }
    catch { return fail(400, 'Invalid JSON'); }

    const { min_ev, sports, enabled, one_side, unit_size } = body;

    // Validate min_ev
    if (min_ev !== undefined) {
      const ev = parseFloat(min_ev);
      if (!isFinite(ev) || ev < 1 || ev > 50) return fail(400, 'min_ev must be between 1 and 50');
    }

    // Validate sports: 'ALL' or comma-separated list of valid sport keys
    if (sports !== undefined && sports !== 'ALL') {
      const list = String(sports).split(',').map(s => s.trim());
      for (const s of list) {
        if (!VALID_SPORTS.has(s)) return fail(400, 'Invalid sport: ' + s);
      }
    }

    // Validate unit_size
    if (unit_size !== undefined) {
      const u = parseFloat(unit_size);
      if (!isFinite(u) || u < 1 || u > 100000) return fail(400, 'unit_size must be between 1 and 100000');
    }

    const now = Math.floor(Date.now() / 1000);

    // Upsert — preserve telegram linkage, only update prefs
    await env.DB.prepare(`
      INSERT INTO notification_settings (user_id, enabled, min_ev, sports, one_side, unit_size, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        enabled    = COALESCE(excluded.enabled,    enabled),
        min_ev     = COALESCE(excluded.min_ev,     min_ev),
        sports     = COALESCE(excluded.sports,     sports),
        one_side   = COALESCE(excluded.one_side,   one_side),
        unit_size  = COALESCE(excluded.unit_size,  unit_size),
        updated_at = excluded.updated_at
    `).bind(
      session.user_id,
      enabled   !== undefined ? (enabled ? 1 : 0)    : null,
      min_ev    !== undefined ? parseFloat(min_ev)    : null,
      sports    !== undefined ? String(sports)        : null,
      one_side  !== undefined ? (one_side ? 1 : 0)   : null,
      unit_size !== undefined ? parseFloat(unit_size) : null,
      now
    ).run();

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return fail(405, 'Method not allowed');
}
