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

  let parlays = [], legs = [];
  const CHUNK = 99; // D1 max bound parameters per statement

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

    const searchIds = parlays.map(p => p.id);
    const searchChunks = [];
    for (let i = 0; i < searchIds.length; i += CHUNK) searchChunks.push(searchIds.slice(i, i + CHUNK));
    const searchLegResults = await Promise.all(searchChunks.map(chunk => {
      const ph = chunk.map(() => '?').join(',');
      return env.DB.prepare(
        'SELECT pl.id, pl.parlay_id, pl.player_name, pl.label, pl.threshold, pl.direction, ' +
        'pl.american_odds, pl.status, pl.result_value, pl.market_type, pl.headshot_url, pl.game_date, pl.event_name, pl.sport, pl.game_start_ms, pl.team ' +
        `FROM parlay_legs pl WHERE pl.parlay_id IN (${ph}) ORDER BY pl.id ASC`
      ).bind(...chunk).all();
    }));
    legs = searchLegResults.flatMap(r => r.results || []);
  } else {
    // Two queries merged:
    // 1. All void/expired/voided slips (no limit — admin needs to see every cancelled/expired slip)
    // 2. Active slips (no limit — always show all), + top 300 recent others
    const SEL = 'SELECT id, user_id, rs_username, status, legs_count, stake_rax, payout_rax, deposit_card_id, rs_offer_id, received_rax, expires_at, created_at, deposited_at, settled_at, share_token FROM parlays';
    const [{ results: terminalSlips }, { results: activeSlips }, { results: recentSlips }] = await Promise.all([
      env.DB.prepare(SEL + " WHERE status IN ('void','expired','voided') ORDER BY created_at DESC").all(),
      env.DB.prepare(SEL + " WHERE status = 'active' ORDER BY created_at DESC").all(),
      env.DB.prepare(
        SEL + " WHERE status NOT IN ('void','expired','voided','active') " +
        "AND NOT (status='pending_deposit' AND expires_at < ?) " +
        'ORDER BY created_at DESC LIMIT 300'
      ).bind(now).all(),
    ]);

    // Merge, deduplicate by id, sort newest first
    const seenIds = new Set();
    parlays = [];
    for (const p of [...activeSlips, ...recentSlips, ...terminalSlips]) {
      if (!seenIds.has(p.id)) { seenIds.add(p.id); parlays.push(p); }
    }
    parlays.sort((a, b) => b.created_at - a.created_at);

    if (!parlays.length) return ok({ slips: [] });

    const allIds = parlays.map(p => p.id);
    const legChunks = [];
    for (let i = 0; i < allIds.length; i += CHUNK) legChunks.push(allIds.slice(i, i + CHUNK));
    const legResults = await Promise.all(legChunks.map(chunk => {
      const ph = chunk.map(() => '?').join(',');
      return env.DB.prepare(
        'SELECT pl.id, pl.parlay_id, pl.player_name, pl.label, pl.threshold, pl.direction, ' +
        'pl.american_odds, pl.status, pl.result_value, pl.market_type, pl.headshot_url, pl.game_date, pl.event_name, pl.sport, pl.game_start_ms, pl.team ' +
        `FROM parlay_legs pl WHERE pl.parlay_id IN (${ph}) ORDER BY pl.id ASC`
      ).bind(...chunk).all();
    }));
    legs = legResults.flatMap(r => r.results || []);
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
