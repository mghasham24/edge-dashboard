// functions/api/parlays/auto-settle.js
// POST /api/parlays/auto-settle?_cron_key=CRON_SECRET
// GET  /api/parlays/auto-settle?_cron_key=CRON_SECRET&debug  (admin debug)
//
// Settles active parlays using sport-specific external APIs:
//   MLB  — MLB Stats API boxscores + schedule
//   WNBA — ESPN WNBA scoreboard + summary
//   NFL  — ESPN NFL scoreboard
//   UFC  — ESPN MMA scoreboard
// Reliability: only settles Final/completed games; stale legs voided after STALE_DAYS.

import { ok, err }    from '../../_lib/response.js';
import { getSession } from '../../_lib/session.js';

const MLB_API    = 'https://statsapi.mlb.com/api/v1';
const ESPN_WNBA  = 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba';
const ESPN_NFL   = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const ESPN_MMA   = 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc';
const STALE_DAYS = 2;

const MLB_STAT_FIELD = {
  hits: 'hits', total_bases: 'totalBases', rbis: 'rbi', runs: 'runs',
  hrbi: 'hrbi', pitcher_ks: 'strikeOuts', outs_ou: 'outs',
};
const WNBA_STAT_FIELD = {
  pts: 'pts', reb: 'reb', ast: 'ast', fg3m: 'fg3m',
  pra: 'pra', pa: 'pa', pr: 'pr', ra: 'ra',
};
const WNBA_PROP_TYPES = new Set(Object.keys(WNBA_STAT_FIELD));

function roundOfferAmount(amount) {
  const ones = amount % 10;
  return ones >= 8 ? Math.ceil(amount / 10) * 10 : Math.floor(amount / 10) * 10;
}

function normalizeName(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// Resolve a team market leg against an array of final games with scores.
// finalGames: [{ homeName, awayName, homeAbbr, awayAbbr, homeScore, awayScore }]
function resolveTeamLeg(leg, finalGames) {
  const mkt = leg.market_type;

  if (mkt === 'team_total') {
    // New format: "Los Angeles Dodgers @ Kansas City Royals O8.5"
    // Old format: "LAD @ KC O8.5" (abbreviations — kept for backwards compat)
    const m = leg.player_name.match(/^(.+?)\s+@\s+(.+?)\s+([OU])([\d.]+)$/i);
    if (!m) return null;
    const awayRaw = m[1].trim();
    const homeRaw = m[2].trim();
    const isOver  = m[3].toUpperCase() === 'O';
    const line    = parseFloat(m[4]);

    function matchesTeam(raw, gameName, gameAbbr) {
      const rawNorm = normalizeName(raw);
      const gameNorm = normalizeName(gameName);
      // Exact full-name match (new format)
      if (gameNorm === rawNorm) return true;
      // endsWith nickname (e.g. "la dodgers" → nickname "dodgers" in "los angeles dodgers")
      const nickname = rawNorm.split(' ').slice(1).join(' ');
      if (nickname && gameNorm.endsWith(nickname)) return true;
      // Abbreviation exact match (old format, e.g. "LAD" === "LAD")
      const rawUpper = raw.toUpperCase();
      if (gameAbbr === rawUpper) return true;
      return false;
    }

    const game = finalGames.find(g =>
      matchesTeam(awayRaw, g.awayName, g.awayAbbr) &&
      matchesTeam(homeRaw, g.homeName, g.homeAbbr)
    );
    if (!game) return null;
    const total = game.homeScore + game.awayScore;
    return (isOver ? total > line : total < line) ? 'won' : 'lost';
  }

  // team_ml or team_runline — strip suffix, match by full name OR nickname suffix.
  const dkName  = leg.player_name.replace(/ (ML|RL)$/i, '').trim();
  const teamName = normalizeName(dkName);
  // nickname = everything after leading word (handles "LA Dodgers" → "dodgers", "CWS White Sox" → "white sox")
  const nickname = teamName.split(' ').slice(1).join(' ');
  const game = finalGames.find(g => {
    const homeNorm = normalizeName(g.homeName);
    const awayNorm = normalizeName(g.awayName);
    return homeNorm === teamName || awayNorm === teamName ||
           (nickname && (homeNorm.endsWith(nickname) || awayNorm.endsWith(nickname)));
  });
  if (!game) return null;

  // Use same logic as game-find to correctly determine home/away
  const homeNorm = normalizeName(game.homeName);
  const isHome   = homeNorm === teamName || (nickname && homeNorm.endsWith(nickname));
  const teamScore = isHome ? game.homeScore : game.awayScore;
  const oppScore  = isHome ? game.awayScore : game.homeScore;

  if (mkt === 'team_ml') {
    return teamScore > oppScore ? 'won' : 'lost';
  }
  if (mkt === 'team_runline') {
    const line = parseFloat(leg.threshold ?? 0);
    return (teamScore + line > oppScore) ? 'won' : 'lost';
  }
  return null;
}

// ── MLB helpers ──────────────────────────────────────────────────────────────

async function getMlbFinalGames(date) {
  const res = await fetch(`${MLB_API}/schedule?date=${date}&sportId=1&hydrate=linescore`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.dates?.[0]?.games || [])
    .filter(g => g.status?.abstractGameState === 'Final')
    .map(g => ({
      gamePk:    g.gamePk,
      homeName:  g.teams?.home?.team?.name  || '',
      awayName:  g.teams?.away?.team?.name  || '',
      homeAbbr:  (g.teams?.home?.team?.abbreviation || '').toUpperCase(),
      awayAbbr:  (g.teams?.away?.team?.abbreviation || '').toUpperCase(),
      homeScore: g.teams?.home?.score ?? g.linescore?.teams?.home?.runs ?? null,
      awayScore: g.teams?.away?.score ?? g.linescore?.teams?.away?.runs ?? null,
    }))
    .filter(g => g.homeScore != null && g.awayScore != null);
}

async function getMlbBoxscore(gamePk) {
  const res = await fetch(`${MLB_API}/game/${gamePk}/boxscore`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  return res.json();
}

function extractMlbPlayerStats(boxscore) {
  const map = {};
  for (const side of ['away', 'home']) {
    const players = boxscore?.teams?.[side]?.players || {};
    for (const p of Object.values(players)) {
      const name = normalizeName(p.person?.fullName || '');
      if (!name) continue;
      const batting  = p.stats?.batting  || {};
      const pitching = p.stats?.pitching || {};
      const merged   = { ...batting, ...pitching };
      merged.hrbi = (parseInt(batting.hits || 0) + parseInt(batting.runs || 0) + parseInt(batting.rbi || 0));
      map[name] = merged;
    }
  }
  return map;
}

// ── ESPN helpers (WNBA + NFL) ────────────────────────────────────────────────

async function getEspnFinalGames(baseUrl, date) {
  const yyyymmdd = date.replace(/-/g, '');
  try {
    const res = await fetch(`${baseUrl}/scoreboard?dates=${yyyymmdd}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.events || [])
      .filter(e => e.competitions?.[0]?.status?.type?.completed)
      .map(e => {
        const comps = e.competitions?.[0]?.competitors || [];
        const home  = comps.find(c => c.homeAway === 'home');
        const away  = comps.find(c => c.homeAway === 'away');
        return {
          eventId:   e.id,
          homeName:  home?.team?.displayName || home?.team?.name || '',
          awayName:  away?.team?.displayName || away?.team?.name || '',
          homeAbbr:  (home?.team?.abbreviation || '').toUpperCase(),
          awayAbbr:  (away?.team?.abbreviation || '').toUpperCase(),
          homeScore: parseInt(home?.score, 10),
          awayScore: parseInt(away?.score, 10),
        };
      })
      .filter(g => !isNaN(g.homeScore) && !isNaN(g.awayScore));
  } catch(e) { return []; }
}

async function getWnbaPlayerStats(date) {
  const yyyymmdd = date.replace(/-/g, '');
  try {
    const sbRes = await fetch(`${ESPN_WNBA}/scoreboard?dates=${yyyymmdd}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!sbRes.ok) return {};
    const sbData = await sbRes.json();
    const eventIds = (sbData.events || [])
      .filter(e => e.competitions?.[0]?.status?.type?.completed)
      .map(e => e.id);

    const summaries = await Promise.all(eventIds.map(async id => {
      try {
        const r = await fetch(`${ESPN_WNBA}/summary?event=${id}`, {
          signal: AbortSignal.timeout(8000),
        });
        return r.ok ? r.json() : null;
      } catch(e) { return null; }
    }));

    const stats = {};
    for (const d of summaries) {
      if (!d) continue;
      for (const teamBlock of (d.boxscore?.players || [])) {
        for (const sb of (teamBlock.statistics || [])) {
          const names  = sb.names || sb.labels || [];
          const ptsIdx = names.indexOf('PTS');
          const rebIdx = names.indexOf('REB');
          const astIdx = names.indexOf('AST');
          const fg3Idx = names.indexOf('3PT');
          for (const a of (sb.athletes || [])) {
            const name = normalizeName(a.athlete?.displayName || '');
            if (!name) continue;
            const s = a.stats || [];
            const getStat = idx => {
              if (idx < 0) return 0;
              const v = s[idx];
              if (!v || v === '--') return 0;
              return parseInt(String(v).split('-')[0], 10) || 0;
            };
            const pts = getStat(ptsIdx), reb = getStat(rebIdx), ast = getStat(astIdx), fg3m = getStat(fg3Idx);
            stats[name] = { pts, reb, ast, fg3m, pra: pts+reb+ast, pa: pts+ast, pr: pts+reb, ra: reb+ast };
          }
        }
      }
    }
    return stats;
  } catch(e) { return {}; }
}

// ── UFC helper ───────────────────────────────────────────────────────────────

async function getUfcResults(date) {
  const yyyymmdd = date.replace(/-/g, '');
  try {
    const res = await fetch(`${ESPN_MMA}/scoreboard?dates=${yyyymmdd}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const results = {};
    for (const event of (data.events || [])) {
      for (const comp of (event.competitions || [])) {
        if (!comp.status?.type?.completed) continue;
        const round = comp.status?.period ?? null;
        for (const c of (comp.competitors || [])) {
          const fullName = c.athlete?.displayName || c.athlete?.shortName || '';
          if (!fullName) continue;
          const lastName = normalizeName(fullName).split(' ').pop();
          if (lastName) results[lastName] = { won: !!c.winner, rounds: round };
        }
      }
    }
    return results;
  } catch(e) { return {}; }
}

// ── Main handler ─────────────────────────────────────────────────────────────

async function handleRequest({ request, env }) {
  const url     = new URL(request.url);
  const cronKey = url.searchParams.get('_cron_key');
  const debug   = url.searchParams.has('debug');
  const lastRun = url.searchParams.has('last_run');

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

  if (!env.CRON_SECRET || cronKey !== env.CRON_SECRET) {
    const session = await getSession(request, env.DB);
    const userRow = session
      ? await env.DB.prepare('SELECT is_admin FROM users WHERE id=?').bind(session.user_id).first()
      : null;
    if (!userRow?.is_admin) return err('Unauthorized', 401);
  }

  const now       = Math.floor(Date.now() / 1000);
  const todayUtc  = new Date().toISOString().slice(0, 10);
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
    "pl.direction, pl.game_date, pl.market_type, pl.status, pl.sport " +
    "FROM parlay_legs pl " +
    "JOIN parlays p ON p.id = pl.parlay_id " +
    "WHERE p.status = 'active' AND pl.status = 'pending'"
  ).all();
  if (!allLegs.length) return cacheAndReturn({ settled: 0, reason: 'no_pending_legs' });

  const eligibleLegs = allLegs.filter(l => l.game_date <= todayUtc);
  if (!eligibleLegs.length) return cacheAndReturn({ settled: 0, reason: 'all_games_future', todayUtc });

  // Helper: determine effective sport for a leg
  // Prefer stored leg.sport; fall back to market_type inference.
  function legSportOf(leg) {
    const s = leg.sport || '';
    if (s === 'wnba' || s === 'basketball_wnba') return 'wnba';
    if (s === 'nfl'  || s === 'american_football_nfl') return 'nfl';
    if (s === 'ufc')  return 'ufc';
    if (leg.market_type === 'ufc_ml' || leg.market_type === 'ufc_total') return 'ufc';
    if (WNBA_PROP_TYPES.has(leg.market_type)) return 'wnba';
    return 'mlb'; // default — covers 'baseball_mlb' and old rows
  }

  // 3. Fetch external data for each unique (sport, date) combination in parallel
  const uniqueDates = [...new Set(eligibleLegs.map(l => l.game_date))];

  // Per-date maps: date → { homeName, awayName, homeScore, awayScore, ... }[]
  const mlbGamesMap  = {}; // MLB score data
  const mlbStatsMap  = {}; // MLB player stats
  const wnbaGamesMap = {}; // WNBA score data
  const wnbaStatsMap = {}; // WNBA player stats
  const nflGamesMap  = {}; // NFL score data
  const ufcMap       = {}; // UFC fight results

  const hasUfcOnDate = date => eligibleLegs.some(l => l.game_date === date && legSportOf(l) === 'ufc');
  const hasMlbOnDate = date => eligibleLegs.some(l => l.game_date === date && legSportOf(l) === 'mlb');
  const hasWnbaOnDate = date => eligibleLegs.some(l => l.game_date === date && legSportOf(l) === 'wnba');
  const hasNflOnDate  = date => eligibleLegs.some(l => l.game_date === date && legSportOf(l) === 'nfl');

  await Promise.all(uniqueDates.map(async date => {
    const [mlbGames, wnbaGames, nflGames, ufcResults] = await Promise.all([
      hasMlbOnDate(date)  ? getMlbFinalGames(date)                      : Promise.resolve([]),
      hasWnbaOnDate(date) ? getEspnFinalGames(ESPN_WNBA, date)           : Promise.resolve([]),
      hasNflOnDate(date)  ? getEspnFinalGames(ESPN_NFL,  date)           : Promise.resolve([]),
      hasUfcOnDate(date)  ? getUfcResults(date)                          : Promise.resolve({}),
    ]);

    mlbGamesMap[date]  = mlbGames;
    wnbaGamesMap[date] = wnbaGames;
    nflGamesMap[date]  = nflGames;
    ufcMap[date]       = ufcResults;

    // MLB player stats — one boxscore per final game
    if (hasMlbOnDate(date) && mlbGames.length) {
      const allStats = {};
      await Promise.all(mlbGames.map(async g => {
        const bs = await getMlbBoxscore(g.gamePk).catch(() => null);
        if (bs) Object.assign(allStats, extractMlbPlayerStats(bs));
      }));
      mlbStatsMap[date] = allStats;
    } else {
      mlbStatsMap[date] = {};
    }

    // WNBA player stats
    if (hasWnbaOnDate(date)) {
      wnbaStatsMap[date] = await getWnbaPlayerStats(date);
    } else {
      wnbaStatsMap[date] = {};
    }
  }));

  if (debug) {
    return new Response(JSON.stringify({
      todayUtc, staleDate,
      dates: uniqueDates.map(date => ({
        date,
        mlbGames:  mlbGamesMap[date].map(g => `${g.awayName} ${g.awayScore} @ ${g.homeName} ${g.homeScore}`),
        wnbaGames: wnbaGamesMap[date].map(g => `${g.awayName} ${g.awayScore} @ ${g.homeName} ${g.homeScore}`),
        nflGames:  nflGamesMap[date].map(g => `${g.awayName} ${g.awayScore} @ ${g.homeName} ${g.homeScore}`),
        ufcFights: Object.entries(ufcMap[date] || {}).map(([n, r]) => `${n}: ${JSON.stringify(r)}`),
        legs: eligibleLegs.filter(l => l.game_date === date).map(l => {
          const sport = legSportOf(l);
          const isTeam = l.market_type === 'team_ml' || l.market_type === 'team_runline' || l.market_type === 'team_total';
          if (isTeam) {
            const games = sport === 'wnba' ? wnbaGamesMap[date] : sport === 'nfl' ? nflGamesMap[date] : mlbGamesMap[date];
            const outcome = games.length ? resolveTeamLeg(l, games) : null;
            return { player: l.player_name, sport, type: 'team_market', outcome: outcome ?? 'not_final_yet' };
          }
          if (sport === 'ufc') {
            const lastName = normalizeName(l.player_name).split(' ').pop();
            const result   = (ufcMap[date] || {})[lastName];
            return { player: l.player_name, sport: 'ufc', type: l.market_type, found: !!result, result: result ?? null };
          }
          if (sport === 'wnba') {
            const stats  = (wnbaStatsMap[date] || {})[normalizeName(l.player_name)];
            const field  = WNBA_STAT_FIELD[l.market_type];
            const statVal = stats ? stats[field] ?? null : null;
            const outcome = statVal == null ? null
              : (l.direction === 'more' ? statVal > l.threshold : statVal < l.threshold) ? 'won' : 'lost';
            return { player: l.player_name, sport: 'wnba', market_type: l.market_type, field, statVal, outcome };
          }
          // MLB player prop
          const norm    = normalizeName(l.player_name);
          const stats   = (mlbStatsMap[date] || {})[norm] || null;
          const field   = MLB_STAT_FIELD[l.market_type] || l.market_type;
          const rawVal  = stats?.[field];
          const statVal = rawVal != null ? parseFloat(rawVal) : null;
          const outcome = statVal == null ? null
            : (l.direction === 'more' ? statVal > l.threshold : statVal < l.threshold) ? 'won' : 'lost';
          return { player: l.player_name, sport: 'mlb', normalized: norm, found: !!stats, market_type: l.market_type, field, threshold: l.threshold, direction: l.direction, statVal, outcome };
        }),
      })),
    }, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }

  // 4. Resolve each eligible leg
  const legOutcomes = {};
  for (const leg of eligibleLegs) {
    const sport  = legSportOf(leg);
    const isTeam = leg.market_type === 'team_ml' || leg.market_type === 'team_runline' || leg.market_type === 'team_total';

    if (isTeam) {
      const games = sport === 'wnba' ? wnbaGamesMap[leg.game_date] || []
                  : sport === 'nfl'  ? nflGamesMap[leg.game_date]  || []
                  :                    mlbGamesMap[leg.game_date]   || [];
      const outcome = games.length ? resolveTeamLeg(leg, games) : null;
      legOutcomes[leg.id] = (outcome === null && leg.game_date < staleDate) ? 'void' : outcome;
      continue;
    }

    if (sport === 'ufc') {
      const ufcResults = ufcMap[leg.game_date] || {};
      if (leg.market_type === 'ufc_ml') {
        const lastName = normalizeName(leg.player_name).split(' ').pop();
        const result   = ufcResults[lastName];
        if (!result) { legOutcomes[leg.id] = leg.game_date < staleDate ? 'void' : null; continue; }
        legOutcomes[leg.id] = result.won ? 'won' : 'lost';
      } else {
        const m = leg.player_name.match(/([OU])([\d.]+)$/i);
        if (!m) { legOutcomes[leg.id] = null; continue; }
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

    if (sport === 'wnba') {
      const wnbaStats = (wnbaStatsMap[leg.game_date] || {})[normalizeName(leg.player_name)];
      if (!wnbaStats) {
        legOutcomes[leg.id] = leg.game_date < staleDate ? 'void' : null;
        continue;
      }
      const field   = WNBA_STAT_FIELD[leg.market_type];
      if (!field) { legOutcomes[leg.id] = null; continue; }
      const statVal = wnbaStats[field];
      if (statVal == null) { legOutcomes[leg.id] = null; continue; }
      legOutcomes[leg.id] = (leg.direction === 'more' ? statVal > leg.threshold : statVal < leg.threshold)
        ? 'won' : 'lost';
      continue;
    }

    // MLB player prop
    const playerStats = (mlbStatsMap[leg.game_date] || {})[normalizeName(leg.player_name)];
    if (!playerStats) {
      legOutcomes[leg.id] = leg.game_date < staleDate ? 'void' : null;
      continue;
    }
    const statField = MLB_STAT_FIELD[leg.market_type] || leg.market_type;
    const rawVal    = playerStats[statField];
    if (rawVal == null) { legOutcomes[leg.id] = null; continue; }
    const statVal = parseFloat(rawVal);
    legOutcomes[leg.id] = (leg.direction === 'more' ? statVal > leg.threshold : statVal < leg.threshold)
      ? 'won' : 'lost';
  }

  // 5. Settle parlays where every eligible leg is resolved
  let totalSettled = 0;
  const report = [];

  for (const parlay of parlays) {
    const pendingLegs = allLegs.filter(l => l.parlay_id === parlay.id && l.status === 'pending' && l.game_date <= todayUtc);
    if (!pendingLegs.length) continue;

    const outcomes = pendingLegs.map(l => ({
      legId: l.id, outcome: legOutcomes[l.id] ?? null,
      player: l.player_name, market_type: l.market_type,
      threshold: l.threshold, direction: l.direction,
    }));

    const stillWaiting = outcomes.filter(o => o.outcome === null);
    if (stillWaiting.length) {
      report.push({ parlayId: parlay.id, status: 'waiting', waiting: stillWaiting.map(o => o.player) });
      continue;
    }

    const activeLeg   = outcomes.filter(o => o.outcome !== 'void');
    const anyLost     = activeLeg.some(o => o.outcome === 'lost');
    const allVoid     = activeLeg.length === 0;
    const parlayResult = allVoid ? 'voided' : anyLost ? 'lost' : 'won';

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
