// functions/api/parlays/place.js
// POST /api/parlays/place
// Validates parlay slip, assigns deposit card, writes parlays + parlay_legs to D1.
// Returns deposit card URL and 30-min expiry window.
import { getSession }     from '../../_lib/session.js';
import { ok, err }        from '../../_lib/response.js';
import { rsUrlEncode }    from '../../_lib/hashids.js';
import { checkRateLimit } from '../../_lib/rateLimit.js';

function impliedProb(odds) {
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

// Unix timestamp for midnight ET today (handles EDT/EST automatically)
function etTodayStart() {
  const d = new Date();
  const etDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
  const utcH = d.getUTCHours();
  const etH  = parseInt(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }).format(d), 10);
  const offset = ((utcH - etH) + 24) % 24; // 4 = EDT, 5 = EST
  const [y, m, da] = etDateStr.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, da, offset) / 1000);
}

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Authentication required', 401);

  const user = await env.DB.prepare(
    'SELECT u.id, u.plan, u.is_admin, u.pro_expires_at, ra.rs_username ' +
    'FROM users u LEFT JOIN real_auth ra ON ra.user_id = u.id WHERE u.id = ?'
  ).bind(session.user_id).first();

  if (!user) return err('User not found', 404);

  const now = Math.floor(Date.now() / 1000);
  const isAdmin = user.is_admin === 1;
  if (!user.rs_username) return err('Connect your Real Sports account in Settings first', 400);

  // Rate limit: 5 place attempts per 60s per user
  if (!isAdmin) {
    const allowed = await checkRateLimit(env.DB, request, 'parlay_place', 5, 60, String(user.id));
    if (!allowed) return err('Too many requests — wait a moment before placing another parlay.', 429);
  }

  // Idempotency: block double-tap within 5 seconds
  const recentSlip = await env.DB.prepare(
    "SELECT id FROM parlays WHERE user_id=? AND status='pending_deposit' AND created_at>=?"
  ).bind(user.id, now - 5).first();
  if (recentSlip) return err('A slip was just placed — wait a moment before placing another.', 429);

  let body;
  try { body = await request.json(); } catch { return err('Invalid request body', 400); }

  const { stake, legs } = body;

  if (!Number.isInteger(stake) || stake < 100) return err('Minimum stake is 100 Rax', 400);
  if (stake > 50000) return err('Maximum stake is 50,000 Rax', 400);

  if (!Array.isArray(legs) || legs.length < 2 || legs.length > 5) {
    return err('Select 2–5 players', 400);
  }

  // Validate + normalize each leg
  const normalized = [];
  for (const leg of legs) {
    if (!leg.playerName || !leg.direction || !leg.marketType) {
      return err('Missing required leg fields', 400);
    }
    if (!['more', 'less'].includes(leg.direction)) return err('Invalid direction', 400);

    // Reject legs from games that have already started
    const startMs = typeof leg.startMs === 'number' ? leg.startMs : 0;
    if (startMs > 0 && startMs < Date.now()) {
      return err(leg.playerName + '\'s game has already started — picks are locked.', 400);
    }

    const odds = typeof leg.americanOdds === 'number' ? leg.americanOdds : null;
    if (odds === null || !Number.isInteger(odds) || odds === 0) return err('Invalid odds on ' + leg.playerName, 400);

    const prob = typeof leg.impliedProb === 'number' ? leg.impliedProb : impliedProb(odds);
    if (prob <= 0 || prob >= 1) return err('Invalid probability on ' + leg.playerName, 400);

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const gameDate = leg.gameDate || today;

    const VALID_SPORTS = ['mlb', 'wnba', 'nfl', 'ufc'];
    const legSport = VALID_SPORTS.includes(leg.sport) ? leg.sport : 'mlb';

    normalized.push({
      sport:       legSport,
      eventId:     leg.eventId    || ('mock_' + leg.playerName.replace(/[^a-z0-9]/gi, '_')),
      eventName:   leg.eventName  || (leg.playerName + ' · ' + leg.marketType),
      gameDate,
      subcatId:    leg.subcatId   || 0,
      marketType:  leg.marketType,
      marketId:    leg.marketId   || 'mock_market',
      selectionId: leg.selectionId || ('mock_' + leg.direction),
      playerName:  leg.playerName,
      label:       leg.label || ((leg.direction === 'more' ? '▲ More ' : '▼ Less ') + (leg.threshold || '')),
      threshold:   leg.threshold  ?? null,
      direction:   leg.direction,
      americanOdds: odds,
      impliedProb:  prob,
      headshotUrl: leg.headshot || null,
      team:        typeof leg.team === 'string' ? leg.team.slice(0, 10) : null,
    });
  }

  // At least 2 different teams required
  const legTeams = normalized.map(l => l.team).filter(Boolean);
  if (legTeams.length >= normalized.length) {
    const uniqueTeams = new Set(legTeams);
    if (uniqueTeams.size < 2) return err('Picks must be from at least 2 different teams', 400);
  }

  // Payout math
  const trueProb  = normalized.reduce((acc, l) => acc * l.impliedProb, 1);
  const payoutRax = Math.min(Math.floor(stake * 0.70 / trueProb), 10000);

  // Daily caps (admins bypass)
  if (!isAdmin) {
    const todayStart = etTodayStart();
    const [exposureRow, userPayoutRow] = await Promise.all([
      // House net loss today: sum(won payouts) - sum(lost stakes) for settled slips
      env.DB.prepare(
        "SELECT COALESCE(SUM(CASE WHEN status='won' THEN payout_rax ELSE -stake_rax END),0) AS net_loss " +
        "FROM parlays WHERE created_at >= ? AND status IN ('won','lost')"
      ).bind(todayStart).first(),
      // User's total winnings today
      env.DB.prepare(
        "SELECT COALESCE(SUM(payout_rax),0) AS won_today FROM parlays " +
        "WHERE user_id=? AND status='won' AND created_at>=?"
      ).bind(user.id, todayStart).first(),
    ]);

    if ((exposureRow?.net_loss || 0) >= 100000) {
      return err('Parlays are temporarily unavailable — daily limit reached. Try again tomorrow.', 503);
    }

    const wonToday = userPayoutRow?.won_today || 0;
    if (wonToday + payoutRax > 20000) {
      const remaining = Math.max(0, 20000 - wonToday);
      return err(
        remaining > 0
          ? 'Daily payout limit: you can win up to ' + remaining.toLocaleString() + ' more Rax today.'
          : 'Daily payout limit reached. Try again tomorrow.',
        400
      );
    }
  }

  // Grab available deposit card
  const cardRow = await env.DB.prepare(
    'SELECT card_id FROM deposit_cards WHERE assigned_to_parlay_id IS NULL LIMIT 1'
  ).first();
  if (!cardRow) return err('No deposit cards available — contact support', 503);

  const cardId    = cardRow.card_id;
  const expiresAt = now + 30 * 60;

  // Derive parlay-level sport from legs (use most common, or first)
  const sportCounts = {};
  for (const l of normalized) { sportCounts[l.sport] = (sportCounts[l.sport] || 0) + 1; }
  const parlayS = Object.entries(sportCounts).sort((a, b) => b[1] - a[1])[0][0];

  // Insert parlay row
  const parlayRes = await env.DB.prepare(
    'INSERT INTO parlays (user_id, sport, legs_count, stake_rax, true_prob, payout_rax, ' +
    'deposit_card_id, rs_username, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    user.id, parlayS, normalized.length, stake,
    trueProb, payoutRax, cardId, user.rs_username, expiresAt, now
  ).run();

  const parlayId = parlayRes.meta.last_row_id;

  // Atomically assign the card to this parlay
  const lockRes = await env.DB.prepare(
    'UPDATE deposit_cards SET assigned_to_parlay_id = ?, assigned_at = ? ' +
    'WHERE card_id = ? AND assigned_to_parlay_id IS NULL'
  ).bind(parlayId, now, cardId).run();

  if (lockRes.meta.changes === 0) {
    // Race: someone else grabbed this card — clean up and try once more
    await env.DB.prepare('DELETE FROM parlays WHERE id = ?').bind(parlayId).run();
    const retry = await env.DB.prepare(
      'SELECT card_id FROM deposit_cards WHERE assigned_to_parlay_id IS NULL LIMIT 1'
    ).first();
    if (!retry) return err('No deposit cards available — try again shortly', 503);

    // Re-insert with the new card
    const retry2 = await env.DB.prepare(
      'INSERT INTO parlays (user_id, sport, legs_count, stake_rax, true_prob, payout_rax, ' +
      'deposit_card_id, rs_username, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      user.id, parlayS, normalized.length, stake,
      trueProb, payoutRax, retry.card_id, user.rs_username, expiresAt, now
    ).run();

    const newParlayId = retry2.meta.last_row_id;
    await env.DB.prepare(
      'UPDATE deposit_cards SET assigned_to_parlay_id = ?, assigned_at = ? WHERE card_id = ?'
    ).bind(newParlayId, now, retry.card_id).run();

    return placeLegsAndRespond(env.DB, newParlayId, retry.card_id, normalized, stake, payoutRax, expiresAt, user.rs_username, now);
  }

  return placeLegsAndRespond(env.DB, parlayId, cardId, normalized, stake, payoutRax, expiresAt, user.rs_username, now);
}

async function placeLegsAndRespond(db, parlayId, cardId, legs, stake, payoutRax, expiresAt, rsUsername, now) {
  await db.batch(legs.map(leg =>
    db.prepare(
      'INSERT INTO parlay_legs (parlay_id, sport, event_id, event_name, game_date, subcat_id, ' +
      'market_type, market_id, selection_id, player_name, label, threshold, direction, ' +
      'american_odds, implied_prob, headshot_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      parlayId, leg.sport,
      leg.eventId, leg.eventName, leg.gameDate, leg.subcatId,
      leg.marketType, leg.marketId, leg.selectionId, leg.playerName,
      leg.label, leg.threshold, leg.direction, leg.americanOdds, leg.impliedProb,
      leg.headshotUrl
    )
  ));

  const mult = (0.70 / legs.reduce((a, l) => a * l.impliedProb, 1)).toFixed(2);

  return ok({
    parlayId,
    depositCardId:  cardId,
    depositCardUrl: 'https://www.realapp.com/' + rsUrlEncode(20, 0, 0, cardId),
    expiresAt,
    payoutRax,
    stake,
    legs:           legs.length,
    multiplier:     mult,
    rsUsername,
    instruction:    'Open the deposit card on Real Sports and send @edgebot an offer for exactly ' + stake + ' Rax. You have 30 minutes.',
  });
}
