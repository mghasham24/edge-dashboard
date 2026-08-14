// functions/api/parlays/auto-settle.js v2
// POST /api/parlays/auto-settle?_cron_key=CRON_SECRET
// GET  /api/parlays/auto-settle?_cron_key=CRON_SECRET&debug  (admin debug)
//
// Settles active parlays using sport-specific external APIs:
//   MLB  — MLB Stats API boxscores + schedule + linescore (1st inn)
//   WNBA — ESPN WNBA scoreboard + summary
//   NFL  — ESPN NFL scoreboard
//   UFC  — ESPN MMA scoreboard
// Reliability: only settles Final/completed games; stale legs voided after STALE_DAYS.

import { ok, err }    from '../../_lib/response.js';
import { getSession } from '../../_lib/session.js';

const MLB_API    = 'https://statsapi.mlb.com/api/v1';

// MLB Stats API schedule endpoint doesn't include team.abbreviation — derive from name
const MLB_ABBR_FROM_NAME = {
  'arizona diamondbacks': 'ARI', 'atlanta braves': 'ATL', 'baltimore orioles': 'BAL',
  'boston red sox': 'BOS', 'chicago cubs': 'CHC', 'chicago white sox': 'CWS',
  'cincinnati reds': 'CIN', 'cleveland guardians': 'CLE', 'colorado rockies': 'COL',
  'detroit tigers': 'DET', 'houston astros': 'HOU', 'kansas city royals': 'KC',
  'los angeles angels': 'LAA', 'los angeles dodgers': 'LAD', 'miami marlins': 'MIA',
  'milwaukee brewers': 'MIL', 'minnesota twins': 'MIN', 'new york mets': 'NYM',
  'new york yankees': 'NYY', 'oakland athletics': 'OAK', 'sacramento athletics': 'SAC',
  'philadelphia phillies': 'PHI', 'pittsburgh pirates': 'PIT', 'san diego padres': 'SD',
  'san francisco giants': 'SF', 'seattle mariners': 'SEA', 'st. louis cardinals': 'STL',
  'tampa bay rays': 'TB', 'texas rangers': 'TEX', 'toronto blue jays': 'TOR',
  'washington nationals': 'WAS',
};
function mlbAbbrFromName(name) {
  return (name ? MLB_ABBR_FROM_NAME[name.toLowerCase()] || '' : '');
}
const ESPN_WNBA  = 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba';
const ESPN_NFL   = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const ESPN_MMA   = 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc';
const VPS_HOST   = 'http://vps.raxedge.com:3003';
const STALE_DAYS = 2;

const ESPN_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Referer': 'https://www.espn.com/',
  'Origin': 'https://www.espn.com',
  'Accept-Language': 'en-US,en;q=0.9',
};

// MLB player prop market → boxscore stat field
const MLB_STAT_FIELD = {
  hits:         'hits',
  total_bases:  'totalBases',
  rbis:         'rbi',
  runs:         'runs',
  hrbi:         'hrbi',
  pitcher_ks:   'strikeOuts',
  outs_ou:      'outs',
  // New full-game props
  singles:      'singles',
  stolen_bases: 'stolenBases',
  doubles:      'doubles',
  walks:        'batterWalks',
  hits_allowed: 'pitcherHits',
  er_allowed:   'earnedRuns',
  bb_allowed:   'pitcherWalks',
  hwer:         'hwer',
};

const WNBA_STAT_FIELD = {
  pts: 'pts', reb: 'reb', ast: 'ast', fg3m: 'fg3m',
  pra: 'pra', pa: 'pa', pr: 'pr', ra: 'ra',
};
const WNBA_PROP_TYPES = new Set(Object.keys(WNBA_STAT_FIELD));

// 1st inning markets settleable from linescore (runs + hits per half-inning)
const INN1_LINESCORE_MKTS = new Set([
  '1inn_ml', '1inn_runs_ou', '1inn_hits_ou', '1inn_hits_exact',
  '1inn_run_yn', '1inn_runs_exact',
]);
// 1st inning markets settleable from play-by-play (eventType counts + pitch sums)
const INN1_PBP_MKTS = new Set([
  '1inn_walks_ou', '1inn_pitches_ou', '1inn_pitches_range',
  '1inn_batters_ou', '1inn_hr_yn', '1inn_ks_exact',
]);


function normalizeName(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// ── Team market resolver ──────────────────────────────────────────────────────

function resolveTeamLeg(leg, finalGames) {
  const mkt = leg.market_type;

  if (mkt === 'team_total') {
    const m = leg.player_name.match(/^(.+?)\s+@\s+(.+?)\s+([OU])([\d.]+)$/i);
    if (!m) return null;
    const awayRaw = m[1].trim();
    const homeRaw = m[2].trim();
    const isOver  = m[3].toUpperCase() === 'O';
    const line    = parseFloat(m[4]);

    function matchesTeam(raw, gameName, gameAbbr) {
      const rawNorm  = normalizeName(raw);
      const gameNorm = normalizeName(gameName);
      if (gameNorm === rawNorm) return true;
      const nickname = rawNorm.split(' ').slice(1).join(' ');
      if (nickname && gameNorm.endsWith(nickname)) return true;
      if (gameAbbr === raw.toUpperCase()) return true;
      return false;
    }

    const game = finalGames.find(g =>
      matchesTeam(awayRaw, g.awayName, g.awayAbbr) &&
      matchesTeam(homeRaw, g.homeName, g.homeAbbr)
    );
    if (!game) return null;
    const total = game.homeScore + game.awayScore;
    if (total === line) return 'void'; // push — scratch this leg
    return (isOver ? total > line : total < line) ? 'won' : 'lost';
  }

  const dkName   = leg.player_name.replace(/ (ML|RL)$/i, '').trim();
  const teamName = normalizeName(dkName);
  const nickname = teamName.split(' ').slice(1).join(' ');
  const game = finalGames.find(g => {
    const homeNorm = normalizeName(g.homeName);
    const awayNorm = normalizeName(g.awayName);
    return homeNorm === teamName || awayNorm === teamName ||
           (nickname && (homeNorm.endsWith(nickname) || awayNorm.endsWith(nickname)));
  });
  if (!game) return null;

  const homeNorm  = normalizeName(game.homeName);
  const isHome    = homeNorm === teamName || (nickname && homeNorm.endsWith(nickname));
  const teamScore = isHome ? game.homeScore : game.awayScore;
  const oppScore  = isHome ? game.awayScore : game.homeScore;

  if (mkt === 'team_ml') return teamScore > oppScore ? 'won' : 'lost';
  if (mkt === 'team_runline') {
    const line = parseFloat(leg.threshold ?? 0);
    if (teamScore + line === oppScore) return 'void'; // push — scratch this leg
    return (teamScore + line > oppScore) ? 'won' : 'lost';
  }
  return null;
}

// ── 1st inning resolver ───────────────────────────────────────────────────────

// Parse "Away Team @ Home Team" from event_name
function parse1innMatchup(eventName) {
  if (!eventName) return null;
  const m = eventName.match(/^(.+?)\s+@\s+(.+)$/);
  if (!m) return null;
  return { awayName: m[1].trim(), homeName: m[2].trim() };
}

// Find MLB final game matching the parsed matchup (DK names vs MLB API names)
function match1innGame(matchup, finalGames) {
  if (!matchup) return null;
  const aN = normalizeName(matchup.awayName);
  const hN = normalizeName(matchup.homeName);
  return finalGames.find(g => {
    const ga = normalizeName(g.awayName);
    const gh = normalizeName(g.homeName);
    if (ga === aN && gh === hN) return true;
    // nickname suffix match
    const aNick = aN.split(' ').slice(1).join(' ');
    const hNick = hN.split(' ').slice(1).join(' ');
    if (aNick && hNick && ga.endsWith(aNick) && gh.endsWith(hNick)) return true;
    // abbreviation match (e.g. DK short names match MLB abbr)
    if (g.awayAbbr.toLowerCase() === aN && g.homeAbbr.toLowerCase() === hN) return true;
    return false;
  });
}

// Determine if the team in playerName is the away or home side
function get1innSide(playerName, game) {
  const statRe = /\s+(hits?|pitches?|batters?|scores?|runs?|ks?|hr|walks?|strikeouts?)\s*$/i;
  const teamPart = normalizeName(playerName.replace(statRe, '').trim());
  const aN = normalizeName(game.awayName);
  const hN = normalizeName(game.homeName);
  const aAbbr = game.awayAbbr.toLowerCase();
  const hAbbr = game.homeAbbr.toLowerCase();
  const aNick = aN.split(' ').slice(1).join(' ');
  const hNick = hN.split(' ').slice(1).join(' ');

  if (teamPart === aAbbr || teamPart === aN || (aNick && aN.endsWith(teamPart))) return 'away';
  if (teamPart === hAbbr || teamPart === hN || (hNick && hN.endsWith(teamPart))) return 'home';
  return null; // ambiguous
}

// Resolve a 1st-inning leg. Returns 'won' | 'lost' | 'void' | null (null = not ready yet)
// pbpMap: gamePk → { top:{walks,ks,hrs,batters,pitches}, bottom:{...} }
function resolve1stInnLeg(leg, finalGames, linescore1Map, pbpMap) {
  const mkt = leg.market_type;

  const matchup = parse1innMatchup(leg.event_name);
  const game    = match1innGame(matchup, finalGames);
  if (!game) return null; // game not final yet or not found

  const label = (leg.label || '').trim();
  const isOver  = /^over\b/i.test(label);
  const isUnder = /^under\b/i.test(label);
  const isYes   = /^yes$/i.test(label);
  const isNo    = /^no$/i.test(label);
  const exactM  = label.match(/exactly\s+(\d+)/i);
  const exactVal = exactM ? parseInt(exactM[1], 10) : null;

  // ── Play-by-play markets ─────────────────────────────────────────────────
  if (INN1_PBP_MKTS.has(mkt)) {
    const pbp = pbpMap ? pbpMap[game.gamePk] : null;
    if (!pbp) return null; // fetch not done or failed — retry next run

    // top = away team batting; bottom = home team batting
    // Pitches: away pitcher throws in bottom; home pitcher throws in top
    const side = get1innSide(leg.player_name, game); // null for game-level

    switch (mkt) {
      case '1inn_walks_ou': {
        // Game-level: total walks drawn by both teams in inning 1
        const total = pbp.top.walks + pbp.bottom.walks;
        const line  = parseFloat(leg.threshold);
        if (isNaN(line)) return null;
        if (isOver)  return total > line ? 'won' : 'lost';
        if (isUnder) return total < line ? 'won' : 'lost';
        return null;
      }
      case '1inn_batters_ou': {
        if (!side) return null;
        // away pitcher faces home batters in bottom; home pitcher faces away batters in top
        const count = side === 'away' ? pbp.bottom.batters : pbp.top.batters;
        const line  = parseFloat(leg.threshold);
        if (isNaN(line)) return null;
        if (isOver)  return count > line ? 'won' : 'lost';
        if (isUnder) return count < line ? 'won' : 'lost';
        return null;
      }
      case '1inn_pitches_ou': {
        if (!side) return null;
        // away pitcher throws in bottom; home pitcher throws in top
        const pitches = side === 'away' ? pbp.bottom.pitches : pbp.top.pitches;
        const line    = parseFloat(leg.threshold);
        if (isNaN(line)) return null;
        if (isOver)  return pitches > line ? 'won' : 'lost';
        if (isUnder) return pitches < line ? 'won' : 'lost';
        return null;
      }
      case '1inn_pitches_range': {
        if (!side) return null;
        const pitches = side === 'away' ? pbp.bottom.pitches : pbp.top.pitches;
        // label is e.g. "10-14 pitches" or "25+ pitches" or "0-9 pitches"
        const rangeM = label.match(/^(\d+)-(\d+)/);
        const plusM  = label.match(/^(\d+)\+/);
        const zeroM  = label.match(/^0-(\d+)/);
        if (rangeM) {
          const lo = parseInt(rangeM[1], 10), hi = parseInt(rangeM[2], 10);
          return (pitches >= lo && pitches <= hi) ? 'won' : 'lost';
        }
        if (plusM) {
          return pitches >= parseInt(plusM[1], 10) ? 'won' : 'lost';
        }
        if (zeroM) {
          return pitches <= parseInt(zeroM[1], 10) ? 'won' : 'lost';
        }
        return null;
      }
      case '1inn_hr_yn': {
        if (!side) return null;
        // away bats in top; home bats in bottom
        const hrs = side === 'away' ? pbp.top.hrs : pbp.bottom.hrs;
        const hit = hrs > 0;
        if (isYes) return hit ? 'won' : 'lost';
        if (isNo)  return hit ? 'lost' : 'won';
        return null;
      }
      case '1inn_ks_exact': {
        if (!side || exactVal == null) return null;
        // pitcher Ks: away pitcher throws in bottom (home bats), home pitcher throws in top (away bats)
        const ks = side === 'away' ? pbp.bottom.ks : pbp.top.ks;
        return ks === exactVal ? 'won' : 'lost';
      }
      default: return null;
    }
  }

  // ── Linescore markets ────────────────────────────────────────────────────
  const inn1 = linescore1Map[game.gamePk];
  if (!inn1) return null;

  const { away, home } = inn1;

  switch (mkt) {
    case '1inn_ml': {
      if (away.runs == null || home.runs == null) return null;
      const pn = normalizeName(leg.player_name);
      if (pn === 'tie') return away.runs === home.runs ? 'won' : 'lost';
      const side = get1innSide(leg.player_name, game);
      if (!side) return null;
      const myR  = side === 'away' ? away.runs : home.runs;
      const oppR = side === 'away' ? home.runs  : away.runs;
      if (myR > oppR) return 'won';
      return 'lost';
    }

    case '1inn_runs_ou': {
      if (away.runs == null || home.runs == null) return null;
      const total = away.runs + home.runs;
      const line  = parseFloat(leg.threshold);
      if (isNaN(line)) return null;
      if (total === line) return 'void'; // push
      if (isOver)  return total > line ? 'won' : 'lost';
      if (isUnder) return total < line ? 'won' : 'lost';
      return null;
    }

    case '1inn_hits_ou': {
      const side = get1innSide(leg.player_name, game);
      if (!side) return null;
      const h = side === 'away' ? away.hits : home.hits;
      if (h == null) return null;
      const line = parseFloat(leg.threshold);
      if (isNaN(line)) return null;
      if (h === line) return 'void'; // push
      if (isOver)  return h > line ? 'won' : 'lost';
      if (isUnder) return h < line ? 'won' : 'lost';
      return null;
    }

    case '1inn_hits_exact': {
      const side = get1innSide(leg.player_name, game);
      if (!side || exactVal == null) return null;
      const h = side === 'away' ? away.hits : home.hits;
      if (h == null) return null;
      return h === exactVal ? 'won' : 'lost';
    }

    case '1inn_run_yn': {
      const side = get1innSide(leg.player_name, game);
      if (!side) return null;
      const r = side === 'away' ? away.runs : home.runs;
      if (r == null) return null;
      const scored = r > 0;
      if (isYes) return scored ? 'won' : 'lost';
      if (isNo)  return scored ? 'lost' : 'won';
      return null;
    }

    case '1inn_runs_exact': {
      const side = get1innSide(leg.player_name, game);
      if (!side || exactVal == null) return null;
      const r = side === 'away' ? away.runs : home.runs;
      if (r == null) return null;
      return r === exactVal ? 'won' : 'lost';
    }

    default: return null;
  }
}

// ── MLB helpers ───────────────────────────────────────────────────────────────

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
      homeAbbr:  (g.teams?.home?.team?.abbreviation || mlbAbbrFromName(g.teams?.home?.team?.name)).toUpperCase(),
      awayAbbr:  (g.teams?.away?.team?.abbreviation || mlbAbbrFromName(g.teams?.away?.team?.name)).toUpperCase(),
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

// Returns { away: {runs, hits}, home: {runs, hits} } for inning 1
// Returns Live games where inning 1 is fully complete (currentInning >= 2, or inning 1 ended).
// Used so 1inn parlays settle right after the 1st inning finishes, not at game end.
async function getMlbLive1innDoneGames(date) {
  const res = await fetch(`${MLB_API}/schedule?date=${date}&sportId=1&hydrate=linescore`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.dates?.[0]?.games || [])
    .filter(g => {
      if (g.status?.abstractGameState !== 'Live') return false;
      const inn   = g.linescore?.currentInning;
      const state = g.linescore?.inningState || '';
      if (inn == null) return false;
      if (inn >= 2) return true;
      if (inn === 1 && (state === 'End' || state === 'Middle')) return true;
      return false;
    })
    .map(g => ({
      gamePk:    g.gamePk,
      homeName:  g.teams?.home?.team?.name  || '',
      awayName:  g.teams?.away?.team?.name  || '',
      homeAbbr:  (g.teams?.home?.team?.abbreviation || mlbAbbrFromName(g.teams?.home?.team?.name)).toUpperCase(),
      awayAbbr:  (g.teams?.away?.team?.abbreviation || mlbAbbrFromName(g.teams?.away?.team?.name)).toUpperCase(),
      homeScore: g.teams?.home?.score ?? null,
      awayScore: g.teams?.away?.score ?? null,
    }));
}

async function getMlbLinescore(gamePk) {
  const res = await fetch(`${MLB_API}/game/${gamePk}/linescore`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const inn1 = (data.innings || []).find(i => i.num === 1);
  if (!inn1) return null;
  return {
    away: { runs: inn1.away?.runs ?? null, hits: inn1.away?.hits ?? null },
    home: { runs: inn1.home?.runs ?? null, hits: inn1.home?.hits ?? null },
  };
}

// Returns { top, bottom } — each: { walks, ks, hrs, batters, pitches } for inning 1
// top = away team batting, bottom = home team batting
// Pitch side is inverted: away pitcher throws in bottom, home pitcher throws in top
async function getMlbPlayByPlay(gamePk) {
  const res = await fetch(`${MLB_API}/game/${gamePk}/playByPlay`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const inn1 = (data.allPlays || []).filter(p => p.about?.inning === 1);

  function summarize(plays) {
    return {
      walks:   plays.filter(p => p.result?.eventType === 'walk').length,
      ks:      plays.filter(p => p.result?.eventType === 'strikeout').length,
      hrs:     plays.filter(p => p.result?.eventType === 'home_run').length,
      batters: plays.length,
      pitches: plays.reduce((s, p) => s + (p.pitchIndex || []).length, 0),
    };
  }

  return {
    top:    summarize(inn1.filter(p => p.about?.halfInning === 'top')),
    bottom: summarize(inn1.filter(p => p.about?.halfInning === 'bottom')),
  };
}

function extractMlbPlayerStats(boxscore) {
  const map = {};
  for (const side of ['away', 'home']) {
    const players = boxscore?.teams?.[side]?.players || {};
    for (const p of Object.values(players)) {
      const name    = normalizeName(p.person?.fullName || '');
      if (!name) continue;
      const batting  = p.stats?.batting  || {};
      const pitching = p.stats?.pitching || {};
      const merged   = { ...batting, ...pitching };
      const h  = parseInt(batting.hits       || 0);
      merged.hits = h; // always batting hits — pitching spread overwrites otherwise (position players who pitch)
      const d  = parseInt(batting.doubles    || 0);
      const tri = parseInt(batting.triples   || 0);
      const hr  = parseInt(batting.homeRuns  || 0);
      merged.hrbi       = h + parseInt(batting.runs || 0) + parseInt(batting.rbi || 0);
      merged.totalBases = batting.totalBases !== undefined
        ? parseInt(batting.totalBases || 0)
        : (h - d - tri - hr) + 2*d + 3*tri + 4*hr;
      // New full-game prop fields — always sourced from the correct side
      merged.doubles      = d; // explicit batter doubles (pitching spread has its own 'doubles' for allowed)
      merged.singles      = h - d - tri - hr;
      merged.stolenBases  = parseInt(batting.stolenBases   || 0);
      merged.batterWalks  = parseInt(batting.baseOnBalls   || 0);
      merged.pitcherHits  = parseInt(pitching.hits         || 0);
      merged.earnedRuns   = parseInt(pitching.earnedRuns   || 0);
      merged.pitcherWalks = parseInt(pitching.baseOnBalls  || 0);
      merged.hwer         = parseInt(pitching.hits || 0)
                          + parseInt(pitching.baseOnBalls || 0)
                          + parseInt(pitching.earnedRuns  || 0);
      map[name] = merged;
    }
  }
  return map;
}

// ── ESPN helpers (WNBA + NFL + UFC) ──────────────────────────────────────────

async function getEspnFinalGames(baseUrl, date, db = null, proxyKey = '') {
  const yyyymmdd = date.replace(/-/g, '');
  function parseEvents(data) {
    return (data.events || [])
      .filter(e => {
        const st = e.competitions?.[0]?.status?.type;
        return st?.completed || (st?.name || '').toUpperCase().includes('FINAL');
      })
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
  }
  try {
    const isNfl = baseUrl === ESPN_NFL;
    // NFL: ESPN blocks CF IPs — route through VPS proxy (same as WNBA).
    // Fetch regular season and preseason in parallel; VPS proxies the request from a non-CF IP.
    let urls;
    if (isNfl && proxyKey) {
      const base = `${VPS_HOST}/espn-nfl/scoreboard?dates=${yyyymmdd}&key=${encodeURIComponent(proxyKey)}`;
      urls = [base, base + '&seasontype=1'];
    } else {
      urls = isNfl
        ? [`${baseUrl}/scoreboard?dates=${yyyymmdd}`, `${baseUrl}/scoreboard?dates=${yyyymmdd}&seasontype=1`]
        : [`${baseUrl}/scoreboard?dates=${yyyymmdd}`];
    }

    const responses = await Promise.all(urls.map(url =>
      fetch(url, { headers: isNfl && proxyKey ? {} : ESPN_HEADERS, signal: AbortSignal.timeout(10000) })
        .then(async r => ({ ok: r.ok, status: r.status, data: r.ok ? await r.json() : null, url }))
        .catch(e => ({ ok: false, status: 0, data: null, url, err: e.message }))
    ));

    // Store NFL debug info in D1
    if (isNfl && db) {
      const now = Math.floor(Date.now() / 1000);
      const debugInfo = responses.map(r => ({
        url: r.url, status: r.status, ok: r.ok,
        totalEvents: (r.data?.events || []).length,
        finalEvents: r.ok ? parseEvents(r.data).length : 0,
        err: r.err || null,
        sample: (r.data?.events || []).slice(0, 2).map(e => ({
          name: e.name, status: e.competitions?.[0]?.status?.type?.name,
          completed: e.competitions?.[0]?.status?.type?.completed,
        })),
      }));
      await db.prepare(
        'INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at'
      ).bind(`nfl_espn_debug_${yyyymmdd}`, JSON.stringify({ ts: now, date: yyyymmdd, v: 'b7c208e', proxyKeyLen: proxyKey.length, responses: debugInfo }), now).run().catch(() => {});
    }

    // Merge + deduplicate by eventId
    const seen = new Set();
    const allGames = [];
    for (const r of responses) {
      if (!r.ok || !r.data) continue;
      for (const g of parseEvents(r.data)) {
        if (!seen.has(g.eventId)) { seen.add(g.eventId); allGames.push(g); }
      }
    }
    return allGames;
  } catch(e) { return []; }
}

async function getWnbaFinalGames(date, proxyKey) {
  const yyyymmdd = date.replace(/-/g, '');
  try {
    const res = await fetch(
      `${VPS_HOST}/espn-wnba/scoreboard?dates=${yyyymmdd}&key=${encodeURIComponent(proxyKey)}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.events || [])
      .filter(e => {
        const st = e.competitions?.[0]?.status?.type;
        return st?.completed || (st?.name || '').toUpperCase().includes('FINAL');
      })
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

async function getWnbaPlayerStats(date, proxyKey) {
  const yyyymmdd = date.replace(/-/g, '');
  try {
    const sbRes = await fetch(
      `${VPS_HOST}/espn-wnba/scoreboard?dates=${yyyymmdd}&key=${encodeURIComponent(proxyKey)}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!sbRes.ok) return {};
    const sbData = await sbRes.json();
    // Only settle from completed/final games — in-progress stats would produce false losses.
    const eventIds = (sbData.events || [])
      .filter(e => {
        const st = e.competitions?.[0]?.status?.type;
        return st?.completed || (st?.name || '').toUpperCase().includes('FINAL');
      })
      .map(e => e.id);

    const summaries = await Promise.all(eventIds.map(async id => {
      try {
        const r = await fetch(
          `${VPS_HOST}/espn-wnba/summary?event=${id}&key=${encodeURIComponent(proxyKey)}`,
          { signal: AbortSignal.timeout(10000) }
        );
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
            if (s.length === 0) continue; // DNP — empty stats array means did not play; treat as not in box score so the leg voids rather than losing
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

// ── UFC helper ────────────────────────────────────────────────────────────────

async function getUfcResults(date) {
  const yyyymmdd = date.replace(/-/g, '');
  try {
    const res = await fetch(`${ESPN_MMA}/scoreboard?dates=${yyyymmdd}`, {
      headers: ESPN_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const results = {};
    for (const event of (data.events || [])) {
      for (const comp of (event.competitions || [])) {
        const compSt = comp.status?.type;
        if (!compSt?.completed && compSt?.name !== 'STATUS_FINAL') continue;
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

// ── Main handler ──────────────────────────────────────────────────────────────

async function handleRequest({ request, env }) {
  const url       = new URL(request.url);
  const cronKey   = url.searchParams.get('_cron_key');
  const debug     = url.searchParams.has('debug');
  const debugDate = url.searchParams.get('date');
  const lastRun   = url.searchParams.has('last_run');

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

  if (debug && debugDate && /^\d{4}-\d{2}-\d{2}$/.test(debugDate)) {
    const yyyymmdd = debugDate.replace(/-/g, '');
    let espnStatus = null, espnEventCount = 0, espnFinalCount = 0, espnError = null;
    try {
      const probe = await fetch(`${ESPN_WNBA}/scoreboard?dates=${yyyymmdd}`, {
        headers: ESPN_HEADERS, signal: AbortSignal.timeout(8000),
      });
      espnStatus = probe.status;
      if (probe.ok) {
        const d = await probe.json();
        espnEventCount = (d.events || []).length;
        espnFinalCount = (d.events || []).filter(e => {
          const st = e.competitions?.[0]?.status?.type;
          return st?.completed || (st?.name || '').toUpperCase().includes('FINAL');
        }).length;
      }
    } catch(e) { espnError = e.message; }

    const proxyKey = env.VPS_DK_KEY || 'rax-dk-9x3m7p2q';
    let vpsStatus = null, vpsEventCount = 0, vpsError = null, vpsBody = null;
    try {
      const vpsProbe = await fetch(
        `${VPS_HOST}/espn-wnba/scoreboard?dates=${yyyymmdd}&key=${encodeURIComponent(proxyKey)}`,
        { signal: AbortSignal.timeout(10000) }
      );
      vpsStatus = vpsProbe.status;
      if (vpsProbe.ok) {
        const vd = await vpsProbe.json();
        vpsEventCount = (vd.events || []).length;
      } else {
        vpsBody = await vpsProbe.text().catch(() => null);
      }
    } catch(e) { vpsError = e.message; }

    const [mlbGames, wnbaGames, nflGames, ufcResults, wnbaStats] = await Promise.all([
      getMlbFinalGames(debugDate),
      getWnbaFinalGames(debugDate, proxyKey),
      getEspnFinalGames(ESPN_NFL, debugDate, env.DB, proxyKey),
      getUfcResults(debugDate),
      getWnbaPlayerStats(debugDate, proxyKey),
    ]);
    const mlbStats = {};
    const mlbLinescore1 = {};
    await Promise.all(mlbGames.map(async g => {
      const [bs, ls] = await Promise.all([
        getMlbBoxscore(g.gamePk).catch(() => null),
        getMlbLinescore(g.gamePk).catch(() => null),
      ]);
      if (bs) Object.assign(mlbStats, extractMlbPlayerStats(bs));
      if (ls) mlbLinescore1[g.gamePk] = ls;
    }));
    return new Response(JSON.stringify({
      debugDate,
      espnWnbaProbe: { status: espnStatus, totalEvents: espnEventCount, finalEvents: espnFinalCount, error: espnError },
      vpsProbe: { host: VPS_HOST, status: vpsStatus, events: vpsEventCount, error: vpsError, body: vpsBody, keyLength: proxyKey.length },
      mlbGames:    mlbGames.map(g => `${g.awayName} ${g.awayScore} @ ${g.homeName} ${g.homeScore}`),
      wnbaGames:   wnbaGames.map(g => `${g.awayName} ${g.awayScore} @ ${g.homeName} ${g.homeScore}`),
      nflGames:    nflGames.map(g => `${g.awayName} ${g.awayScore} @ ${g.homeName} ${g.homeScore}`),
      ufcFights:   Object.entries(ufcResults).map(([n, r]) => `${n}: ${JSON.stringify(r)}`),
      wnbaPlayers: Object.keys(wnbaStats),
      mlbPlayers:  Object.keys(mlbStats).length + ' players',
      mlbLinescore1: Object.fromEntries(Object.entries(mlbLinescore1).map(([pk, v]) => [
        mlbGames.find(g => String(g.gamePk) === String(pk))
          ? `${mlbGames.find(g => String(g.gamePk) === String(pk)).awayName} @ ${mlbGames.find(g => String(g.gamePk) === String(pk)).homeName}`
          : pk,
        v,
      ])),
    }, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }

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
    "SELECT id, user_id, payout_rax, stake_rax, rs_username FROM parlays WHERE status='active'"
  ).all();
  if (!parlays.length) return cacheAndReturn({ settled: 0, reason: 'no_active_parlays' });

  // 2. Load pending legs — active parlays for settlement, plus already-settled parlays so
  // per-leg outcomes get filled in even after the parlay is decided.
  const { results: allLegs } = await env.DB.prepare(
    "SELECT pl.id, pl.parlay_id, pl.player_name, pl.market_id, pl.threshold, " +
    "pl.direction, pl.game_date, pl.market_type, pl.status, pl.sport, " +
    "pl.label, pl.event_name, pl.implied_prob, p.status AS parlay_status " +
    "FROM parlay_legs pl " +
    "JOIN parlays p ON p.id = pl.parlay_id " +
    "WHERE pl.status = 'pending' AND p.status IN ('active','won','lost','voided')"
  ).all();

  // Separate legs by whether their parlay still needs deciding
  const settledParlayLegs = allLegs.filter(l => l.parlay_status !== 'active');
  if (!allLegs.length) return cacheAndReturn({ settled: 0, reason: 'no_pending_legs' });

  const eligibleLegs = allLegs.filter(l => l.game_date <= todayUtc);
  if (!eligibleLegs.length) return cacheAndReturn({ settled: 0, reason: 'all_games_future', todayUtc });

  // NFL team nicknames — used to detect NFL team legs regardless of stored sport field
  const NFL_NICKNAMES = new Set([
    'bears','bengals','bills','broncos','browns','buccaneers','cardinals','chargers',
    'chiefs','colts','commanders','cowboys','dolphins','eagles','falcons','49ers',
    'giants','jaguars','jets','lions','packers','panthers','patriots','raiders',
    'rams','ravens','saints','seahawks','steelers','texans','titans','vikings',
  ]);
  // WNBA team nicknames
  const WNBA_NICKNAMES = new Set([
    'aces','dream','fever','liberty','lynx','mercury','mystics','sky','sparks','storm','sun','wings',
  ]);

  function isNflTeamLeg(leg) {
    const mkt = leg.market_type;
    if (mkt !== 'team_ml' && mkt !== 'team_runline' && mkt !== 'team_total') return false;
    const name = (leg.player_name || '').toLowerCase();
    return NFL_NICKNAMES.has(name.split(/[\s@]+/).find(w => NFL_NICKNAMES.has(w)) || '');
  }
  function isWnbaTeamLeg(leg) {
    const mkt = leg.market_type;
    if (mkt !== 'team_ml' && mkt !== 'team_runline' && mkt !== 'team_total') return false;
    const name = (leg.player_name || '').toLowerCase();
    return WNBA_NICKNAMES.has(name.split(/[\s@]+/).find(w => WNBA_NICKNAMES.has(w)) || '');
  }

  function legSportOf(leg) {
    const s   = leg.sport || '';
    const mkt = leg.market_type;
    if (mkt.startsWith('1inn_'))                                 return 'mlb';
    if ((mkt in MLB_STAT_FIELD) && !WNBA_PROP_TYPES.has(mkt))   return 'mlb';
    // For team legs, use player_name to detect sport regardless of stored sport field
    // (place.js sometimes stores wrong sport when user mixes sport tabs)
    if (mkt === 'team_ml' || mkt === 'team_runline' || mkt === 'team_total') {
      if (isNflTeamLeg(leg))  return 'nfl';
      if (isWnbaTeamLeg(leg)) return 'wnba';
      return 'mlb';
    }
    if (s === 'wnba' || s === 'basketball_wnba')                 return 'wnba';
    if (s === 'nfl'  || s === 'american_football_nfl')           return 'nfl';
    if (s === 'ufc')                                             return 'ufc';
    if (mkt === 'ufc_ml' || mkt === 'ufc_total')                 return 'ufc';
    if (WNBA_PROP_TYPES.has(mkt))                                return 'wnba';
    return 'mlb';
  }

  function normForLookup(name) {
    return normalizeName(name.replace(/\s*\([A-Z0-9]{2,5}\)\s*$/, ''));
  }

  // 3. Fetch external data per (sport, date)
  const uniqueDates = [...new Set(eligibleLegs.map(l => l.game_date))];

  const mlbGamesMap     = {};
  const mlb1innGamesMap = {}; // final games + live games past inning 1, for 1inn settle
  const mlbStatsMap     = {};
  const mlbLinescore1Map= {}; // date → { gamePk → { away:{runs,hits}, home:{runs,hits} } }
  const mlbPbpMap       = {}; // date → { gamePk → { top:{walks,ks,hrs,batters,pitches}, bottom:{...} } }
  const wnbaGamesMap    = {};
  const wnbaStatsMap    = {};
  const nflGamesMap     = {};
  const ufcMap          = {};

  const hasMlbOnDate    = date => eligibleLegs.some(l => l.game_date === date && legSportOf(l) === 'mlb');
  const hasWnbaOnDate   = date => eligibleLegs.some(l => l.game_date === date && legSportOf(l) === 'wnba');
  const hasNflOnDate    = date => eligibleLegs.some(l => l.game_date === date && legSportOf(l) === 'nfl');
  const hasUfcOnDate    = date => eligibleLegs.some(l => l.game_date === date && legSportOf(l) === 'ufc');
  const has1innOnDate   = date => eligibleLegs.some(l => l.game_date === date && l.market_type.startsWith('1inn_'));
  const has1innPbpOnDate= date => eligibleLegs.some(l => l.game_date === date && INN1_PBP_MKTS.has(l.market_type));

  const proxyKey = env.VPS_DK_KEY || 'rax-dk-9x3m7p2q';

  await Promise.all(uniqueDates.map(async date => {
    const [mlbGames, wnbaGames, nflGames, ufcResults] = await Promise.all([
      hasMlbOnDate(date)  ? getMlbFinalGames(date)             : Promise.resolve([]),
      hasWnbaOnDate(date) ? getWnbaFinalGames(date, proxyKey)  : Promise.resolve([]),
      hasNflOnDate(date)  ? getEspnFinalGames(ESPN_NFL, date, env.DB, proxyKey)  : Promise.resolve([]),
      hasUfcOnDate(date)  ? getUfcResults(date)                : Promise.resolve({}),
    ]);

    mlbGamesMap[date]  = mlbGames;
    wnbaGamesMap[date] = wnbaGames;
    nflGamesMap[date]  = nflGames;
    ufcMap[date]       = ufcResults;

    // MLB boxscores and WNBA stats are fetched in parallel to avoid sequential timeout
    const [mlbBlock, wnbaStats] = await Promise.all([
      // ── MLB block ──────────────────────────────────────────────────────────
      (async () => {
        if (!hasMlbOnDate(date)) return null;
        const fetch1inn    = has1innOnDate(date);
        const fetch1innPbp = has1innPbpOnDate(date);
        const allStats   = {};
        const linescore1 = {};
        const pbp1       = {};

        if (mlbGames.length) {
          await Promise.all(mlbGames.map(async g => {
            const [bs, ls, pbp] = await Promise.all([
              getMlbBoxscore(g.gamePk).catch(() => null),
              fetch1inn    ? getMlbLinescore(g.gamePk).catch(() => null)  : Promise.resolve(null),
              fetch1innPbp ? getMlbPlayByPlay(g.gamePk).catch(() => null) : Promise.resolve(null),
            ]);
            if (bs)  Object.assign(allStats, extractMlbPlayerStats(bs));
            if (ls)  linescore1[g.gamePk] = ls;
            if (pbp) pbp1[g.gamePk]       = pbp;
          }));
        }

        let mlb1innGames = mlbGames;
        if (fetch1inn) {
          const live = await getMlbLive1innDoneGames(date).catch(() => []);
          const newLive = live.filter(g => !mlbGames.some(fg => fg.gamePk === g.gamePk));
          if (newLive.length) {
            await Promise.all(newLive.map(async g => {
              const [ls, pbp] = await Promise.all([
                getMlbLinescore(g.gamePk).catch(() => null),
                fetch1innPbp ? getMlbPlayByPlay(g.gamePk).catch(() => null) : Promise.resolve(null),
              ]);
              if (ls)  linescore1[g.gamePk] = ls;
              if (pbp) pbp1[g.gamePk]       = pbp;
            }));
          }
          mlb1innGames = [...mlbGames, ...newLive];
        }
        return { allStats, linescore1, pbp1, mlb1innGames };
      })(),
      // ── WNBA stats block ───────────────────────────────────────────────────
      hasWnbaOnDate(date) ? getWnbaPlayerStats(date, proxyKey) : Promise.resolve({}),
    ]);

    if (mlbBlock) {
      mlbStatsMap[date]      = mlbBlock.allStats;
      mlbLinescore1Map[date] = mlbBlock.linescore1;
      mlbPbpMap[date]        = mlbBlock.pbp1;
      mlb1innGamesMap[date]  = mlbBlock.mlb1innGames;
    } else {
      mlbStatsMap[date]      = {};
      mlbLinescore1Map[date] = {};
      mlbPbpMap[date]        = {};
      mlb1innGamesMap[date]  = [];
    }
    wnbaStatsMap[date] = wnbaStats || {};
  }));

  if (debug) {
    return new Response(JSON.stringify({
      todayUtc, staleDate,
      dates: uniqueDates.map(date => ({
        date,
        mlbGames:     mlbGamesMap[date].map(g => `${g.awayAbbr} ${g.awayScore} @ ${g.homeAbbr} ${g.homeScore}`),
        mlb1innGames: (mlb1innGamesMap[date] || []).map(g => ({ gamePk: g.gamePk, away: g.awayAbbr, home: g.homeAbbr })),
        linescore1Keys: Object.keys(mlbLinescore1Map[date] || {}),
        has1inn: has1innOnDate(date),
        wnbaGames: wnbaGamesMap[date].map(g => `${g.awayName} ${g.awayScore} @ ${g.homeName} ${g.homeScore}`),
        nflGames:  nflGamesMap[date].map(g => `${g.awayName} ${g.awayScore} @ ${g.homeName} ${g.homeScore}`),
        ufcFights: Object.entries(ufcMap[date] || {}).map(([n, r]) => `${n}: ${JSON.stringify(r)}`),
        legs: eligibleLegs.filter(l => l.game_date === date).map(l => {
          const sport = legSportOf(l);
          const mkt   = l.market_type;
          const is1inn = mkt.startsWith('1inn_');
          const isTeam = mkt === 'team_ml' || mkt === 'team_runline' || mkt === 'team_total';

          if (is1inn) {
            const outcome = resolve1stInnLeg(l, mlb1innGamesMap[date] || [], mlbLinescore1Map[date] || {}, mlbPbpMap[date] || {});
            return { player: l.player_name, label: l.label, event_name: l.event_name, sport: 'mlb', type: mkt, outcome: outcome ?? 'not_resolved_yet' };
          }
          if (isTeam) {
            const games = sport === 'wnba' ? wnbaGamesMap[date] : sport === 'nfl' ? nflGamesMap[date] : mlbGamesMap[date];
            const outcome = games.length ? resolveTeamLeg(l, games) : null;
            return { player: l.player_name, sport, type: 'team_market', outcome: outcome ?? 'not_final_yet' };
          }
          if (sport === 'ufc') {
            const lastName = normalizeName(l.player_name).split(' ').pop();
            const result   = (ufcMap[date] || {})[lastName];
            return { player: l.player_name, sport: 'ufc', type: mkt, found: !!result, result: result ?? null };
          }
          if (sport === 'wnba') {
            const stats   = (wnbaStatsMap[date] || {})[normForLookup(l.player_name)];
            const field   = WNBA_STAT_FIELD[mkt];
            const statVal = stats ? stats[field] ?? null : null;
            const outcome = statVal == null ? null
              : (l.direction === 'more' ? statVal > l.threshold : statVal < l.threshold) ? 'won' : 'lost';
            return { player: l.player_name, sport: 'wnba', market_type: mkt, field, statVal, outcome };
          }
          const norm    = normForLookup(l.player_name);
          const stats   = (mlbStatsMap[date] || {})[norm] || null;
          const field   = MLB_STAT_FIELD[mkt] || mkt;
          const rawVal  = stats?.[field];
          const statVal = rawVal != null ? parseFloat(rawVal) : null;
          const outcome = statVal == null ? null
            : (l.direction === 'more' ? statVal > l.threshold : statVal < l.threshold) ? 'won' : 'lost';
          return { player: l.player_name, sport: 'mlb', normalized: norm, found: !!stats, market_type: mkt, field, threshold: l.threshold, direction: l.direction, statVal, outcome };
        }),
      })),
    }, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }

  // 4. Resolve each eligible leg
  const legOutcomes = {};
  for (const leg of eligibleLegs) {
    const sport  = legSportOf(leg);
    const mkt    = leg.market_type;
    const is1inn = mkt.startsWith('1inn_');
    const isTeam = mkt === 'team_ml' || mkt === 'team_runline' || mkt === 'team_total';

    if (is1inn) {
      const games  = mlb1innGamesMap[leg.game_date]   || [];
      const ls1Map = mlbLinescore1Map[leg.game_date]  || {};
      const pbpM   = mlbPbpMap[leg.game_date]         || {};
      const outcome = games.length ? resolve1stInnLeg(leg, games, ls1Map, pbpM) : null;
      legOutcomes[leg.id] = (outcome === null && leg.game_date < staleDate) ? 'void' : outcome;
      continue;
    }

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
      if (mkt === 'ufc_ml') {
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
      const wnbaStats = (wnbaStatsMap[leg.game_date] || {})[normForLookup(leg.player_name)];
      if (!wnbaStats) {
        // If this player's specific game was final (by event_id), they DNP'd — void immediately.
        // Otherwise fall back to stale-date check.
        const gamesForDate = wnbaGamesMap[leg.game_date] || [];
        const gameFinal = gamesForDate.some(g => String(g.eventId) === String(leg.event_id));
        legOutcomes[leg.id] = (gameFinal || leg.game_date < staleDate) ? 'void' : null;
        continue;
      }
      const field   = WNBA_STAT_FIELD[mkt];
      if (!field) { legOutcomes[leg.id] = null; continue; }
      const statVal = wnbaStats[field];
      if (statVal == null) { legOutcomes[leg.id] = null; continue; }
      legOutcomes[leg.id] = statVal === leg.threshold ? 'void'
        : (leg.direction === 'more' ? statVal > leg.threshold : statVal < leg.threshold) ? 'won' : 'lost';
      continue;
    }

    // MLB player prop
    const playerStats = (mlbStatsMap[leg.game_date] || {})[normForLookup(leg.player_name)];
    if (!playerStats) {
      // If the player's specific game is already Final, they were scratched — void immediately
      const matchup = parse1innMatchup(leg.event_name);
      const gameFinal = matchup ? !!match1innGame(matchup, mlbGamesMap[leg.game_date] || []) : false;
      legOutcomes[leg.id] = (gameFinal || leg.game_date < staleDate) ? 'void' : null;
      continue;
    }
    const statField = MLB_STAT_FIELD[mkt] || mkt;
    const rawVal    = playerStats[statField];
    if (rawVal == null) { legOutcomes[leg.id] = null; continue; }
    const statVal = parseFloat(rawVal);
    legOutcomes[leg.id] = statVal === leg.threshold ? 'void'
      : (leg.direction === 'more' ? statVal > leg.threshold : statVal < leg.threshold) ? 'won' : 'lost';
  }

  // 5. Settle parlays where all eligible legs are resolved
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
    const resolvedLegs = outcomes.filter(o => o.outcome !== null);
    const anyLostEarly = resolvedLegs.some(o => o.outcome === 'lost');

    if (stillWaiting.length && !anyLostEarly) {
      report.push({ parlayId: parlay.id, status: 'waiting', waiting: stillWaiting.map(o => o.player) });
      continue;
    }

    const voidedLegs   = resolvedLegs.filter(o => o.outcome === 'void');
    const activeLegs   = resolvedLegs.filter(o => o.outcome !== 'void');
    const anyVoid      = voidedLegs.length > 0;
    const anyLost      = activeLegs.some(o => o.outcome === 'lost');

    // Determine result and final payout
    let parlayResult, finalPayout;

    if (!anyVoid) {
      // No scratches — normal settlement
      parlayResult = anyLost ? 'lost' : 'won';
      finalPayout  = parlay.payout_rax;
    } else if (activeLegs.length < 2) {
      // 2-leg slip with one scratch (or all scratched) — full stake refund
      parlayResult = 'voided';
      finalPayout  = parlay.stake_rax;
    } else if (anyLost) {
      // Scratch on the slip but another leg also lost — just a loss
      parlayResult = 'lost';
      finalPayout  = 0;
    } else {
      // All remaining legs won — recalculate payout without the voided legs
      const newTrueProb = activeLegs.reduce((acc, o) => {
        const leg = allLegs.find(l => l.id === o.legId);
        return acc * (leg ? parseFloat(leg.implied_prob) : 1);
      }, 1);
      parlayResult = 'won';
      finalPayout  = Math.min(Math.floor(parlay.stake_rax * 0.70 / newTrueProb), 10000);
    }

    for (const o of outcomes) {
      if (o.outcome === null) continue;
      await env.DB.prepare("UPDATE parlay_legs SET status=?, settled_at=? WHERE id=?")
        .bind(o.outcome, now, o.legId).run();
    }

    if (parlayResult === 'lost') {
      await env.DB.prepare("UPDATE parlays SET status='lost', settled_at=? WHERE id=?").bind(now, parlay.id).run();
    } else if (parlayResult === 'voided') {
      await env.DB.batch([
        env.DB.prepare("UPDATE parlays SET status='voided', settled_at=? WHERE id=?").bind(now, parlay.id),
        env.DB.prepare(
          'INSERT OR IGNORE INTO payout_queue (parlay_id, user_id, rs_username, payout_rax, offer_amount, created_at) VALUES (?,?,?,?,?,?)'
        ).bind(parlay.id, parlay.user_id, parlay.rs_username, finalPayout, finalPayout, now),
      ]);
    } else {
      // Won — update payout_rax in case it was recalculated after a scratch
      await env.DB.batch([
        env.DB.prepare("UPDATE parlays SET status='won', payout_rax=?, settled_at=? WHERE id=?").bind(finalPayout, now, parlay.id),
        env.DB.prepare(
          'INSERT OR IGNORE INTO payout_queue (parlay_id, user_id, rs_username, payout_rax, offer_amount, created_at) VALUES (?,?,?,?,?,?)'
        ).bind(parlay.id, parlay.user_id, parlay.rs_username, finalPayout, finalPayout, now),
      ]);
    }

    totalSettled++;
    report.push({ parlayId: parlay.id, result: parlayResult, legs: outcomes });
  }

  // 6. Fill in per-leg outcomes for already-settled parlays (won/lost/voided).
  // The parlay result doesn't change — just update the leg status so the slip UI
  // shows each leg's actual outcome rather than leaving them stuck as pending.
  let legsFilled = 0;
  for (const leg of settledParlayLegs) {
    const outcome = legOutcomes[leg.id];
    if (!outcome) continue; // game not final yet — leave pending
    await env.DB.prepare("UPDATE parlay_legs SET status=?, settled_at=? WHERE id=?")
      .bind(outcome, now, leg.id).run();
    legsFilled++;
  }

  // 7. Re-evaluate recently-lost parlays for DNP corrections.
  // If a WNBA parlay was settled as 'lost' because a player appeared in ESPN's box score
  // with empty stats (DNP), all legs now resolve to 'void' — refund the stake.
  const dnpRefunds = [];
  try {
    const recentLost = await env.DB.prepare(
      "SELECT id, user_id, stake_rax, rs_username FROM parlays WHERE status='lost' AND settled_at > ?"
    ).bind(now - 3 * 86400).all();

    for (const p of (recentLost.results || [])) {
      const legRes = await env.DB.prepare(
        "SELECT id, sport, event_id, market_type, player_name, threshold, direction, status, game_date FROM parlay_legs WHERE parlay_id=?"
      ).bind(p.id).all();
      const pLegs = legRes.results || [];

      // Only consider all-WNBA parlays
      if (!pLegs.length) continue;
      if (!pLegs.every(l => l.sport === 'wnba' || l.sport === 'basketball_wnba')) continue;

      // Check every leg: it must either already be void, or be a DNP (player absent from final-game stats)
      let allVoidable = true;
      for (const l of pLegs) {
        if (l.status === 'void' || l.status === 'voided') continue;
        if (l.status === 'won') { allVoidable = false; break; }
        // For 'lost' or 'pending' legs: check if the player DNP'd in a final game
        const statsForDate = wnbaStatsMap[l.game_date] || {};
        const hasStats = !!statsForDate[normForLookup(l.player_name)];
        if (hasStats) { allVoidable = false; break; } // player actually played — real loss
        const gamesForDate = wnbaGamesMap[l.game_date] || [];
        const gameWasFinal = gamesForDate.some(g => String(g.eventId) === String(l.event_id));
        if (!gameWasFinal) { allVoidable = false; break; } // can't confirm game was final
      }
      if (!allVoidable) continue;

      // All legs DNP'd in final games — re-settle to voided and refund stake
      const legUpdates = pLegs
        .filter(l => l.status !== 'void' && l.status !== 'voided')
        .map(l => env.DB.prepare("UPDATE parlay_legs SET status='void', settled_at=? WHERE id=?").bind(now, l.id));
      await env.DB.batch([
        env.DB.prepare("UPDATE parlays SET status='voided', settled_at=? WHERE id=? AND status='lost'").bind(now, p.id),
        ...legUpdates,
        env.DB.prepare(
          'INSERT OR IGNORE INTO payout_queue (parlay_id, user_id, rs_username, payout_rax, offer_amount, created_at) VALUES (?,?,?,?,?,?)'
        ).bind(p.id, p.user_id, p.rs_username, p.stake_rax, p.stake_rax, now),
      ]);
      dnpRefunds.push(p.id);
    }
  } catch(_) { /* non-fatal — DNP re-evaluation best-effort only */ }

  return cacheAndReturn({ settled: totalSettled, legsFilled, dnpRefunds, report });
}

// For cron POST calls: return immediately and run heavy work via waitUntil so
// the client (alert-cron with 25s timeout) never disconnects before we're done.
// For GET (admin debug / last_run): run synchronously so results come back inline.
export async function onRequestPost(ctx) {
  const { request, env, waitUntil } = ctx;
  const url     = new URL(request.url);
  const cronKey = url.searchParams.get('_cron_key');
  // Quick auth — same logic as handleRequest
  if (!env.CRON_SECRET || cronKey !== env.CRON_SECRET) {
    const session = await getSession(request, env.DB);
    const userRow = session
      ? await env.DB.prepare('SELECT is_admin FROM users WHERE id=?').bind(session.user_id).first()
      : null;
    if (!userRow?.is_admin) return err('Unauthorized', 401);
  }
  // Background execution — detached from the HTTP response so a client timeout
  // (or CF killing the outbound fetch) never aborts the settling work mid-run.
  waitUntil(
    handleRequest(ctx).catch(async e => {
      const now = Math.floor(Date.now() / 1000);
      try {
        await env.DB.prepare(
          "INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES('auto_settle_error',?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at"
        ).bind(JSON.stringify({ ts: now, error: e.message, stack: (e.stack || '').slice(0, 800) }), now).run();
      } catch(_) {}
    })
  );
  return ok({ status: 'processing' });
}

export async function onRequestGet(ctx) {
  try {
    return await handleRequest(ctx);
  } catch (e) {
    return ok({ settled: 0, error: e.message });
  }
}
