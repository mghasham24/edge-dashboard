// GET /api/parlays/slip-public?token={share_token}
// Public — no auth required. Returns slip data for the shareable slip page.
// Cancelled and voided slips return 404.

export async function onRequestGet({ request, env }) {
  const token = new URL(request.url).searchParams.get('token');
  if (!token || !/^[A-Za-z0-9]{8,20}$/.test(token))
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

  const parlay = await env.DB.prepare(
    'SELECT p.id, p.status, p.legs_count, p.stake_rax, p.payout_rax, p.is_free_play, ' +
    'p.created_at, p.deposited_at, p.settled_at, ' +
    'ra.rs_username, ra.rs_avatar_url ' +
    'FROM parlays p ' +
    'JOIN real_auth ra ON ra.user_id = p.user_id ' +
    'WHERE p.share_token = ?'
  ).bind(token).first();

  if (!parlay) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  if (['cancelled', 'voided'].includes(parlay.status))
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

  const { results: legs } = await env.DB.prepare(
    'SELECT player_name, label, direction, threshold, american_odds, status, market_type, sport, headshot_url ' +
    'FROM parlay_legs WHERE parlay_id = ? ORDER BY id ASC'
  ).bind(parlay.id).all();

  const payload = JSON.stringify({
    rs_username:   parlay.rs_username,
    rs_avatar_url: parlay.rs_avatar_url || null,
    status:        parlay.status,
    legs_count:    parlay.legs_count,
    stake_rax:     parlay.stake_rax,
    payout_rax:    parlay.payout_rax,
    is_free_play:  parlay.is_free_play,
    created_at:    parlay.created_at,
    deposited_at:  parlay.deposited_at,
    settled_at:    parlay.settled_at,
    legs,
  });

  return new Response(payload, {
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': 'public, max-age=30',
    },
  });
}
