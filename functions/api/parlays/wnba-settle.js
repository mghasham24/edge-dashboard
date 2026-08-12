// POST /api/parlays/wnba-settle
// Called by admin browser with ESPN WNBA stats — CF Workers cannot reach ESPN directly.
// Settles pending WNBA legs for a given date using client-provided player stats and game scores.

import { getSession } from '../../_lib/session.js';
import { ok, err }    from '../../_lib/response.js';

const WNBA_STAT_FIELD = {
  pts: 'pts', reb: 'reb', ast: 'ast', fg3m: 'fg3m',
  pra: 'pra', pa: 'pa', pr: 'pr', ra: 'ra',
};
const WNBA_PROP_TYPES = new Set(Object.keys(WNBA_STAT_FIELD));

function norm(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function roundOfferAmount(amount) {
  const ones = amount % 10;
  return ones >= 8 ? Math.ceil(amount / 10) * 10 : Math.floor(amount / 10) * 10;
}

function matchTeam(raw, gameName, gameAbbr) {
  const rawN = norm(raw), gameN = norm(gameName);
  if (rawN === gameN) return true;
  const nick = rawN.split(' ').slice(1).join(' ');
  if (nick && gameN.endsWith(nick)) return true;
  if (gameAbbr && gameAbbr.toUpperCase() === raw.toUpperCase()) return true;
  return false;
}

function resolveTeamLeg(leg, teamGames) {
  const mkt = leg.market_type;
  if (mkt === 'team_total') {
    const m = leg.player_name.match(/^(.+?)\s+@\s+(.+?)\s+([OU])([\d.]+)$/i);
    if (!m) return null;
    const game = teamGames.find(g => matchTeam(m[1].trim(), g.awayName, g.awayAbbr) && matchTeam(m[2].trim(), g.homeName, g.homeAbbr));
    if (!game) return null;
    const total = game.homeScore + game.awayScore;
    const isOver = m[3].toUpperCase() === 'O', line = parseFloat(m[4]);
    return (isOver ? total > line : total < line) ? 'won' : 'lost';
  }
  const dkName = leg.player_name.replace(/ (ML|RL)$/i, '').trim();
  const teamN = norm(dkName), nick = teamN.split(' ').slice(1).join(' ');
  const game = teamGames.find(g => {
    const hN = norm(g.homeName), aN = norm(g.awayName);
    return hN === teamN || aN === teamN || (nick && (hN.endsWith(nick) || aN.endsWith(nick)));
  });
  if (!game) return null;
  const hN = norm(game.homeName);
  const isHome = hN === teamN || (nick && hN.endsWith(nick));
  const myScore = isHome ? game.homeScore : game.awayScore;
  const oppScore = isHome ? game.awayScore : game.homeScore;
  if (mkt === 'team_ml') return myScore > oppScore ? 'won' : 'lost';
  if (mkt === 'team_runline') {
    const line = parseFloat(leg.threshold ?? 0);
    return (myScore + line > oppScore) ? 'won' : 'lost';
  }
  return null;
}

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Authentication required', 401);
  const user = await env.DB.prepare('SELECT is_admin FROM users WHERE id=?').bind(session.user_id).first();
  if (!user?.is_admin) return err('Admin required', 403);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON', 400); }
  const { date, playerStats, teamGames } = body;
  if (!date || typeof date !== 'string') return err('date required', 400);

  const now    = Math.floor(Date.now() / 1000);
  const games  = Array.isArray(teamGames) ? teamGames : [];
  const pStats = playerStats && typeof playerStats === 'object' ? playerStats : {};

  // Normalize playerStats keys to match normalizeName format
  const normStats = {};
  for (const [name, stats] of Object.entries(pStats)) {
    normStats[norm(name)] = stats;
  }

  // All pending legs for active parlays on this date
  const { results: legs } = await env.DB.prepare(
    'SELECT pl.id, pl.parlay_id, pl.player_name, pl.market_type, pl.threshold, pl.direction, pl.sport ' +
    'FROM parlay_legs pl JOIN parlays p ON p.id = pl.parlay_id ' +
    "WHERE p.status='active' AND pl.status='pending' AND pl.game_date=?"
  ).bind(date).all();

  if (!legs.length) return ok({ settled: 0, reason: 'no_pending_wnba_legs' });

  // Resolve each leg
  const legOutcomes = {};
  for (const leg of legs) {
    const mkt   = leg.market_type;
    const isTeam = mkt === 'team_ml' || mkt === 'team_runline' || mkt === 'team_total';
    const sport  = leg.sport || '';
    const isWnba = sport === 'wnba' || sport === 'basketball_wnba' || WNBA_PROP_TYPES.has(mkt);

    if (isTeam && isWnba) {
      legOutcomes[leg.id] = games.length ? resolveTeamLeg(leg, games) : null;
      continue;
    }
    if (!isWnba || isTeam) continue; // skip non-WNBA legs — auto-settle handles those

    const stats = normStats[norm(leg.player_name)];
    if (!stats) { legOutcomes[leg.id] = null; continue; }
    const field = WNBA_STAT_FIELD[mkt];
    if (!field) { legOutcomes[leg.id] = null; continue; }
    const statVal = stats[field];
    if (statVal == null) { legOutcomes[leg.id] = null; continue; }
    legOutcomes[leg.id] = (leg.direction === 'more' ? statVal > leg.threshold : statVal < leg.threshold) ? 'won' : 'lost';
  }

  // Settle any parlay where all legs now have outcomes (or at least one is lost)
  const parlayIds = [...new Set(legs.map(l => l.parlay_id))];
  const { results: activeParlays } = await env.DB.prepare(
    'SELECT id, user_id, payout_rax, rs_username FROM parlays WHERE status=\'active\' AND id IN (' + parlayIds.map(() => '?').join(',') + ')'
  ).bind(...parlayIds).all();

  let totalSettled = 0;
  const report = [];

  for (const parlay of activeParlays) {
    // Get ALL legs for this parlay to check if we can fully close it
    const { results: allLegs } = await env.DB.prepare(
      'SELECT id, status, market_type, sport FROM parlay_legs WHERE parlay_id=?'
    ).bind(parlay.id).all();

    const outcomes = allLegs.map(l => ({
      legId: l.id,
      outcome: l.status !== 'pending' ? l.status : (legOutcomes[l.id] ?? null),
    }));

    const stillWaiting  = outcomes.filter(o => o.outcome === null || o.outcome === 'pending');
    const resolvedLegs  = outcomes.filter(o => o.outcome !== null && o.outcome !== 'pending');
    const anyLostEarly  = resolvedLegs.some(o => o.outcome === 'lost');

    if (stillWaiting.length && !anyLostEarly) {
      report.push({ parlayId: parlay.id, status: 'waiting' });
      continue;
    }

    const activeLeg    = outcomes.filter(o => o.outcome !== 'void' && o.outcome !== null && o.outcome !== 'pending');
    const anyLost      = activeLeg.some(o => o.outcome === 'lost');
    const allVoid      = resolvedLegs.length > 0 && resolvedLegs.every(o => o.outcome === 'void');
    const parlayResult = allVoid ? 'voided' : anyLost ? 'lost' : 'won';

    // Write newly resolved leg statuses
    for (const l of allLegs) {
      const outcome = legOutcomes[l.id];
      if (outcome == null) continue;
      await env.DB.prepare('UPDATE parlay_legs SET status=?, settled_at=? WHERE id=?').bind(outcome, now, l.id).run();
    }

    if (parlayResult === 'lost') {
      await env.DB.prepare("UPDATE parlays SET status='lost', settled_at=? WHERE id=?").bind(now, parlay.id).run();
    } else if (parlayResult === 'voided') {
      await env.DB.prepare("UPDATE parlays SET status='voided', settled_at=? WHERE id=?").bind(now, parlay.id).run();
    } else {
      await env.DB.batch([
        env.DB.prepare("UPDATE parlays SET status='won', settled_at=? WHERE id=?").bind(now, parlay.id),
        env.DB.prepare(
          'INSERT OR IGNORE INTO payout_queue (parlay_id, user_id, rs_username, payout_rax, offer_amount, created_at) VALUES (?,?,?,?,?,?)'
        ).bind(parlay.id, parlay.user_id, parlay.rs_username, parlay.payout_rax, roundOfferAmount(parlay.payout_rax), now),
      ]);
    }

    totalSettled++;
    report.push({ parlayId: parlay.id, result: parlayResult });
  }

  return ok({ settled: totalSettled, report, date, legsChecked: legs.length });
}
