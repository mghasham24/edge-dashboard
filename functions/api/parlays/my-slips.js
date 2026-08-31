// GET /api/parlays/my-slips?page=N
// Returns the authenticated user's parlays (20 per page) with nested legs.
import { getSession }   from '../../_lib/session.js';
import { ok, err }      from '../../_lib/response.js';
import { rsUrlEncode }  from '../../_lib/hashids.js';

function generateShareToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Authentication required', 401);

  const url    = new URL(request.url);
  const page   = Math.max(0, parseInt(url.searchParams.get('page') || '0', 10));
  const limit  = 20;
  const offset = page * limit;

  const now = Math.floor(Date.now() / 1000);

  // Hide pending_deposit slips only once expires_at has passed (not on a fixed 2h created_at window).
  // This ensures users can still see their slip if they sent a deposit and deposit-check is slow.
  const WHERE =
    "user_id = ? AND status NOT IN ('expired','void','voided') " +
    "AND NOT (status='pending_deposit' AND expires_at < ?)";
  const ORDER =
    "ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending_deposit' THEN 1 ELSE 2 END, created_at DESC";

  // Total count for pagination
  const { results: [countRow] } = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM parlays WHERE ${WHERE}`
  ).bind(session.user_id, now).all();
  const total = countRow?.cnt ?? 0;

  const { results: parlays } = await env.DB.prepare(
    'SELECT id, status, legs_count, stake_rax, payout_rax, deposit_card_id, ' +
    'rs_offer_id, received_rax, is_free_play, expires_at, created_at, deposited_at, settled_at, share_token ' +
    `FROM parlays WHERE ${WHERE} ${ORDER} LIMIT ? OFFSET ?`
  ).bind(session.user_id, now, limit, offset).all();

  const userRow = await env.DB.prepare(
    'SELECT free_play_credits FROM users WHERE id=?'
  ).bind(session.user_id).first();

  if (!parlays.length) return ok({ slips: [], total, page, freePlayCredits: userRow?.free_play_credits ?? 0 });

  const ids = parlays.map(p => p.id);
  const placeholders = ids.map(() => '?').join(',');
  const { results: legs } = await env.DB.prepare(
    'SELECT pl.id, pl.parlay_id, pl.player_name, pl.label, pl.threshold, pl.direction, ' +
    'pl.american_odds, pl.status, pl.result_value, pl.market_type, pl.headshot_url, pl.game_date, pl.event_name, pl.sport, pl.game_start_ms, pl.rs_game_id, pl.event_id, pl.team ' +
    `FROM parlay_legs pl WHERE pl.parlay_id IN (${placeholders}) ORDER BY pl.id ASC`
  ).bind(...ids).all();

  const legMap = {};
  for (const leg of legs) {
    if (!legMap[leg.parlay_id]) legMap[leg.parlay_id] = [];
    legMap[leg.parlay_id].push(leg);
  }

  const debugMode = url.searchParams.has('debug');
  if (debugMode) {
    return new Response(JSON.stringify({ parlayIds: parlays.map(p => p.id), legCount: legs.length, legs }), { headers: { 'Content-Type': 'application/json' } });
  }

  // Lazy-generate share tokens for existing slips that don't have one
  const tokenUpdates = parlays.filter(p => !p.share_token).map(p => {
    const token = generateShareToken();
    p.share_token = token;
    return env.DB.prepare('UPDATE parlays SET share_token=? WHERE id=? AND share_token IS NULL').bind(token, p.id).run();
  });
  if (tokenUpdates.length) await Promise.allSettled(tokenUpdates);

  return ok({
    slips: parlays.map(p => ({
      ...p,
      legs: legMap[p.id] || [],
      share_token: p.share_token || null,
      deposit_card_url: (p.status === 'pending_deposit' && p.deposit_card_id)
        ? 'https://www.realapp.com/' + rsUrlEncode(20, 0, 0, p.deposit_card_id)
        : null,
    })),
    total,
    page,
    freePlayCredits: userRow?.free_play_credits ?? 0,
  });
}
