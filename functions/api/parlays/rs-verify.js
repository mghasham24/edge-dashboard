// functions/api/parlays/rs-verify.js
// GET  /api/parlays/rs-verify   → returns current user's RS verification status
// POST /api/parlays/rs-verify   → submits a 6-digit code to link RS account

import { getSession } from '../../_lib/session.js';
import { ok, err }    from '../../_lib/response.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);

  const row = await env.DB.prepare(
    'SELECT parlay_verified, rs_username, rs_user_id FROM real_auth WHERE user_id=?'
  ).bind(session.user_id).first();

  return ok({
    verified:    row?.parlay_verified === 1,
    rsUsername:  row?.rs_username  || null,
    rsUserId:    row?.rs_user_id   || null,
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const session = await getSession(request, env.DB);
    if (!session) return err('Unauthorized', 401);

    let body;
    try { body = await request.json(); } catch { return err('Invalid request body', 400); }

    const { code } = body;
    if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) {
      return err('Code must be 6 digits', 400);
    }

    const trimmed = code.trim();
    const now     = Math.floor(Date.now() / 1000);

    const codeRow = await env.DB.prepare(
      'SELECT rs_user_id, rs_username, channel_id FROM rs_verify_codes WHERE code=? AND expires_at>?'
    ).bind(trimmed, now).first();

    if (!codeRow) return err('Invalid or expired code — check the code and try again', 400);

    // Link RS account to this RaxEdge user — UPSERT to avoid race between UPDATE+INSERT
    // Also write dm_channel_id here — the earlier UPDATE in rs-verify-poll fires before this row
    // exists, so it hits 0 rows. Storing it now guarantees win-notify can reach the user.
    await env.DB.prepare(
      `INSERT INTO real_auth (user_id, auth_token, rs_user_id, rs_username, parlay_verified, parlay_verified_at, dm_channel_id, updated_at)
       VALUES (?, '', ?, ?, 1, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         rs_user_id         = excluded.rs_user_id,
         rs_username        = excluded.rs_username,
         parlay_verified    = 1,
         parlay_verified_at = excluded.parlay_verified_at,
         dm_channel_id      = COALESCE(excluded.dm_channel_id, real_auth.dm_channel_id),
         updated_at         = excluded.updated_at`
    ).bind(session.user_id, codeRow.rs_user_id, codeRow.rs_username, now, codeRow.channel_id || null, now).run();

    // Consume the code — one-time use
    await env.DB.prepare('DELETE FROM rs_verify_codes WHERE code=?').bind(trimmed).run();

    return ok({
      verified:   true,
      rsUsername: codeRow.rs_username,
      rsUserId:   codeRow.rs_user_id,
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: 'Server error: ' + e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
