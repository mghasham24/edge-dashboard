// GET /api/parlays/all-slips — admin only
// Default: returns 300 most recent parlays.
// With ?q=username: searches all parlays by rs_username (up to 200 results).
import { getSession } from '../../_lib/session.js';
import { ok, err }    from '../../_lib/response.js';
import { rsUrlEncode } from '../../_lib/hashids.js';

function generateShareToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Authentication required', 401);

  const user = await env.DB.prepare(
    'SELECT is_admin FROM users WHERE id = ?'
  ).bind(session.user_id).first();

  if (!user || !user.is_admin) return err('Forbidden', 403);

  const url          = new URL(request.url);
  const searchQuery  = (url.searchParams.get('q') || '').trim();
  const now          = Math.floor(Date.now() / 1000);
  const pendingCutoff = now - 1800;

  let parlays, legs;

  if (searchQuery) {
    // Server-side username search — scans all parlays, no recency filter
    const like = '%' + searchQuery + '%';
    ({ results: parlays } = await env.DB.prepare(
      'SELECT id, user_id, rs_username, status, legs_count, stake_rax, payout_rax, deposit_card_id, ' +
      'rs_offer_id, received_rax, expires_at, created_at, deposited_at, settled_at, share_token ' +
      'FROM parlays ' +
      'WHERE rs_username LIKE ? ' +
      'ORDER BY created_at DESC LIMIT 200'
    ).bind(like).all());

    if (!parlays.length) return ok({ slips: [], searched: true });

    const ids = parlays.map(p => p.id).join(',');
    ({ results: legs } = await env.DB.prepare(
      'SELECT pl.id, pl.parlay_id, pl.player_name, pl.label, pl.threshold, pl.direction, ' +
      'pl.american_odds, pl.status, pl.result_value, pl.market_type, pl.headshot_url, pl.game_date, pl.event_name, pl.sport, pl.game_start_ms, pl.team ' +
      'FROM parlay_legs pl ' +
      'WHERE pl.parlay_id IN (' + ids + ') ORDER BY pl.id ASC'
    ).all());
  } else {
    // Default: 300 most recent non-expired-pending parlays
    ({ results: parlays } = await env.DB.prepare(
      'SELECT id, user_id, rs_username, status, legs_count, stake_rax, payout_rax, deposit_card_id, ' +
      'rs_offer_id, received_rax, expires_at, created_at, deposited_at, settled_at, share_token ' +
      'FROM parlays ' +
      "WHERE NOT (status = 'pending_deposit' AND created_at < ?) " +
      'ORDER BY created_at DESC LIMIT 300'
    ).bind(pendingCutoff).all());

    if (!parlays.length) return ok({ slips: [] });

    ({ results: legs } = await env.DB.prepare(
      'SELECT pl.id, pl.parlay_id, pl.player_name, pl.label, pl.threshold, pl.direction, ' +
      'pl.american_odds, pl.status, pl.result_value, pl.market_type, pl.headshot_url, pl.game_date, pl.event_name, pl.sport, pl.game_start_ms, pl.team ' +
      'FROM parlay_legs pl ' +
      'WHERE pl.parlay_id IN (' +
      "  SELECT id FROM parlays WHERE NOT (status='pending_deposit' AND created_at<?) " +
      '  ORDER BY created_at DESC LIMIT 300' +
      ') ORDER BY pl.id ASC'
    ).bind(pendingCutoff).all());
  }

  // Lazy share_token generation for slips that predate migration 0009
  const needsToken = parlays.filter(p => !p.share_token && ['active','won','lost'].includes(p.status));
  if (needsToken.length) {
    needsToken.forEach(p => { p.share_token = generateShareToken(); });
    await env.DB.batch(needsToken.map(p =>
      env.DB.prepare('UPDATE parlays SET share_token=? WHERE id=? AND share_token IS NULL').bind(p.share_token, p.id).run()
    ));
  }

  const legMap = {};
  for (const leg of legs) {
    if (!legMap[leg.parlay_id]) legMap[leg.parlay_id] = [];
    legMap[leg.parlay_id].push(leg);
  }

  return ok({ slips: parlays.map(p => ({
    ...p,
    legs: legMap[p.id] || [],
    deposit_card_url: (p.deposit_card_id && !['expired','void','voided'].includes(p.status))
      ? 'https://www.realapp.com/' + rsUrlEncode(20, 0, 0, p.deposit_card_id)
      : null,
  })) });
}
