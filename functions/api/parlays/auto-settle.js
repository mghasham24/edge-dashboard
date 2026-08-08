// functions/api/parlays/auto-settle.js
// POST /api/parlays/auto-settle?_cron_key=CRON_SECRET
// GET  /api/parlays/auto-settle?_cron_key=CRON_SECRET&debug  (admin debug)
//
// Settles active parlays using MLB Stats API boxscores + ESPN MMA API for UFC.
// Three reliability fixes vs v1:
//   1. Same-day settlement — only uses games with abstractGameState=Final
//   2. Name normalization — strips accents before matching (José → jose)
//   3. Stale void — legs unresolved 2+ days after game_date are voided (push)
// Wired into alert-cron every 60s.

import { ok, err }    from '../../_lib/response.js';
import { getSession } from '../../_lib/session.js';

const MLB_API    = 'https://statsapi.mlb.com/api/v1';
const ESPN_MMA   = 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc';
const STALE_DAYS = 2; // days after game_date before an unresolved leg is voided

// Maps market_type (as stored in parlay_legs) → MLB Stats API field name.
// 'hrbi' is a computed stat (hits+runs+rbi) injected by extractPlayerStats.
const STAT_FIELD = {
  hits:        'hits',
  total_bases: 'totalBases',
  rbis:        'rbi',
  runs:        'runs',
  hrbi:        'hrbi',       // computed in extractPlayerStats
  pitcher_ks:  'strikeOuts', // pitching strikeouts
  outs_ou:     'outs',       // pitcher outs recorded
};

// RS marketplace only accepts offers in multiples of 10.
// Ones digit 0-7 → round down; 8-9 → round up.
function roundOfferAmount(amount) {
  const ones = amount % 10;
  return ones >= 8 ? Math.ceil(amount / 10) * 10 : Math.floor(amount / 10) * 10;
}

// Strip accents + lowercase — handles José vs Jose, etc.
function normalizeName(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// Returns gamePks for games that are already Final on a given date
async function getFinalGamePks(date) {
  const res = await fetch(`${MLB_API}/schedule?date=${date}&sportId=1`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.dates?.[0]?.games || [])
    .filter(g => g.status?.abstractGameState === 'Final')
    .map(g => g.gamePk);
}

// Returns Final games with team names, abbreviations, and scores for team market settlement
async function getFinalGamesWithScores(date) {
  const res = await fetch(
    `${MLB_API}/schedule?date=${date}&sportId=1&hydrate=linescore`,
    { signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data.dates?.[0]?.games || [])
    .filter(g => g.status?.abstractGameState === 'Final')
    .map(g => ({
      gamePk:    g.gamePk,
      homeName:  g.teams?.home?.team?.name  || g.linescore?.teams?.home?.team?.name  || '',
      awayName:  g.teams?.away?.team?.name  || g.linescore?.teams?.away?.team?.name  || '',
      homeAbbr:  (g.teams?.home?.team?.abbreviation || g.linescore?.teams?.home?.team?.abbreviation || '').toUpperCase(),
      awayAbbr:  (g.teams?.away?.team?.abbreviation || g.linescore?.teams?.away?.team?.abbreviation || '').toUpperCase(),
      homeScore: g.teams?.home?.score ?? g.linescore?.teams?.home?.runs ?? null,
      awayScore: g.teams?.away?.score ?? g.linescore?.teams?.away?.runs ?? null,
    }))
    .filter(g => g.homeScore != null && g.awayScore != null);
}

// Resolve a team market leg (team_ml / team_runline / team_total) against Final game scores.
// player_name formats:
//   team_ml / team_runline : "<Full Team Name> ML" | "<Full Team Name> RL"
//   team_total             : "<ABBR> @ <ABBR> O<line>" | "<ABBR> @ <ABBR> U<line>"
function resolveTeamLeg(leg, finalGames) {
  const mkt = leg.market_type;

  if (mkt === 'team_total') {
    // "TOR @ HOU O8.5" or "TOR @ HOU U8.5"
    const m = leg.player_name.match(/^(\w+)\s*@\s*(\w+)\s+([OU])([\d.]+)$/i);
    if (!m) return null;
    const awayAbbr = m[1].toUpperCase();
    const homeAbbr = m[2].toUpperCase();
    const isOver   = m[3].toUpperCase() === 'O';
    const line     = parseFloat(m[4]);
    const game = finalGames.find(g =>
      (g.awayAbbr === awayAbbr || normalizeName(g.awayName).includes(awayAbbr.toLowerCase())) &&
      (g.homeAbbr === homeAbbr || normalizeName(g.homeName).includes(homeAbbr.toLowerCase()))
    );
    if (!game) return null;
    const total = game.homeScore + game.awayScore;
    return (isOver ? total > line : total < line) ? 'won' : 'lost';
  }

  // team_ml or team_runline — strip suffix, match by full name OR nickname suffix.
  // DK names like "TB Rays" won't equal MLB full name "Tampa Bay Rays", but the
  // nickname portion ("Rays") is unique across MLB and always ends the full name.
  const dkName   = leg.player_name.replace(/ (ML|RL)$/i, '').trim();
  const teamName = normalizeName(dkName);
  // nickname = everything after the leading abbreviation, e.g. "tb rays" → "rays", "cws white sox" → "white sox"
  const nickname = teamName.split(' ').slice(1).join(' ');
  const game = finalGames.find(g => {
    const homeNorm = normalizeName(g.homeName);
    const awayNorm = normalizeName(g.awayName);
    return homeNorm === teamName || awayNorm === teamName ||
           (nickname && (homeNorm.endsWith(nickname) || awayNorm.endsWith(nickname)));
  });
  if (!game) return null;

  const isHome    = normalizeName(game.homeName) === teamName;
  const teamScore = isHome ? game.homeScore : game.awayScore;
  const oppScore  = isHome ? game.awayScore : game.homeScore;

  if (mkt === 'team_ml') {
    return teamScore > oppScore ? 'won' : 'lost';
  }

  if (mkt === 'team_runline') {
    // threshold is the line from this team's perspective (e.g., -1.5 means need to win by 2+)
    const line = parseFloat(leg.threshold ?? 0);
    return (teamScore + line > oppScore) ? 'won' : 'lost';
  }

  return null;
}

// Returns map of normalizedLastName → { won: bool, rounds: number|null }
// for completed UFC fights on a given date (YYYY-MM-DD).
async function getUfcResults(date) {
  const yyyymmdd = date.replace(/-/g, '');
  let data;
  try {
    const res = await fetch(`${ESPN_MMA}/scoreboard?dates=${yyyymmdd}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return {};
    data = await res.json();
  } catch (e) { return {}; }

  const results = {};
  for (const event of (data.events || [])) {
    for (const comp of (event.competitions || [])) {
      if (!comp.status?.type?.completed) continue;
      const round = comp.status?.period ?? null; // round when fight ended
      const competitors = comp.competitors || [];
      for (const c of competitors) {
        const fullName = c.athlete?.displayName || c.athlete?.shortName || '';
        if (!fullName) continue;
        const lastName = normalizeName(fullName).split(' ').pop();
        if (lastName) results[lastName] = { won: !!c.winner, rounds: round };
      }
    }
  }
  return results;
}

async function getBoxscore(gamePk) {
  const res = await fetch(`${MLB_API}/game/${gamePk}/boxscore`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  return res.json();
}

// Returns map of normalizedName → merged batting+pitching stats + computed hrbi
function extractPlayerStats(boxscore) {
  const map = {};
  for (const side of ['away', 'home']) {
    const players = boxscore?.teams?.[side]?.players || {};
    for (const p of Object.values(players)) {
      const name = normalizeName(p.person?.fullName || '');
      if (!name) continue;
      const batting  = p.stats?.batting  || {};
      const pitching = p.stats?.pitching || {};
      const merged   = { ...batting, ...pitching };
      // Computed: hits + runs + rbi
      merged.hrbi = (parseInt(batting.hits || 0) + parseInt(batting.runs || 0) + parseInt(batting.rbi || 0));
      map[name] = merged;
    }
  }
  return map;
}

async function handleRequest({ request, env }) {
  const url     = new URL(request.url);
  const cronKey = url.searchParams.get('_cron_key');
  const debug   = url.searchParams.has('debug');
  const lastRun = url.searchParams.has('last_run');

  // last_run: return the cached result of the most recent auto-settle run (admin only)
  if (lastRun) {
    const session = await getSession(request, env.DB);
    const userRow = session
      ? await env.DB.prepare('SELECT is_admin FROM users WHERE id=?').bind(session.user_id).first()
      : null;
    if (!userRow?.is_admin) return err('Unauthorized', 401);
    const row = await env.DB.prepare(
      "SELECT data, fetched_at FROM odds_cache WHERE cache_key='auto_settle_last_run'"
    ).first();
    if (!row) return ok({ never_run: true });
    return new Response(JSON.stringify({ fetched_at: row.fetched_at, ...JSON.parse(row.data) }, null, 2),
      { headers: { 'Content-Type': 'application/json' } });
  }

  // Auth: cron key OR admin session
  if (!env.CRON_SECRET || cronKey !== env.CRON_SECRET) {
    const session = await getSession(request, env.DB);
    const userRow = session
      ? await env.DB.prepare('SELECT is_admin FROM users WHERE id=?').bind(session.user_id).first()
      : null;
    if (!userRow?.is_admin) return err('Unauthorized', 401);
  }

  const now      = Math.floor(Date.now() / 1000);
  const todayUtc = new Date().toISOString().slice(0, 10);
  const staleDate = new Date(Date.now() - STALE_DAYS * 86400000).toISOString().slice(0, 10);

  async function cacheAndReturn(payload) {
    try {
      await env.DB.prepare(
        "INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES('auto_settle_last_run',?,?) " +
        "ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at"
      ).bind(JSON.stringify({ ts: now, ...payload }), now).run();
    } catch(e) {}
    return ok(payload);
  }

  // 1. Load active parlays
  const { results: parlays } = await env.DB.prepare(
    "SELECT id, user_id, payout_rax, rs_username FROM parlays WHERE status='active'"
  ).all();

  if (!parlays.length) return cacheAndReturn({ settled: 0, reason: 'no_active_parlays' });

  // 2. Load all pending legs for active parlays (today or earlier)
  const { results: allLegs } = await env.DB.prepare(
    "SELECT pl.id, pl.parlay_id, pl.player_name, pl.market_id, pl.threshold, " +
    "pl.direction, pl.game_date, pl.market_type, pl.status " +
    "FROM parlay_legs pl " +
    "JOIN parlays p ON p.id = pl.parlay_id " +
    "WHERE p.status = 'active' AND pl.status = 'pending'"
  ).all();

  if (!allLegs.length) return cacheAndReturn({ settled: 0, reason: 'no_pending_legs' });

  const eligibleLegs = allLegs.filter(l => l.game_date <= todayUtc);
  if (!eligibleLegs.length) return cacheAndReturn({ settled: 0, reason: 'all_games_future', todayUtc });

  // 3. Fetch Final boxscores + game scores for each unique game_date in parallel
  const uniqueDates = [...new Set(eligibleLegs.map(l => l.game_date))];
  const datePlayerMap = {}; // date → { normalizedName → stats }
  const dateGamesMap  = {}; // date → [{ homeName, awayName, homeAbbr, awayAbbr, homeScore, awayScore }]
  const dateUfcMap    = {}; // date → { normalizedLastName → { won, rounds } }

  await Promise.all(uniqueDates.map(async date => {
    const hasUfc = eligibleLegs.some(l => l.game_date === date &&
      (l.market_type === 'ufc_ml' || l.market_type === 'ufc_total'));
    const [gamesWithScores, gamePks, ufcResults] = await Promise.all([
      getFinalGamesWithScores(date),
      getFinalGamePks(date),
      hasUfc ? getUfcResults(date) : Promise.resolve({}),
    ]);
    dateGamesMap[date] = gamesWithScores;
    dateUfcMap[date]   = ufcResults;

    const allStats = {};
    await Promise.all(gamePks.map(async pk => {
      const bs = await getBoxscore(pk).catch(() => null);
      if (bs) Object.assign(allStats, extractPlayerStats(bs));
    }));
    datePlayerMap[date] = allStats;
  }));

  if (debug) {
    return new Response(JSON.stringify({
      todayUtc, staleDate,
      dates: uniqueDates.map(date => ({
        date,
        finalGameCount: Object.keys(datePlayerMap[date] || {}).length > 0
          ? 'has_stats' : 'no_final_games_yet',
        finalGames: (dateGamesMap[date] || []).map(g =>
          `${g.awayName || g.awayAbbr || '?'} ${g.awayScore} @ ${g.homeName || g.homeAbbr || '?'} ${g.homeScore}`
        ),
        ufcFights: Object.keys(dateUfcMap[date] || {}).map(last => `${last}: ${JSON.stringify(dateUfcMap[date][last])}`),
        legs: eligibleLegs.filter(l => l.game_date === date).map(l => {
          const isTeam = l.market_type === 'team_ml' || l.market_type === 'team_runline' || l.market_type === 'team_total';
          if (isTeam) {
            const finalGames = dateGamesMap[date] || [];
            const outcome = finalGames.length ? resolveTeamLeg(l, finalGames) : null;
            return { player: l.player_name, type: 'team_market', outcome: outcome ?? 'game_not_final_yet' };
          }
          if (l.market_type === 'ufc_ml' || l.market_type === 'ufc_total') {
            const lastName = normalizeName(l.player_name).split(' ').pop();
            const result   = (dateUfcMap[date] || {})[lastName];
            return { player: l.player_name, type: l.market_type, found: !!result, result: result ?? null };
          }
          const norm = normalizeName(l.player_name);
          const stats = datePlayerMap[date]?.[norm] || null;
          const statField = STAT_FIELD[l.market_type] || l.market_type;
          const rawVal = stats?.[statField];
          const statVal = rawVal != null ? parseFloat(rawVal) : null;
          const outcome = statVal == null ? null
            : (l.direction === 'more' ? statVal > l.threshold : statVal < l.threshold) ? 'won' : 'lost';
          return {
            player: l.player_name, normalized: norm, found: !!stats,
            market_type: l.market_type, statField, threshold: l.threshold,
            direction: l.direction, statVal, outcome,
          };
        }),
      })),
    }, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }

  // 4. Resolve each eligible leg
  // outcome: 'won' | 'lost' | 'void' (stale+not found) | null (game not Final yet)
  const legOutcomes = {};
  for (const leg of eligibleLegs) {
    // Team market legs (MLB ML / Run Line / Total) — use final game scores
    if (leg.market_type === 'team_ml' || leg.market_type === 'team_runline' || leg.market_type === 'team_total') {
      const finalGames = dateGamesMap[leg.game_date] || [];
      const outcome = finalGames.length ? resolveTeamLeg(leg, finalGames) : null;
      legOutcomes[leg.id] = (outcome === null && leg.game_date < staleDate) ? 'void' : outcome;
      continue;
    }

    // UFC legs — use ESPN MMA scoreboard
    if (leg.market_type === 'ufc_ml' || leg.market_type === 'ufc_total') {
      const ufcResults = dateUfcMap[leg.game_date] || {};
      if (leg.market_type === 'ufc_ml') {
        // player_name = fighter name (e.g. "Mateusz Gamrot")
        const lastName = normalizeName(leg.player_name).split(' ').pop();
        const result   = ufcResults[lastName];
        if (!result) { legOutcomes[leg.id] = leg.game_date < staleDate ? 'void' : null; continue; }
        legOutcomes[leg.id] = result.won ? 'won' : 'lost';
      } else {
        // ufc_total — player_name = "FighterA vs FighterB O2.5" or "... U2.5"
        const m = leg.player_name.match(/([OU])([\d.]+)$/i);
        if (!m) { legOutcomes[leg.id] = null; continue; }
        // Find result via either fighter's last name
        const nameChunk = normalizeName(leg.player_name.replace(/\s*[OU][\d.]+$/i, ''));
        const lastNames = nameChunk.split(/\s+vs\s+/i).map(s => s.trim().split(' ').pop());
        let result = null;
        for (const ln of lastNames) { if (ufcResults[ln]) { result = ufcResults[ln]; break; } }
        if (!result || result.rounds == null) { legOutcomes[leg.id] = leg.game_date < staleDate ? 'void' : null; continue; }
        const isOver = m[1].toUpperCase() === 'O';
        const line   = parseFloat(m[2]);
        legOutcomes[leg.id] = (isOver ? result.rounds > line : result.rounds < line) ? 'won' : 'lost';
      }
      continue;
    }

    // Player prop legs — use boxscore stats
    const playerStats = datePlayerMap[leg.game_date]?.[normalizeName(leg.player_name)];

    if (!playerStats) {
      // Not in any Final boxscore for this date
      legOutcomes[leg.id] = leg.game_date < staleDate ? 'void' : null;
      continue;
    }

    const statField = STAT_FIELD[leg.market_type] || leg.market_type;
    const rawVal    = playerStats[statField];
    if (rawVal == null) { legOutcomes[leg.id] = null; continue; }

    const statVal = parseFloat(rawVal);
    legOutcomes[leg.id] = (leg.direction === 'more' ? statVal > leg.threshold : statVal < leg.threshold)
      ? 'won' : 'lost';
  }

  // 5. Settle parlays where every eligible leg is resolved (won/lost/void)
  let totalSettled = 0;
  const report = [];

  for (const parlay of parlays) {
    const pendingLegs = allLegs.filter(l => l.parlay_id === parlay.id && l.status === 'pending' && l.game_date <= todayUtc);
    if (!pendingLegs.length) continue;

    const outcomes = pendingLegs.map(l => ({
      legId: l.id, outcome: legOutcomes[l.id] ?? null,
      player: l.player_name, stat: STAT_FIELD[l.market_type] || l.market_type,
      threshold: l.threshold, direction: l.direction,
    }));

    const stillWaiting = outcomes.filter(o => o.outcome === null);
    if (stillWaiting.length) {
      report.push({ parlayId: parlay.id, status: 'waiting', waiting: stillWaiting.map(o => o.player) });
      continue;
    }

    // All legs resolved — determine result (void legs are pushes, excluded from won/lost calc)
    const activeLeg = outcomes.filter(o => o.outcome !== 'void');
    const anyLost   = activeLeg.some(o => o.outcome === 'lost');
    const allVoid   = activeLeg.length === 0;

    const parlayResult = allVoid ? 'voided' : anyLost ? 'lost' : 'won';

    // Write per-leg results
    for (const o of outcomes) {
      await env.DB.prepare("UPDATE parlay_legs SET status=?, settled_at=? WHERE id=?")
        .bind(o.outcome, now, o.legId).run();
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
    report.push({ parlayId: parlay.id, result: parlayResult, legs: outcomes });
  }

  return cacheAndReturn({ settled: totalSettled, report });
}

export const onRequestPost = handleRequest;
export const onRequestGet  = handleRequest;
