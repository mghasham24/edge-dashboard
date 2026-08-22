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

// Only assign cards confirmed owned by edgebot within the last 15 minutes.
// Reconcile runs every 2 min — this survives ~7 consecutive failures before blocking.
const VERIFY_MAX_AGE = 15 * 60;
const EDGEBOT_USER   = 'V3yGgkkJ';
const RS_DEVICE_UUID = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';

// Returns true (edgebot owns it), false (someone else owns it), null (can't verify — trust verified_at).
async function verifyEdgebotOwns(cardId, authInfo, sessionToken) {
  try {
    const res = await fetch(`https://web.realapp.com/collectingcards/${cardId}`, {
      headers: {
        'Accept':             'application/json',
        'real-auth-info':     authInfo,
        'real-session-token': sessionToken || '',
        'real-device-uuid':   RS_DEVICE_UUID,
        'real-device-type':   'desktop_web',
        'real-version':       '35',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const uid  = data.card?.userId ?? data.userId ?? null;
    if (uid === null) return null;
    return uid === EDGEBOT_USER;
  } catch { return null; }
}

// Pick a verified, unassigned card (up to 3 attempts).
// If a card fails the ownership check it is removed from the pool and the next one is tried.
// Returns card_id or null when none are available.
async function pickCard(env, now) {
  const excluded = [];
  for (let i = 0; i < 3; i++) {
    const notIn = excluded.length
      ? ' AND card_id NOT IN (' + excluded.map(() => '?').join(',') + ')'
      : '';
    const row = await env.DB.prepare(
      'SELECT card_id FROM deposit_cards WHERE assigned_to_parlay_id IS NULL AND freed_at IS NULL AND verified_at > ?' +
      notIn + ' ORDER BY verified_at DESC LIMIT 1'
    ).bind(now - VERIFY_MAX_AGE, ...excluded).first();
    if (!row) break;

    if (env.EDGEBOT_AUTH_INFO) {
      const owned = await verifyEdgebotOwns(row.card_id, env.EDGEBOT_AUTH_INFO, env.EDGEBOT_SESSION_TOKEN || '');
      if (owned === false) {
        // Card confirmed not owned by edgebot — remove ghost from pool and try next
        await env.DB.prepare('DELETE FROM deposit_cards WHERE card_id=?').bind(row.card_id).run();
        excluded.push(row.card_id);
        continue;
      }
    }
    return row.card_id;
  }
  return null;
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
    // For team-market legs, derive sport from the team nickname so a leg placed
    // while on the wrong tab (e.g. WNBA tab + NFL team) is stored correctly.
    const TEAM_MARKETS = new Set(['team_ml', 'team_runline', 'team_total']);
    const NFL_NICKNAMES = new Set([
      'bears','bengals','bills','broncos','browns','buccaneers','cardinals','chargers',
      'chiefs','colts','commanders','cowboys','dolphins','eagles','falcons','49ers',
      'giants','jaguars','jets','lions','packers','panthers','patriots','raiders',
      'rams','ravens','saints','seahawks','steelers','texans','titans','vikings',
    ]);
    const WNBA_NICKNAMES = new Set([
      'aces','dream','fever','liberty','lynx','mercury','mystics','sky','sparks','storm','sun','wings',
    ]);
    let legSport = VALID_SPORTS.includes(leg.sport) ? leg.sport : 'mlb';
    if (TEAM_MARKETS.has(leg.marketType)) {
      // Always derive sport from team nickname for team-market legs.
      // Cardinals (MLB) and Giants (MLB) share nicknames with NFL teams — use sent sport as tiebreaker.
      const words = (leg.playerName || '').toLowerCase().split(/[\s@]+/);
      const isNfl  = words.some(w => NFL_NICKNAMES.has(w));
      const isWnba = words.some(w => WNBA_NICKNAMES.has(w));
      if (isWnba && !isNfl)                            legSport = 'wnba';
      else if (isNfl && !isWnba && leg.sport !== 'mlb') legSport = 'nfl'; // Cardinals/Giants MLB: trust 'mlb' from frontend
      else if (!isNfl && !isWnba)                       legSport = 'mlb';
      // else: ambiguous — legSport already set from leg.sport above
    }

    normalized.push({
      sport:       legSport,
      eventId:     leg.eventId    || ('mock_' + leg.playerName.replace(/[^a-z0-9]/gi, '_')),
      eventName:   leg.eventName  || (leg.playerName + ' · ' + leg.marketType),
      gameDate,
      gameStartMs: startMs > 0 ? startMs : null,
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

  // Block correlated same-game legs within each market group.
  const BATTER_MKTS  = new Set(['hits','total_bases','rbis','runs','hrbi','singles','stolen_bases','doubles','walks','home_runs']);
  const PITCHER_MKTS = new Set(['pitcher_ks','outs_ou','hits_allowed','er_allowed','bb_allowed','hwer']);
  // Basketball player props — same player, same game correlate across all stat categories.
  const BBALL_MKTS   = new Set(['points','assists','rebounds','steals','blocks','threes','turnovers','minutes']);

  function legGroup(mkt) {
    if (BATTER_MKTS.has(mkt))  return 'batter';
    if (PITCHER_MKTS.has(mkt)) return 'pitcher';
    if (BBALL_MKTS.has(mkt))   return 'bball_player';
    return null; // 1inn handled separately below
  }

  const groupGameCounts = {};
  for (const l of normalized) {
    const group = legGroup(l.marketType);
    if (!group) continue;
    // For batters: scope by game + team so two hitters from OPPOSITE teams are allowed.
    // Same-team batters share a lineup/pitcher → still blocked.
    const gameKey = l.eventName || l.eventId;
    const scopeKey = group === 'bball_player'
      ? (l.playerName || gameKey)
      : group === 'batter'
      ? (gameKey + ':' + (l.team || 'unk'))
      : gameKey;
    const key = group + ':' + scopeKey;
    groupGameCounts[key] = (groupGameCounts[key] || 0) + 1;
    if (groupGameCounts[key] > 1) {
      const label = group === 'batter' ? 'batter' : group === 'pitcher' ? 'pitcher' : 'player';
      return err('Cannot combine multiple ' + label + ' picks from the same game — picks are correlated.', 400);
    }
  }

  // 1st inning props: away team always bats top, home team always bats bottom.
  // Same-half 1st inning correlation block.
  // Each half-inning (top = away bats/home pitches, bottom = home bats/away pitches) is a single
  // shared event — any two markets from the same half of the same game are correlated.
  // Pitching markets (pitches, batters, Ks) belong to the OPPOSITE half from the pitcher's team:
  //   away pitcher throws in bottom; home pitcher throws in top.
  const INN1_PITCHING_MKTS = new Set(['1inn_pitches_ou','1inn_pitches_range','1inn_batters_ou','1inn_ks_exact']);
  const INN1_GAME_MKTS     = new Set(['1inn_ml','1inn_runs_ou','1inn_walks_ou']); // span both halves — unconstrained

  function get1innHalf(marketType, playerName, eventName) {
    if (INN1_GAME_MKTS.has(marketType)) return null; // game-level — no same-half restriction
    if (!eventName || !playerName) return null;
    const atIdx = eventName.indexOf('@');
    if (atIdx === -1) return null;
    const away = eventName.slice(0, atIdx).trim().toLowerCase();
    const home = eventName.slice(atIdx + 1).trim().toLowerCase();
    const pn   = playerName.trim().toLowerCase();
    const hitAway = away === pn || away.startsWith(pn) || pn.startsWith(away);
    const hitHome = home === pn || home.startsWith(pn) || pn.startsWith(home);
    if (!hitAway && !hitHome) return null; // unresolvable — be permissive
    const teamSide = (hitAway && !hitHome) ? 'away' : 'home';
    // Batting markets: away bats in top, home bats in bottom
    // Pitching markets: away pitcher throws in bottom, home pitcher throws in top — invert
    if (INN1_PITCHING_MKTS.has(marketType)) {
      return teamSide === 'away' ? 'bottom' : 'top';
    }
    return teamSide === 'away' ? 'top' : 'bottom';
  }

  const inn1ByGame = {};
  for (const l of normalized) {
    if (!l.marketType.startsWith('1inn_')) continue;
    const gameKey = l.eventName || l.eventId; // eventName ("PIT @ MIA") is consistent across DK subcats; eventId differs per subcat
    const half    = get1innHalf(l.marketType, l.playerName, l.eventName);
    if (!half) continue; // game-level or unresolvable — skip
    if (!inn1ByGame[gameKey]) inn1ByGame[gameKey] = {};
    if (inn1ByGame[gameKey][half]) {
      const label = half === 'top' ? 'top of 1st (away bats / home pitches)' : 'bottom of 1st (home bats / away pitches)';
      return err('Cannot combine multiple picks from the ' + label + ' — picks are correlated.', 400);
    }
    inn1ByGame[gameKey][half] = true;
  }

  // Cross-timeframe: any 1inn batting market (hits, HR, run yn/ou) correlates with full-game batter
  // props from the same game — 1st inning stats are a subset of the full-game totals.
  // Likewise 1inn pitching (ks_exact, batters_ou) correlates with full-game pitcher props.
  // 1inn ML correlates with full-game team ML (same game).
  const INN1_BAT_CROSS = new Set(['1inn_hits_ou','1inn_hits_exact','1inn_hr_yn','1inn_run_yn','1inn_runs_exact','1inn_runs_ou']);
  const INN1_PIT_CROSS = new Set(['1inn_ks_exact','1inn_batters_ou']);
  const inn1BatEids  = new Set();
  const inn1PitEids  = new Set();
  const inn1MlEids   = new Set();
  const inn1RunsEids = new Set();
  for (const l of normalized) {
    if (!l.marketType.startsWith('1inn_')) continue;
    const eid = l.eventName || l.eventId; // eventName is consistent across DK subcats
    if (!eid) continue;
    if (INN1_BAT_CROSS.has(l.marketType)) inn1BatEids.add(eid);
    if (INN1_PIT_CROSS.has(l.marketType)) inn1PitEids.add(eid);
    if (l.marketType === '1inn_ml')       inn1MlEids.add(eid);
    if (l.marketType === '1inn_runs_ou')  inn1RunsEids.add(eid);
  }
  // 1inn_ml + 1inn_runs_ou same game: PHI winning the inning guarantees runs were scored.
  for (const eid of inn1MlEids) {
    if (inn1RunsEids.has(eid)) return err('Cannot combine 1st inning ML with 1st inning Runs O/U from the same game — picks are correlated.', 400);
  }
  for (const l of normalized) {
    if (l.marketType.startsWith('1inn_')) continue;
    const eid = l.eventName || l.eventId;
    if (!eid) continue;
    // team_total (full game O/U runs) correlates with 1inn_runs_ou — add alongside BATTER_MKTS
    if ((BATTER_MKTS.has(l.marketType) || l.marketType === 'team_total') && inn1BatEids.has(eid)) {
      return err('Cannot combine 1st inning batting markets with full-game batter props from the same game — picks are correlated.', 400);
    }
    if (PITCHER_MKTS.has(l.marketType) && inn1PitEids.has(eid)) {
      return err('Cannot combine 1st inning pitching markets with full-game pitcher props from the same game — picks are correlated.', 400);
    }
    if (l.marketType === 'team_ml' && inn1MlEids.has(eid)) {
      return err('Cannot combine 1st inning ML with full-game moneyline from the same game — picks are correlated.', 400);
    }
  }

  // Block same-game ML/RL combos for the same team (correlated) or opposing teams (mutually exclusive).
  const teamMkts = new Set(['ml', 'rl']);
  const gameTeamLegs = normalized.filter(l => teamMkts.has(l.marketType) && (l.eventName || l.eventId));

  // Same team: ML + RL from the same game
  const sameTeamMlRl = {};
  for (const l of gameTeamLegs) {
    const key = (l.team || l.playerName || '') + ':' + (l.eventName || l.eventId);
    sameTeamMlRl[key] = (sameTeamMlRl[key] || 0) + 1;
    if (sameTeamMlRl[key] > 1) {
      return err('Cannot combine moneyline and run line for the same team — picks are correlated.', 400);
    }
  }

  // Opposing sides: two ML bets from the same game (one must always lose)
  const mlByGame = {};
  for (const l of normalized.filter(l => l.marketType === 'ml')) {
    const gameKey = l.eventName || l.eventId;
    mlByGame[gameKey] = (mlByGame[gameKey] || 0) + 1;
    if (mlByGame[gameKey] > 1) {
      return err('Cannot combine moneylines from the same game — one side must always lose.', 400);
    }
  }

  // UFC correlated parlay block: Fighter Win + Under rounds for the same fight.
  // If Fighter A wins quickly they also cover the under — the outcomes share the same event,
  // giving the bettor far better true odds than the parlay price implies.
  const ufcMlLegs    = normalized.filter(l => l.marketType === 'ufc_ml');
  const ufcUnderLegs = normalized.filter(l => l.marketType === 'ufc_total' && l.direction === 'less');
  for (const ml of ufcMlLegs) {
    const fighter = (ml.playerName || '').toLowerCase();
    for (const under of ufcUnderLegs) {
      const fight = (under.eventName || '').toLowerCase();
      if (fighter && fight && fight.includes(fighter)) {
        return err(
          'Correlated picks: ' + ml.playerName + ' Fighter Win + Under rounds are not combinable — a quick finish covers both.',
          400
        );
      }
    }
  }

  // Payout math — mirrors parlayCalcPayout() in the frontend exactly.
  // Hard cap: 10,000 Rax. Max stake formula ensures payout never exceeds 10k.
  // Parlays over 2.5x are docked 10 Rax to cover deposit card acquisition cost.
  const trueProb  = normalized.reduce((acc, l) => acc * l.impliedProb, 1);
  const rawPayout = Math.min(Math.floor(stake * 0.70 / trueProb), 10000);
  let payoutRax = Math.floor((rawPayout + 2) / 10) * 10;
  if (0.70 / trueProb > 2.5) payoutRax = Math.max(0, payoutRax - 10);

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

    // Duplicate slip guard: block placing the exact same picks twice on the same day.
    // Fingerprint = sorted (playerName|marketType|direction) joined — order-independent.
    const slipKey = normalized
      .map(l => l.playerName + '|' + l.marketType + '|' + l.direction)
      .sort()
      .join('::');

    const { results: sameDayParlays } = await env.DB.prepare(
      "SELECT id FROM parlays WHERE user_id=? AND legs_count=? AND status IN ('active','pending_deposit') AND created_at>=?"
    ).bind(user.id, normalized.length, todayStart).all();

    for (const rp of sameDayParlays) {
      const { results: existLegs } = await env.DB.prepare(
        'SELECT player_name, market_type, direction FROM parlay_legs WHERE parlay_id=?'
      ).bind(rp.id).all();
      const existKey = existLegs
        .map(l => l.player_name + '|' + l.market_type + '|' + l.direction)
        .sort()
        .join('::');
      if (existKey === slipKey) {
        return err('You already have an active slip with these exact picks — cancel it first to place again.', 400);
      }
    }
  }

  const cardId = await pickCard(env, now);
  if (!cardId) return err('No deposit cards available — contact support', 503);
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
    // Race: another request grabbed this card between SELECT and UPDATE — try a different one
    await env.DB.prepare('DELETE FROM parlays WHERE id = ?').bind(parlayId).run();
    const retryCardId = await pickCard(env, now);
    if (!retryCardId) return err('No deposit cards available — try again shortly', 503);

    const retry2 = await env.DB.prepare(
      'INSERT INTO parlays (user_id, sport, legs_count, stake_rax, true_prob, payout_rax, ' +
      'deposit_card_id, rs_username, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      user.id, parlayS, normalized.length, stake,
      trueProb, payoutRax, retryCardId, user.rs_username, expiresAt, now
    ).run();

    const newParlayId = retry2.meta.last_row_id;
    const lockRes2 = await env.DB.prepare(
      'UPDATE deposit_cards SET assigned_to_parlay_id = ?, assigned_at = ? ' +
      'WHERE card_id = ? AND assigned_to_parlay_id IS NULL'
    ).bind(newParlayId, now, retryCardId).run();

    if (lockRes2.meta.changes === 0) {
      await env.DB.prepare('DELETE FROM parlays WHERE id = ?').bind(newParlayId).run();
      return err('No deposit cards available — try again shortly', 503);
    }

    return placeLegsAndRespond(env.DB, newParlayId, retryCardId, normalized, stake, payoutRax, expiresAt, user.rs_username, now);
  }

  return placeLegsAndRespond(env.DB, parlayId, cardId, normalized, stake, payoutRax, expiresAt, user.rs_username, now);
}

async function placeLegsAndRespond(db, parlayId, cardId, legs, stake, payoutRax, expiresAt, rsUsername, now) {
  await db.batch(legs.map(leg =>
    db.prepare(
      'INSERT INTO parlay_legs (parlay_id, sport, event_id, event_name, game_date, subcat_id, ' +
      'market_type, market_id, selection_id, player_name, label, threshold, direction, ' +
      'american_odds, implied_prob, headshot_url, game_start_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      parlayId, leg.sport,
      leg.eventId, leg.eventName, leg.gameDate, leg.subcatId,
      leg.marketType, leg.marketId, leg.selectionId, leg.playerName,
      leg.label, leg.threshold, leg.direction, leg.americanOdds, leg.impliedProb,
      leg.headshotUrl, leg.gameStartMs || null
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
