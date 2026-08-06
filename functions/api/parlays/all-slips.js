// GET /api/parlays/all-slips — admin only
// Returns all users' parlays with legs + rs_username for admin oversight tab.
import { getSession } from '../../_lib/session.js';
import { ok, err }    from '../../_lib/response.js';
import { rsUrlEncode } from '../../_lib/hashids.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Authentication required', 401);

  const user = await env.DB.prepare(
    'SELECT is_admin FROM users WHERE id = ?'
  ).bind(session.user_id).first();

  if (!user || !user.is_admin) return err('Forbidden', 403);

  const now = Math.floor(Date.now() / 1000);
  const pendingCutoff = now - 1800;

  const { results: parlays } = await env.DB.prepare(
    'SELECT id, user_id, rs_username, status, legs_count, stake_rax, payout_rax, deposit_card_id, ' +
    'rs_offer_id, received_rax, expires_at, created_at, deposited_at, settled_at ' +
    'FROM parlays ' +
    "WHERE status NOT IN ('expired', 'voided') " +
    "AND NOT (status = 'pending_deposit' AND created_at < ?) " +
    'ORDER BY created_at DESC LIMIT 100'
  ).bind(pendingCutoff).all();

  if (!parlays.length) return ok({ slips: [] });

  const { results: legs } = await env.DB.prepare(
    'SELECT pl.id, pl.parlay_id, pl.player_name, pl.label, pl.threshold, pl.direction, ' +
    'pl.american_odds, pl.status, pl.result_value, pl.market_type, pl.headshot_url, pl.game_date, pl.event_name ' +
    'FROM parlay_legs pl ' +
    'WHERE pl.parlay_id IN (' +
    "  SELECT id FROM parlays WHERE status NOT IN ('expired','voided') AND NOT (status='pending_deposit' AND created_at<?) " +
    '  ORDER BY created_at DESC LIMIT 100' +
    ') ORDER BY pl.id ASC'
  ).bind(pendingCutoff).all();

  const legMap = {};
  for (const leg of legs) {
    if (!legMap[leg.parlay_id]) legMap[leg.parlay_id] = [];
    legMap[leg.parlay_id].push(leg);
  }

  return ok({ slips: parlays.map(p => ({
    ...p,
    legs: legMap[p.id] || [],
    deposit_card_url: (p.status === 'pending_deposit' && p.deposit_card_id)
      ? 'https://www.realapp.com/' + rsUrlEncode(20, 0, 0, p.deposit_card_id)
      : null,
  })) });
}
