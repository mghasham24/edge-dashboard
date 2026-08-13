// GET /api/parlays/my-slips
// Returns the authenticated user's last 20 parlays with nested legs.
import { getSession }   from '../../_lib/session.js';
import { ok, err }      from '../../_lib/response.js';
import { rsUrlEncode }  from '../../_lib/hashids.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Authentication required', 401);

  const now = Math.floor(Date.now() / 1000);
  const pendingCutoff = now - 7200; // hide pending_deposit older than 2 h (matches deposit-check 90-min expiry buffer)

  const { results: parlays } = await env.DB.prepare(
    'SELECT id, status, legs_count, stake_rax, payout_rax, deposit_card_id, ' +
    'rs_offer_id, received_rax, expires_at, created_at, deposited_at, settled_at ' +
    'FROM parlays WHERE user_id = ? ' +
    "AND status NOT IN ('expired', 'void', 'voided') " +
    "AND NOT (status = 'pending_deposit' AND created_at < ?) " +
    "ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending_deposit' THEN 1 ELSE 2 END, created_at DESC LIMIT 20"
  ).bind(session.user_id, pendingCutoff).all();

  if (!parlays.length) return ok({ slips: [] });

  // Use subquery to avoid spreading N bind params — more reliable in D1 runtime
  const { results: legs } = await env.DB.prepare(
    'SELECT pl.id, pl.parlay_id, pl.player_name, pl.label, pl.threshold, pl.direction, ' +
    'pl.american_odds, pl.status, pl.result_value, pl.market_type, pl.headshot_url, pl.game_date, pl.event_name, pl.sport, pl.game_start_ms ' +
    'FROM parlay_legs pl ' +
    'WHERE pl.parlay_id IN (' +
    "  SELECT id FROM parlays WHERE user_id = ? AND status NOT IN ('expired','void','voided') AND NOT (status='pending_deposit' AND created_at<?) " +
    "  ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending_deposit' THEN 1 ELSE 2 END, created_at DESC LIMIT 20" +
    ') ORDER BY pl.id ASC'
  ).bind(session.user_id, pendingCutoff).all();

  const legMap = {};
  for (const leg of legs) {
    if (!legMap[leg.parlay_id]) legMap[leg.parlay_id] = [];
    legMap[leg.parlay_id].push(leg);
  }

  const debugMode = new URL(request.url).searchParams.has('debug');
  if (debugMode) {
    return new Response(JSON.stringify({ parlayIds: parlays.map(p => p.id), legCount: legs.length, legs }), { headers: { 'Content-Type': 'application/json' } });
  }

  return ok({ slips: parlays.map(p => ({
    ...p,
    legs: legMap[p.id] || [],
    deposit_card_url: (p.status === 'pending_deposit' && p.deposit_card_id)
      ? 'https://www.realapp.com/' + rsUrlEncode(20, 0, 0, p.deposit_card_id)
      : null,
  })) });
}
