// functions/api/parlays/auto-settle.js v3
// POST /api/parlays/auto-settle?_cron_key=CRON_SECRET
// GET  /api/parlays/auto-settle?_cron_key=CRON_SECRET&debug  (admin debug)
//
// Settles active parlays using sport-specific external APIs:
//   MLB  — MLB Stats API boxscores + schedule + linescore (1st inn)
//   WNBA — ESPN WNBA scoreboard + summary
//   NFL  — ESPN NFL scoreboard
//   UFC  — ESPN MMA scoreboard
// Reliability: only settles Final/completed games; stale legs voided after STALE_DAYS.

import { ok, err }       from '../../_lib/response.js';
import { getSession }    from '../../_lib/session.js';
import { hashidsEncode } from '../../_lib/hashids.js';

const RS_BASE        = 'https://web.realapp.com';
const RS_DEVICE_UUID = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';

const ONE_LEG_MESSAGES = [
  (n, p) => `🔥 One leg left. Lock in, this is it.`,
  (n, p) => `💀 Last leg. You're one win away from ${p} Rax.`,
  (n, p) => `🎯 Final leg on your ${n}-legger. ${p} Rax is on the line.`,
  (n, p) => `🏆 You're one leg away from winning ${p} Rax. Let's go.`,
  (n, p) => `⚡ One leg stands between you and ${p} Rax. Hold tight.`,
  (n, p) => `😤 ${n}-leg parlay, one leg left. Don't fumble it now.`,
  (n, p) => `🎰 Last leg of your ${n}-legger. ${p} Rax waiting for you.`,
  (n, p) => `🤑 One leg left — hit this and collect ${p} Rax.`,
  (n, p) => `👀 Your slip is sweating. One leg left, ${p} Rax on deck.`,
  (n, p) => `🔔 One leg left on your parlay. ${p} Rax says it hits.`,
];

function buildRsHeaders(authInfo, sessionToken, withBody = false) {
  const h = {
    'Accept':             'application/json',
    'Accept-Language':    'en-US,en;q=0.9',
    'Origin':             'https://www.realapp.com',
    'Referer':            'https://www.realapp.com/',
    'User-Agent':         'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
    'real-auth-info':     authInfo,
    'real-session-token': sessionToken,
    'real-device-uuid':   RS_DEVICE_UUID,
    'real-device-type':   'desktop_web',
    'real-version':       '35',
    'real-request-token': hashidsEncode(Date.now()),
    'real-device-name':   '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
  };
  if (withBody) h['Content-Type'] = 'application/json';
  return h;
}

const MLB_API    = 'https://statsapi.mlb.com/api/v1';

// MLB Stats API schedule endpoint doesn't include team.abbreviation — derive from name
const MLB_ABBR_FROM_NAME = {
  'arizona diamondbacks': 'ARI', 'atlanta braves': 'ATL', 'baltimore orioles': 'BAL',
  'boston red sox': 'BOS', 'chicago cubs': 'CHC', 'chicago white sox': 'CWS',
  'cincinnati reds': 'CIN', 'cleveland guardians': 'CLE', 'colorado rockies': 'COL',
  'detroit tigers': 'DET', 'houston astros': 'HOU', 'kansas city royals': 'KC',
  'los angeles angels': 'LAA', 'los angeles dodgers': 'LAD', 'miami marlins': 'MIA',
  'milwaukee brewers': 'MIL', 'minnesota twins': 'MIN', 'new york mets': 'NYM',
  'new york yankees': 'NYY', 'oakland athletics': 'OAK', 'sacramento athletics': 'SAC', 'athletics': 'ATH',
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

// Soccer: ESPN stat fields per market type.
// sport field stored as 'soccer_{espnSlug}' (e.g. 'soccer_usa.1', 'soccer_eng.1')
const SOCCER_STAT_FIELD = {
  goalscorer: null,             // totalGoals >= 1
  sot:        'shotsOnTarget',
  assists:    'goalAssists',
  saves:      'saves',
  offsides:   'offsides',
  fouls_won:  'foulsSuffered',
};
const SOCCER_PROP_TYPES = new Set(Object.keys(SOCCER_STAT_FIELD));

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
  home_runs:    'homeRuns',
};

const WNBA_STAT_FIELD = {
  pts: 'pts', reb: 'reb', ast: 'ast', fg3m: 'fg3m',
  pra: 'pra', pa: 'pa', pr: 'pr', ra: 'ra',
};
const DD_TD_CATS = ['pts', 'reb', 'ast', 'stl', 'blk'];
const WNBA_PROP_TYPES = new Set([...Object.keys(WNBA_STAT_FIELD), 'double_double', 'triple_double']);

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
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
    .replace(/\s+(?:jr\.?|sr\.?|ii|iii|iv)$/, ''); // strip generational suffixes (e.g. "Michael Harris II" → "michael harris")
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

// DK display names that differ from MLB API abbreviations (e.g. "A's" → "ATH")
const DK_MLB_ALIASES = { "a's": 'ATH' };

// Find MLB final game matching the parsed matchup (DK names vs MLB API names)
function match1innGame(matchup, finalGames) {
  if (!matchup) return null;
  const aN = normalizeName(matchup.awayName);
  const hN = normalizeName(matchup.homeName);
  // Resolve DK team name aliases to standard MLB abbreviations
  const aResolved = (DK_MLB_ALIASES[aN] || aN).toLowerCase();
  const hResolved = (DK_MLB_ALIASES[hN] || hN).toLowerCase();
  return finalGames.find(g => {
    const ga = normalizeName(g.awayName);
    const gh = normalizeName(g.homeName);
    if (ga === aN && gh === hN) return true;
    // nickname suffix match
    const aNick = aN.split(' ').slice(1).join(' ');
    const hNick = hN.split(' ').slice(1).join(' ');
    if (aNick && hNick && ga.endsWith(aNick) && gh.endsWith(hNick)) return true;
    // abbreviation match — also resolves DK aliases (e.g. "A's" → ATH)
    const gAway = g.awayAbbr.toLowerCase();
    const gHome = g.homeAbbr.toLowerCase();
    if (gAway === aResolved && gHome === hResolved) return true;
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

// Hard Promise.race timeout — AbortSignal.timeout doesn't reliably cancel
// response-body reading in all CF runtime versions, so we add an explicit fence.
function withTimeout(promise, ms, fallback = null) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('to')), ms)),
  ]).catch(() => fallback);
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
      merged.homeRuns     = hr;
      merged.rbi          = parseInt(batting.rbi           || 0); // explicit — MLB API omits field when 0, spread leaves it undefined
      merged.runs         = parseInt(batting.runs          || 0);
      merged.strikeOuts   = parseInt(pitching.strikeOuts   || 0);
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
      // Pitcher outs recorded: inningsPitched "5.2" = 5 full innings + 2 outs = 17
      const ipParts = String(pitching.inningsPitched || '').split('.');
      merged.outs = (parseInt(ipParts[0]) || 0) * 3 + (parseInt(ipParts[1]) || 0);
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
          const stlIdx = names.indexOf('STL') >= 0 ? names.indexOf('STL') : names.indexOf('STEALS');
          const blkIdx = names.indexOf('BLK') >= 0 ? names.indexOf('BLK') : names.indexOf('BLOCKS');
          const minIdx = names.indexOf('MIN');
          for (const a of (sb.athletes || [])) {
            const name = normalizeName(a.athlete?.fullName || a.athlete?.displayName || '');
            if (!name) continue;
            const s = a.stats || [];
            if (s.length === 0) continue; // DNP — empty stats array
            // Also catch DNP when ESPN lists the player with 0:00 or "DNP" minutes
            const minVal = minIdx >= 0 ? String(s[minIdx] || '') : '';
            if (minVal === '0:00' || minVal === '0' || minVal.toUpperCase() === 'DNP') continue;
            const getStat = idx => {
              if (idx < 0) return 0;
              const v = s[idx];
              if (!v || v === '--') return 0;
              return parseInt(String(v).split('-')[0], 10) || 0;
            };
            const pts = getStat(ptsIdx), reb = getStat(rebIdx), ast = getStat(astIdx), fg3m = getStat(fg3Idx);
            const stl = getStat(stlIdx), blk = getStat(blkIdx);
            stats[name] = { pts, reb, ast, fg3m, stl, blk, pra: pts+reb+ast, pa: pts+ast, pr: pts+reb, ra: reb+ast };
          }
        }
      }
    }
    return stats;
  } catch(e) { return {}; }
}

// ── UFC helper ────────────────────────────────────────────────────────────────

async function getUfcResults(date, proxyKey = '') {
  const yyyymmdd = date.replace(/-/g, '');
  try {
    const proxyUrl = `${VPS_HOST}/espn-mma/scoreboard?dates=${yyyymmdd}&key=${encodeURIComponent(proxyKey)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return {};
    const data = await res.json();

    const byFullName = {};
    const byLastName = {};
    const lastNameCollisions = new Set();
    // Track completed comps for per-fight method lookup via ESPN core API
    const completedComps = []; // { eventId, compId, fighters: [normalizedName] }

    for (const event of (data.events || [])) {
      const eventId = String(event.id ?? '');
      for (const comp of (event.competitions || [])) {
        const compSt = comp.status?.type;
        if (!compSt?.completed && compSt?.name !== 'STATUS_FINAL') continue;
        const round  = comp.status?.period ?? null;
        const compId = String(comp.id ?? '');
        const fighters = [];
        for (const c of (comp.competitors || [])) {
          const raw = c.athlete?.displayName || c.athlete?.shortName || '';
          if (!raw) continue;
          const full = normalizeName(raw);
          const last = full.split(' ').pop();
          fighters.push(full);
          byFullName[full] = { won: !!c.winner, rounds: round, method: null };
          if (byLastName[last]) lastNameCollisions.add(last);
          else                  byLastName[last] = { won: !!c.winner, rounds: round, method: null };
        }
        if (eventId && compId && fighters.length) completedComps.push({ eventId, compId, fighters });
      }
    }

    // Fetch method for each completed comp from ESPN core API
    // result.name examples: "decision---unanimous", "tko---punches", "submission---rear-naked-choke"
    await Promise.all(completedComps.map(async ({ eventId, compId, fighters }) => {
      try {
        const statusUrl = `${VPS_HOST}/espn-mma/comp-status?event=${eventId}&comp=${compId}&key=${encodeURIComponent(proxyKey)}`;
        const sr = await fetch(statusUrl, { signal: AbortSignal.timeout(5000) });
        if (!sr.ok) return;
        const sd = await sr.json();
        const resultName = (sd.result?.name || '').toLowerCase();
        const method =
          (/\bko\b/.test(resultName) || /tko|stoppage|dq/.test(resultName)) ? 'ko' :
          /submission/.test(resultName) ? 'sub' :
          /decision/.test(resultName)   ? 'dec' : null;
        for (const name of fighters) {
          if (byFullName[name]) byFullName[name].method = method;
          const last = name.split(' ').pop();
          if (byLastName[last] && !lastNameCollisions.has(last)) byLastName[last].method = method;
        }
      } catch(_) {}
    }));

    // Merge: full names always included; last names only when unambiguous
    const results = { ...byFullName };
    for (const [ln, r] of Object.entries(byLastName)) {
      if (!lastNameCollisions.has(ln)) results[ln] = r;
    }
    return results;
  } catch(e) { return {}; }
}

// ── Soccer helpers ────────────────────────────────────────────────────────────

// Returns list of final games for a soccer league on a given date.
// { eventId, homeName, awayName, homeScore, awayScore }
async function getSoccerFinalGames(espnSlug, date, proxyKey) {
  const yyyymmdd = date.replace(/-/g, '');
  try {
    const res = await fetch(
      `${VPS_HOST}/espn-soccer/scoreboard?league=${espnSlug}&dates=${yyyymmdd}&key=${encodeURIComponent(proxyKey)}`,
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

// Returns { normalizedPlayerName → { totalGoals, shotsOnTarget, goalAssists, saves, offsides, foulsSuffered } }
// Fetches ESPN soccer summary for each final game and extracts roster stats.
async function getSoccerPlayerStats(espnSlug, espnEventIds, proxyKey) {
  const stats = {};
  await Promise.allSettled(espnEventIds.map(async eventId => {
    try {
      const res = await fetch(
        `${VPS_HOST}/espn-soccer/summary?league=${espnSlug}&event=${eventId}&key=${encodeURIComponent(proxyKey)}`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) return;
      const data = await res.json();
      for (const team of (data.rosters || [])) {
        for (const a of (team.roster || [])) {
          if (!a.active) continue;
          const name = normalizeName(a.athlete?.displayName || '');
          if (!name) continue;
          const raw = {};
          for (const s of (a.stats || [])) raw[s.name] = s.value ?? 0;
          if (!(raw.appearances > 0) && !(raw.minutesPlayed > 0)) continue; // didn't play
          stats[name] = {
            totalGoals:    raw.totalGoals    ?? 0,
            shotsOnTarget: raw.shotsOnTarget ?? 0,
            goalAssists:   raw.goalAssists   ?? 0,
            saves:         raw.saves         ?? 0,
            offsides:      raw.offsides      ?? 0,
            foulsSuffered: raw.foulsSuffered ?? 0,
          };
        }
      }
    } catch(_) {}
  }));
  return stats;
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

    // Raw ESPN MMA probe — bypass the completed filter to see what's actually there
    let ufcRawDebug = null;
    try {
      const ufcRaw = await fetch(`${VPS_HOST}/espn-mma/scoreboard?dates=${yyyymmdd}&key=${encodeURIComponent(proxyKey)}`, { signal: AbortSignal.timeout(8000) });
      ufcRawDebug = { status: ufcRaw.status };
      if (ufcRaw.ok) {
        const ud = await ufcRaw.json();
        ufcRawDebug.eventCount = (ud.events || []).length;
        ufcRawDebug.events = (ud.events || []).map(ev => ({
          id:   ev.id,
          name: ev.name,
          competitions: (ev.competitions || []).map(comp => ({
            id:          comp.id,
            statusName:  comp.status?.type?.name,
            statusDesc:  comp.status?.type?.description,
            statusDetail:      comp.status?.type?.detail,
            statusShortDetail: comp.status?.type?.shortDetail,
            completed:   comp.status?.type?.completed,
            period:      comp.status?.period,
            note:        comp.note,
            notes:       comp.notes,
            header:      comp.header,
            competitors: (comp.competitors || []).map(c => ({ name: c.athlete?.displayName, winner: c.winner })),
          })),
        }));
        // Probe comp-status for the first completed comp to verify method data
        const firstEv = (ud.events || [])[0];
        const firstComp = (firstEv?.competitions || []).find(c => c.status?.type?.completed || c.status?.type?.name === 'STATUS_FINAL');
        if (firstEv?.id && firstComp?.id) {
          try {
            const csRes = await fetch(
              `${VPS_HOST}/espn-mma/comp-status?event=${firstEv.id}&comp=${firstComp.id}&key=${encodeURIComponent(proxyKey)}`,
              { signal: AbortSignal.timeout(6000) }
            );
            if (csRes.ok) {
              const csd = await csRes.json();
              ufcRawDebug.compStatusProbe = {
                eventId: firstEv.id, compId: firstComp.id,
                fighters: (firstComp.competitors || []).map(c => c.athlete?.displayName),
                result: csd.result,
                period: csd.period,
              };
            } else {
              ufcRawDebug.compStatusProbe = { status: csRes.status };
            }
          } catch(e) { ufcRawDebug.compStatusProbe = { error: e.message }; }
        }
      }
    } catch(e) { ufcRawDebug = { error: e.message }; }

    const [mlbGames, wnbaGames, nflGames, ufcResults, wnbaStats] = await Promise.all([
      getMlbFinalGames(debugDate),
      getWnbaFinalGames(debugDate, proxyKey),
      getEspnFinalGames(ESPN_NFL, debugDate, env.DB, proxyKey),
      getUfcResults(debugDate, proxyKey),
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
      ufcRaw:      ufcRawDebug,
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
    "SELECT id, user_id, payout_rax, stake_rax, received_rax, is_free_play, rs_username, legs_count, one_leg_dm_sent, share_token FROM parlays WHERE status='active'"
  ).all();
  if (!parlays.length) return cacheAndReturn({ settled: 0, reason: 'no_active_parlays' });

  // 2. Load pending legs — active parlays for settlement, plus already-settled parlays so
  // per-leg outcomes get filled in even after the parlay is decided.
  const { results: allLegs } = await env.DB.prepare(
    "SELECT pl.id, pl.parlay_id, pl.player_name, pl.market_id, pl.threshold, " +
    "pl.direction, pl.game_date, pl.game_start_ms, pl.market_type, pl.status, pl.sport, " +
    "pl.label, pl.event_name, pl.implied_prob, p.status AS parlay_status " +
    "FROM parlay_legs pl " +
    "JOIN parlays p ON p.id = pl.parlay_id " +
    "WHERE pl.status = 'pending' AND p.status IN ('active','won','lost','voided','void','expired','cancelled')"
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
    'valkyries','fire','tempo', // 2026 expansion teams: GS Valkyries, Portland Fire, Toronto Tempo
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
    if (s.startsWith('soccer_'))                                 return 'soccer';
    // Rescue: legs placed before the place.js soccer fix were stored as sport='mlb'.
    if (SOCCER_PROP_TYPES.has(mkt))                              return 'soccer';
    if (mkt.startsWith('1inn_'))                                 return 'mlb';
    if ((mkt in MLB_STAT_FIELD) && !WNBA_PROP_TYPES.has(mkt))   return 'mlb';
    if (mkt === 'team_ml' || mkt === 'team_runline' || mkt === 'team_total') {
      // Stored sport field is authoritative — use it first to avoid cross-sport nickname collisions
      // (e.g. "Cardinals" exists in both MLB and NFL; "Giants" in both MLB and NFL)
      if (s === 'nfl'  || s === 'american_football_nfl')  return 'nfl';
      if (s === 'wnba' || s === 'basketball_wnba')         return 'wnba';
      if (s === 'mlb'  || s === 'baseball_mlb')            return 'mlb';
      // Fall back to nickname detection only for old legs with missing/wrong sport field
      if (isNflTeamLeg(leg))  return 'nfl';
      if (isWnbaTeamLeg(leg)) return 'wnba';
      return 'mlb';
    }
    if (s === 'wnba' || s === 'basketball_wnba')                 return 'wnba';
    if (s === 'nfl'  || s === 'american_football_nfl')           return 'nfl';
    if (s === 'ufc')                                             return 'ufc';
    if (mkt === 'ufc_ml' || mkt === 'ufc_total')                 return 'ufc';
    if (mkt && mkt.startsWith('ufc_method_'))                    return 'ufc';
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
  // soccer: date → espnSlug → { games: [...], stats: { playerName → statObj } }
  const soccerMap       = {};

  const hasMlbOnDate    = date => eligibleLegs.some(l => l.game_date === date && legSportOf(l) === 'mlb');
  const hasWnbaOnDate   = date => eligibleLegs.some(l => l.game_date === date && legSportOf(l) === 'wnba');
  const hasNflOnDate    = date => eligibleLegs.some(l => l.game_date === date && legSportOf(l) === 'nfl');
  const hasUfcOnDate    = date => eligibleLegs.some(l => l.game_date === date && legSportOf(l) === 'ufc');
  const has1innOnDate   = date => eligibleLegs.some(l => l.game_date === date && l.market_type.startsWith('1inn_'));
  const has1innPbpOnDate= date => eligibleLegs.some(l => l.game_date === date && INN1_PBP_MKTS.has(l.market_type));
  // Cardinals (MLB) and Giants (MLB) match NFL_NICKNAMES — place.js may have stored them as sport='nfl'.
  // Fetch MLB games as fallback whenever there are NFL-classified team market legs on a date.
  const hasNflTeamMktFallback = date => eligibleLegs.some(l =>
    l.game_date === date &&
    (l.market_type === 'team_ml' || l.market_type === 'team_runline' || l.market_type === 'team_total') &&
    (l.sport === 'nfl' || l.sport === 'american_football_nfl')
  );

  // Get the unique set of ESPN soccer slugs needed per date
  function soccerSlugsForDate(date) {
    const slugs = new Set();
    for (const l of eligibleLegs) {
      if (l.game_date === date && legSportOf(l) === 'soccer') {
        const slug = (l.sport || '').replace('soccer_', '');
        if (slug) slugs.add(slug);
      }
    }
    return [...slugs];
  }

  const proxyKey = env.VPS_DK_KEY || 'rax-dk-9x3m7p2q';

  await Promise.all(uniqueDates.map(async date => {
    soccerMap[date] = {};
    const soccerSlugs = soccerSlugsForDate(date);

    const [mlbGames, wnbaGames, nflGames, ufcResults] = await Promise.all([
      (hasMlbOnDate(date) || hasNflTeamMktFallback(date))
                            ? withTimeout(getMlbFinalGames(date), 9000, [])             : Promise.resolve([]),
      hasWnbaOnDate(date) ? withTimeout(getWnbaFinalGames(date, proxyKey), 9000, [])  : Promise.resolve([]),
      hasNflOnDate(date)  ? withTimeout(getEspnFinalGames(ESPN_NFL, date, env.DB, proxyKey), 9000, [])  : Promise.resolve([]),
      hasUfcOnDate(date)  ? withTimeout(getUfcResults(date, proxyKey), 9000, {})      : Promise.resolve({}),
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
              withTimeout(getMlbBoxscore(g.gamePk), 8000),
              fetch1inn    ? withTimeout(getMlbLinescore(g.gamePk), 8000)   : Promise.resolve(null),
              fetch1innPbp ? withTimeout(getMlbPlayByPlay(g.gamePk), 8000) : Promise.resolve(null),
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
      hasWnbaOnDate(date) ? withTimeout(getWnbaPlayerStats(date, proxyKey), 12000, {}) : Promise.resolve({}),
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

    // ── Soccer block ─────────────────────────────────────────────────────────
    if (soccerSlugs.length) {
      await Promise.allSettled(soccerSlugs.map(async espnSlug => {
        const games = await withTimeout(getSoccerFinalGames(espnSlug, date, proxyKey), 10000, []);
        const stats = games.length
          ? await withTimeout(getSoccerPlayerStats(espnSlug, games.map(g => g.eventId), proxyKey), 12000, {})
          : {};
        soccerMap[date][espnSlug] = { games, stats };
      }));
    }
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
      let outcome = games.length ? resolveTeamLeg(leg, games) : null;
      // If stored as NFL but game not found, try MLB as fallback.
      // Cardinals (MLB) and Giants (MLB) match NFL_NICKNAMES — legs may have been misclassified.
      if (outcome === null && sport === 'nfl') {
        const mlbFallback = mlbGamesMap[leg.game_date] || [];
        if (mlbFallback.length) outcome = resolveTeamLeg(leg, mlbFallback);
      }
      legOutcomes[leg.id] = (outcome === null && leg.game_date < staleDate) ? 'void' : outcome;
      continue;
    }

    if (sport === 'soccer') {
      const espnSlug = (leg.sport || '').replace('soccer_', '');
      const slugData = (soccerMap[leg.game_date] || {})[espnSlug] || {};
      const statsMap = slugData.stats || {};
      const playerKey = normForLookup(leg.player_name);
      let playerStats = statsMap[playerKey];
      // Fallback 1: prefix match — "nicolas fernandez mercau" stored, ESPN has "nicolas fernandez"
      if (!playerStats) {
        for (const [en, es] of Object.entries(statsMap)) {
          if (playerKey.startsWith(en) || en.startsWith(playerKey)) { playerStats = es; break; }
        }
      }
      // Fallback 2: last-name match — DK "axel ojeda" vs ESPN "agustin ojeda" (different first name)
      if (!playerStats) {
        const lastName = playerKey.split(' ').pop();
        if (lastName && lastName.length > 3) {
          for (const [en, es] of Object.entries(statsMap)) {
            if (en.endsWith(lastName)) { playerStats = es; break; }
          }
        }
      }
      if (!playerStats) {
        // Only treat "a game is final" as evidence this player DNP'd when the event_name
        // identifies a specific matchup. Player-prop format ("Albert Gudmundsson · sot")
        // has no team info — another league game being final doesn't mean THIS player's game
        // is done (e.g. LAZ vs BOL final while Roma vs FIO is still live).
        const hasMatchup = /\s+(vs|@)\s+/i.test(leg.event_name || '');
        const gameFinal = hasMatchup && (slugData.games || []).length > 0;
        legOutcomes[leg.id] = (gameFinal || leg.game_date < staleDate) ? 'void' : null;
        continue;
      }
      if (mkt === 'goalscorer') {
        legOutcomes[leg.id] = (playerStats.totalGoals ?? 0) >= 1 ? 'won' : 'lost';
      } else {
        const espnField = SOCCER_STAT_FIELD[mkt];
        if (!espnField) { legOutcomes[leg.id] = null; continue; }
        const statVal = playerStats[espnField] ?? null;
        if (statVal == null) { legOutcomes[leg.id] = null; continue; }
        // Soccer props are milestone (1+, 2+, 3+) — use >= / <= not > / <
        legOutcomes[leg.id] = (leg.direction === 'more' ? statVal >= leg.threshold : statVal <= leg.threshold) ? 'won' : 'lost';
      }
      continue;
    }

    if (sport === 'ufc') {
      const ufcResults = ufcMap[leg.game_date] || {};
      if (mkt === 'ufc_ml') {
        const fullNorm = normalizeName(leg.player_name);
        const lastName = fullNorm.split(' ').pop();
        // Full name first (handles two Johnsons etc.), last name as fallback
        const result = ufcResults[fullNorm] || ufcResults[lastName];
        if (!result) { legOutcomes[leg.id] = leg.game_date < staleDate ? 'void' : null; continue; }
        legOutcomes[leg.id] = result.won ? 'won' : 'lost';
      } else if (mkt.startsWith('ufc_method_')) {
        const method   = mkt.replace('ufc_method_', ''); // 'ko' | 'sub' | 'dec'
        const rawName  = leg.player_name.replace(/ by .+$/i, '').trim(); // strip " by KO/TKO" etc.
        const fullNorm = normalizeName(rawName);
        const lastName = fullNorm.split(' ').pop();
        const result   = ufcResults[fullNorm] || ufcResults[lastName];
        if (!result || !result.method) { legOutcomes[leg.id] = leg.game_date < staleDate ? 'void' : null; continue; }
        legOutcomes[leg.id] = (result.won && result.method === method) ? 'won' : 'lost';
      } else {
        const m = leg.player_name.match(/([OU])([\d.]+)$/i);
        if (!m) { legOutcomes[leg.id] = null; continue; }
        const nameChunk  = normalizeName(leg.player_name.replace(/\s*[OU][\d.]+$/i, ''));
        const fullNames  = nameChunk.split(/\s+vs\s+/i).map(s => s.trim());
        const lastNames  = fullNames.map(s => s.split(' ').pop());
        let result = null;
        // Full name lookup first, then last name fallback
        for (const fn of fullNames)  { if (ufcResults[fn]) { result = ufcResults[fn]; break; } }
        if (!result) {
          for (const ln of lastNames) { if (ufcResults[ln]) { result = ufcResults[ln]; break; } }
        }
        if (!result || result.rounds == null) { legOutcomes[leg.id] = leg.game_date < staleDate ? 'void' : null; continue; }
        const isOver = m[1].toUpperCase() === 'O';
        const line   = parseFloat(m[2]);
        legOutcomes[leg.id] = (isOver ? result.rounds > line : result.rounds < line) ? 'won' : 'lost';
      }
      continue;
    }

    if (sport === 'wnba') {
      const wnbaMap = wnbaStatsMap[leg.game_date] || {};
      const wnbaKey = normForLookup(leg.player_name);
      // Fallback: ESPN displayName sometimes drops a surname component (e.g. "Awa Fam" vs "Awa Fam Thiam").
      // Try progressively shorter prefixes (min 2 words) before giving up.
      let wnbaStats = wnbaMap[wnbaKey];
      if (!wnbaStats) {
        const parts = wnbaKey.split(' ');
        for (let i = parts.length - 1; i >= 2 && !wnbaStats; i--) {
          wnbaStats = wnbaMap[parts.slice(0, i).join(' ')];
        }
      }
      if (!wnbaStats) {
        // If this player's specific game was final (by event_id), they DNP'd — void immediately.
        // Otherwise fall back to stale-date check.
        const gamesForDate = wnbaGamesMap[leg.game_date] || [];
        const gameFinal = gamesForDate.some(g => String(g.eventId) === String(leg.event_id));
        legOutcomes[leg.id] = (gameFinal || leg.game_date < staleDate) ? 'void' : null;
        continue;
      }
      if (mkt === 'double_double' || mkt === 'triple_double') {
        const needed = mkt === 'double_double' ? 2 : 3;
        const count = DD_TD_CATS.filter(cat => (wnbaStats[cat] ?? 0) >= 10).length;
        legOutcomes[leg.id] = count >= needed ? 'won' : 'lost';
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
      // Player absent from boxscore — scratched/DNP. Determine if game is final.
      // Try matchup parse first (works for team-format event_name); fall back to
      // "any final game exists on this date" for player-prop event_name format.
      const matchup = parse1innMatchup(leg.event_name);
      const gameFinal = matchup
        ? !!match1innGame(matchup, mlbGamesMap[leg.game_date] || [])
        // For player props (no matchup), only declare game final once 4 hours have elapsed
        // since that specific game's start time. This prevents voiding west-coast players
        // while their game is still live — even after midnight UTC when other games on the
        // same calendar date have already finished.
        : (leg.game_start_ms
            ? Date.now() > leg.game_start_ms + 4 * 60 * 60 * 1000
            : leg.game_date < staleDate);
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
    // Legs scheduled for future dates — cannot settle today, always block finalization unless another leg already lost
    const futurePendingLegs = allLegs.filter(l => l.parlay_id === parlay.id && l.status === 'pending' && l.game_date > todayUtc);
    if (!pendingLegs.length && !futurePendingLegs.length) continue;
    if (!pendingLegs.length) continue; // only future legs remain — nothing to settle today

    const outcomes = pendingLegs.map(l => ({
      legId: l.id, outcome: legOutcomes[l.id] ?? null,
      player: l.player_name, market_type: l.market_type,
      threshold: l.threshold, direction: l.direction,
    }));

    const stillWaiting = outcomes.filter(o => o.outcome === null);
    const resolvedLegs = outcomes.filter(o => o.outcome !== null);
    const anyLostEarly = resolvedLegs.some(o => o.outcome === 'lost');

    // Load all already-settled legs for this parlay (lost/void/won from prior passes).
    // This is critical for multi-pass settlement: a void in pass N and a win in pass M
    // would otherwise make anyVoid=false in pass M, paying the original N-leg payout unchanged.
    let priorLost = false;
    let priorVoidLegs = [];
    let priorWonLegs  = [];
    try {
      const priorSettled = await env.DB.prepare(
        "SELECT id, implied_prob, status FROM parlay_legs WHERE parlay_id=? AND status IN ('lost','void','won')"
      ).bind(parlay.id).all();
      priorLost     = priorSettled.results.some(l => l.status === 'lost');
      priorVoidLegs = priorSettled.results.filter(l => l.status === 'void');
      priorWonLegs  = priorSettled.results.filter(l => l.status === 'won');
    } catch(e) {}

    // Future legs count the same as unresolved today-legs — parlay can't finish while they exist
    if ((stillWaiting.length || futurePendingLegs.length) && !(anyLostEarly || priorLost)) {
      // One-leg-left DM: fire once when exactly 1 leg remains on a 3+ leg parlay
      const legsLeft = stillWaiting.length + futurePendingLegs.length;
      if (legsLeft === 1 && !parlay.one_leg_dm_sent && (parlay.legs_count || 0) >= 3) {
        try {
          const authInfo     = env.EDGEBOT_AUTH_INFO;
          const sessionToken = env.EDGEBOT_SESSION_TOKEN;
          if (authInfo && sessionToken) {
            const ra = await env.DB.prepare(
              'SELECT dm_channel_id FROM real_auth WHERE user_id=?'
            ).bind(parlay.user_id).first();
            if (ra?.dm_channel_id) {
              // Fetch all legs with full details for the breakdown
              const { results: legDetails } = await env.DB.prepare(
                'SELECT id, player_name, label, direction, threshold, american_odds, status FROM parlay_legs WHERE parlay_id=? ORDER BY id'
              ).bind(parlay.id).all();

              // This-pass outcomes not yet written to DB — overlay them
              const thisPassMap = {};
              for (const o of resolvedLegs) thisPassMap[o.legId] = o.outcome;

              const fmtRax  = n => n ? String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '?';
              const fmtOdds = o => o != null ? (o > 0 ? '+' : '') + o : '';

              const legLines = legDetails.map(leg => {
                const status = thisPassMap[leg.id] || leg.status;
                const icon   = status === 'won' ? '✅' : status === 'pending' ? '⏳' : status === 'void' ? '↩️' : '❌';
                const odds   = leg.american_odds != null ? ` (${fmtOdds(leg.american_odds)})` : '';
                return `${icon} ${leg.player_name} – ${leg.label || leg.direction}${odds}`;
              }).join('\n');

              const multi   = parlay.stake_rax ? (parlay.payout_rax / parlay.stake_rax).toFixed(1) + 'x' : '';
              const payout  = fmtRax(parlay.payout_rax);
              const footer  = `Stake: ${fmtRax(parlay.stake_rax)} Rax · ${multi} · Win: ${payout} Rax`;

              const msgFn   = ONE_LEG_MESSAGES[Math.floor(Math.random() * ONE_LEG_MESSAGES.length)];
              const slipUrl = parlay.share_token ? `\nhttps://raxedge.com/slip?t=${parlay.share_token}` : '';
              const text    = `${msgFn(parlay.legs_count, payout)}\n\n${legLines}\n\n${footer}${slipUrl}`;

              await fetch(`${RS_BASE}/messages/channels/${ra.dm_channel_id}/messages`, {
                method:  'POST',
                headers: buildRsHeaders(authInfo, sessionToken, true),
                body:    JSON.stringify({ text, parentMessageId: null }),
                signal:  AbortSignal.timeout(10000),
              });
            }
            await env.DB.prepare('UPDATE parlays SET one_leg_dm_sent=1 WHERE id=?').bind(parlay.id).run();
          }
        } catch(_) {}
      }
      // Flush already-resolved individual leg statuses even though the parlay isn't finished yet.
      // Without this, a leg whose game ended is left pending while a co-leg's game is still live.
      for (const o of resolvedLegs) {
        if (o.outcome === null) continue;
        try {
          await env.DB.prepare("UPDATE parlay_legs SET status=?, settled_at=? WHERE id=?")
            .bind(o.outcome, now, o.legId).run();
        } catch(_) {}
      }
      report.push({ parlayId: parlay.id, status: 'waiting', waiting: [...stillWaiting.map(o => o.player), ...futurePendingLegs.map(l => l.player_name)] });
      continue;
    }

    const voidedLegs   = resolvedLegs.filter(o => o.outcome === 'void');
    const activeLegs   = resolvedLegs.filter(o => o.outcome !== 'void');
    // anyVoid: a leg went void either this pass OR in a prior pass
    const anyVoid = voidedLegs.length > 0 || priorVoidLegs.length > 0;
    const anyLost = activeLegs.some(o => o.outcome === 'lost') || priorLost;

    // All non-void winning legs across every pass: this-pass active + prior-won
    const allWonLegProbs = [
      ...activeLegs.map(o => {
        const leg = allLegs.find(l => l.id === o.legId);
        return leg ? parseFloat(leg.implied_prob) : null;
      }).filter(p => p !== null),
      ...priorWonLegs.map(l => parseFloat(l.implied_prob)),
    ];
    const totalWonLegs = allWonLegProbs.length;

    // Determine result and final payout
    let parlayResult, finalPayout;

    if (!anyVoid) {
      // No scratches — normal settlement
      parlayResult = anyLost ? 'lost' : 'won';
      finalPayout  = parlay.is_free_play ? Math.min(parlay.payout_rax, 3000) : parlay.payout_rax;
    } else if (totalWonLegs < 2) {
      // 1 or 0 active legs remain after scratches — refund only if no active leg lost
      if (anyLost) {
        parlayResult = 'lost';
        finalPayout  = 0;
      } else {
        parlayResult = 'voided';
        finalPayout  = parlay.received_rax ?? parlay.stake_rax;
      }
    } else if (anyLost) {
      // Scratch on the slip but another leg also lost — just a loss
      parlayResult = 'lost';
      finalPayout  = 0;
    } else {
      // All remaining legs won — recalculate payout using only the non-void legs' implied probs.
      // Use stake_rax * 0.9 to match placement formula (RS takes 10% commission on deposit).
      const newTrueProb    = allWonLegProbs.reduce((acc, p) => acc * p, 1);
      const effectiveStake = Math.floor(parlay.stake_rax * 0.9);
      parlayResult = 'won';
      finalPayout  = Math.min(Math.floor(effectiveStake * 0.70 / newTrueProb), parlay.is_free_play ? 3000 : 10000);
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

  // 7. Settle active parlays where all legs are already resolved (no pending legs left).
  // This catches parlays that slipped through — e.g. legs were marked won/void individually
  // but the parlay status was never updated because auto-settle saw no pending legs.
  try {
    const { results: orphaned } = await env.DB.prepare(
      "SELECT p.id, p.user_id, p.rs_username, p.stake_rax, p.payout_rax, p.received_rax, p.is_free_play " +
      "FROM parlays p " +
      "WHERE p.status = 'active' " +
      "AND NOT EXISTS (SELECT 1 FROM parlay_legs pl WHERE pl.parlay_id = p.id AND pl.status = 'pending')"
    ).all();

    for (const p of orphaned) {
      const { results: legs } = await env.DB.prepare(
        "SELECT status FROM parlay_legs WHERE parlay_id=?"
      ).bind(p.id).all();
      if (!legs.length) continue;

      const anyLost   = legs.some(l => l.status === 'lost');
      const activeLegs = legs.filter(l => l.status !== 'void' && l.status !== 'voided');

      let result, finalPayout;
      if (anyLost) {
        result = 'lost'; finalPayout = 0;
      } else if (activeLegs.length < 2) {
        result = 'voided'; finalPayout = p.received_rax ?? p.stake_rax;
      } else {
        result = 'won';
        finalPayout = p.is_free_play ? Math.min(p.payout_rax, 3000) : p.payout_rax;
      }

      if (result === 'lost') {
        await env.DB.prepare("UPDATE parlays SET status='lost', settled_at=? WHERE id=?").bind(now, p.id).run();
      } else if (result === 'voided') {
        await env.DB.batch([
          env.DB.prepare("UPDATE parlays SET status='voided', settled_at=? WHERE id=?").bind(now, p.id),
          env.DB.prepare('INSERT OR IGNORE INTO payout_queue (parlay_id, user_id, rs_username, payout_rax, offer_amount, created_at) VALUES (?,?,?,?,?,?)').bind(p.id, p.user_id, p.rs_username, finalPayout, finalPayout, now),
        ]);
      } else {
        await env.DB.batch([
          env.DB.prepare("UPDATE parlays SET status='won', payout_rax=?, settled_at=? WHERE id=?").bind(finalPayout, now, p.id),
          env.DB.prepare('INSERT OR IGNORE INTO payout_queue (parlay_id, user_id, rs_username, payout_rax, offer_amount, created_at) VALUES (?,?,?,?,?,?)').bind(p.id, p.user_id, p.rs_username, finalPayout, finalPayout, now),
        ]);
      }
      totalSettled++;
      report.push({ parlayId: p.id, result, source: 'orphan_cleanup' });
    }
  } catch(e) {}

  // 9. Re-evaluate recently-lost parlays for DNP corrections.
  // If a WNBA parlay was settled as 'lost' because a player appeared in ESPN's box score
  // with empty stats (DNP), all legs now resolve to 'void' — refund the stake.
  const dnpRefunds = [];
  try {
    const recentLost = await env.DB.prepare(
      "SELECT id, user_id, stake_rax, received_rax, rs_username FROM parlays WHERE status='lost' AND settled_at > ?"
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
        ).bind(p.id, p.user_id, p.rs_username, p.received_rax ?? p.stake_rax, p.received_rax ?? p.stake_rax, now),
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
