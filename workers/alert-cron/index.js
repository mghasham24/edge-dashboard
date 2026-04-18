// workers/alert-cron/index.js
// Runs every 60 seconds via Cloudflare Cron Trigger.
// For each pro user with Telegram verified:
//   1. Load odds from native FD/DK caches (same source as the site)
//   2. Calculate EV vs RS fair probabilities
//   3. Alert if EV >= user threshold and bet not already sent
//   4. Re-alert if EV jumped +4% since last message (new unit tier)
//
// Native cache sources (matches the site exactly):
//   NBA → fd_nba_alts   (FD native, ML + spread + total)
//   MLB → fd_mlb        (FD native, ML only)  + fd_rfi (RFI)
//   NHL → fd_nhl        (FD native, ML only)
//   FC  → fd_fc         (DK native, AH spread)
//   NCAAB, UFC → Odds API (no native endpoint exists)

import Hashids from 'hashids';

const _hashids = new Hashids('routing', 11);
const RS_SPORT_KEY_ID = { nba:1, nfl:2, cbb:3, mlb:4, nhl:7, ufc:10, wnba:12, soccer:14 };

function buildRSUrl(gid, rsSportKey) {
  if (!gid) return null;
  const sportId = RS_SPORT_KEY_ID[rsSportKey] ?? 0;
  const hash = _hashids.encode([4, sportId, 0, gid]);
  return 'https://www.realapp.com/' + hash;
}

// ── EV Calculation ────────────────────────────────────

function imp(american) {
  if (!american || !isFinite(american)) return null;
  return american > 0
    ? 100 / (american + 100)
    : Math.abs(american) / (Math.abs(american) + 100);
}

// No-vig fair probability for side A given American odds for A and B
function noVigFair(amA, amB) {
  const iA = imp(amA), iB = imp(amB);
  if (!iA || !iB) return null;
  const total = iA + iB;
  return { fa: iA / total, fb: iB / total };
}

// Volume-tiered rake — mirrors dashboard's rakeEV logic exactly
function rakeFor(volume) {
  if (volume > 100000) return 0.034;
  if (volume > 10000)  return 0.032;
  if (volume > 1000)   return 0.035;
  if (volume > 0)      return 0.040;
  return 0.034;
}

// EV% — FD/DK no-vig is the "true" probability baseline; RS is the betting market.
// Rake-adjusted to match what users see on the dashboard.
function calcEV(fdNoVigProb, rsImpliedProb, volume) {
  if (!fdNoVigProb || !rsImpliedProb || rsImpliedProb <= 0) return null;
  const rake = rakeFor(volume ?? 0);
  return (fdNoVigProb / rsImpliedProb * (1 - rake) - 1) * 100;
}

// Unit sizing — mirrors the frontend unitsEV() function exactly
function unitsEV(ev, realPct) {
  if (ev == null || !isFinite(ev)) return 0;
  const maxU = (realPct != null && realPct < 0.075) ? 0.25
             : (realPct != null && realPct < 0.15)  ? 0.5
             : (realPct != null && realPct < 0.25)  ? 0.5
             : 3;
  if (ev >= 35) return Math.min(3, maxU);
  if (ev >= 20) return Math.min(2, maxU);
  if (ev >= 10) return Math.min(1, maxU);
  if (ev >= 5)  return Math.min(0.5, maxU);
  return 0;
}

// ── Sport config ───────────────────────────────────────

// Native sports: read from FD/DK D1 cache (same source as the site)
const NATIVE_SPORTS = [
  { fdKey: 'basketball_nba',        rsKey: 'nba',    label: 'NBA',   cacheKey: 'fd_nba_alts', type: 'nba'     },
  { fdKey: 'baseball_mlb',          rsKey: 'mlb',    label: 'MLB',   cacheKey: 'fd_mlb',      type: 'ml_only' },
  { fdKey: 'icehockey_nhl',         rsKey: 'nhl',    label: 'NHL',   cacheKey: 'fd_nhl',      type: 'ml_only' },
  { fdKey: 'soccer_fc',             rsKey: 'soccer', label: 'FC',    cacheKey: 'fd_fc',       type: 'fc'      },
];

// Odds API sports: no native endpoint exists yet
const ODDS_API_SPORTS = [
  { fdKey: 'basketball_ncaab',       rsKey: 'cbb',    label: 'NCAAB' },
  { fdKey: 'mma_mixed_martial_arts', rsKey: 'ufc',    label: 'UFC'   },
];

const ALL_SPORTS = [...NATIVE_SPORTS, ...ODDS_API_SPORTS];

// RS market labels by native sport type
const RS_ML_LABELS = ['Moneyline', 'Game Winner', 'Fight Outcome', 'Fight Winner', 'Match Winner', 'Winner'];

// ── Odds API fetch (NCAAB + UFC only) ─────────────────

async function fetchFDOdds(sport, apiKey) {
  const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${apiKey}&regions=us&markets=h2h&bookmakers=fanduel&oddsFormat=american`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const games = await res.json();
  if (!Array.isArray(games)) return null;
  return games;
}

// ── RS cache ───────────────────────────────────────────

function parseRSCache(cacheData) {
  const games = {};
  const gameIds = {};
  const gameSports = {};
  if (!cacheData || typeof cacheData !== 'object') return { games, gameIds, gameSports };
  for (const [key, val] of Object.entries(cacheData)) {
    if (key.endsWith('__gid'))   { gameIds[key.slice(0, -5)] = val; continue; }
    if (key.endsWith('__sport')) { gameSports[key.slice(0, -7)] = val; continue; }
    if (key.endsWith('__lines')) continue;
    if (val && typeof val === 'object' &&
        (val['Moneyline'] || val['Game Winner'] || val['Spread'] || val['Total'] ||
         val['Total Runs'] || val['Total Goals'] || val['Run in 1st inning?'] ||
         val['Fight Outcome'] || val['Fight Winner'] || val['Match Winner'] || val['Winner'])) {
      games[key] = val;
    }
  }
  return { games, gameIds, gameSports };
}

const FDKEY_TO_RSKEY = {
  'basketball_nba': 'nba', 'baseball_mlb': 'mlb', 'icehockey_nhl': 'nhl',
  'soccer_fc': 'soccer', 'basketball_ncaab': 'cbb', 'mma_mixed_martial_arts': 'ufc'
};

async function warmRSCache(fdKey, env, now, staleThreshold) {
  if (!env.SITE_URL || !env.CRON_SECRET) return;
  try {
    const rsKey = FDKEY_TO_RSKEY[fdKey] || fdKey;
    const cached = await env.DB.prepare(
      'SELECT fetched_at FROM odds_cache WHERE cache_key=?'
    ).bind('real_sync_' + rsKey + '_v8').first();
    if (cached && (now - cached.fetched_at) < staleThreshold) return;
    await fetch(`${env.SITE_URL}/api/real/sync?sport=${fdKey}&_cron_key=${env.CRON_SECRET}`, {
      signal: AbortSignal.timeout(15000)
    });
  } catch(e) {}
}

async function loadRSCache(rsKey, env, now, staleThreshold) {
  try {
    const cached = await env.DB.prepare(
      'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
    ).bind('real_sync_' + rsKey + '_v8').first();
    const age = cached ? now - cached.fetched_at : null;
    if (cached && age < staleThreshold) {
      return { ...parseRSCache(JSON.parse(cached.data)), rsAge: age };
    }
    if (cached) return { games: {}, gameIds: {}, gameSports: {}, rsAge: age, reason: 'rs_stale' };
  } catch(e) {}
  return { games: {}, gameIds: {}, gameSports: {}, rsAge: null, reason: 'rs_missing' };
}

// ── Game key normalization ─────────────────────────────

function normName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\bfc\b/g, '')
    .replace(/\bunited\b/g, '')
    .replace(/\bcity\b/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findRSGameKey(fdAway, fdHome, rsGames) {
  const directKey = fdAway + ' @ ' + fdHome;
  if (rsGames[directKey]) return directKey;
  const nAway = normName(fdAway);
  const nHome = normName(fdHome);
  for (const rsKey of Object.keys(rsGames)) {
    const parts = rsKey.split(' @ ');
    if (parts.length !== 2) continue;
    const nRA = normName(parts[0]);
    const nRH = normName(parts[1]);
    if (
      (nRA.includes(nAway) || nAway.includes(nRA)) &&
      (nRH.includes(nHome) || nHome.includes(nRH))
    ) return rsKey;
  }
  return null;
}

// Find matching RS outcome by team/side name (normalized)
function findRSOutcome(name, rsOutcomes) {
  const nName = normName(name);
  return rsOutcomes.find(o => {
    const nRs = normName(o.label);
    return nRs.includes(nName) || nName.includes(nRs);
  });
}

// Float-key lookup with tolerance (handles JS object key stringification)
function lookupByLine(dict, line) {
  if (!dict) return null;
  const str = String(line);
  if (dict[str] != null) return dict[str];
  // Try matching any key within 0.01 of the target (float precision safety)
  for (const k of Object.keys(dict)) {
    if (Math.abs(parseFloat(k) - line) < 0.01) return dict[k];
  }
  return null;
}

// ── Telegram send ──────────────────────────────────────

async function sendTelegram(chatId, text, botToken, replyMarkup) {
  try {
    const body = { chat_id: chatId, text, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    return data.ok ? data.result.message_id : null;
  } catch(e) { return null; }
}

function formatAlert(sport, game, market, side, ev, units, dollarAmt, pt, rsPct, adjFairPct, gameUrl) {
  const evStr    = (ev >= 0 ? '+' : '') + ev.toFixed(1) + '% EV';
  const unitStr  = units + 'u (' + dollarAmt + ' Rax)';
  const ptStr    = pt != null ? ' ' + (pt > 0 ? '+' : '') + pt : '';
  const lineStr  = market === 'ML' || market === 'RFI' ? side : side + ptStr;
  const rsPctStr = rsPct != null ? rsPct.toFixed(1) + '% RS' : '';
  const adjStr   = adjFairPct != null ? adjFairPct.toFixed(1) + '% Fair' : '';
  const statsStr = [rsPctStr, adjStr].filter(Boolean).join(' · ');
  const teams    = game.split(' @ ');
  const shortGame = (teams[0] || game) + ' @ ' + (teams[1] || '');
  const linkLine = gameUrl ? `\n<a href="${gameUrl}">View on Real Sports ↗</a>` : '';
  return (
    `🔔 <b>RaxEdge Alert</b>\n\n` +
    `<b>${lineStr}</b> · ${market} · ${sport.label}\n` +
    `${evStr} · ${unitStr}\n` +
    (statsStr ? statsStr + '\n' : '') +
    `\n<i>${shortGame}</i>${linkLine}`
  );
}

// ── Native cache processors ────────────────────────────

// ML-only sports: MLB (fd_mlb) and NHL (fd_nhl)
// Cache: { ok, games: { "Away @ Home": { id, away, home, cm, ml: { TeamName: price } } } }
function processNativeML(sport, fdGames, rsGames, rsGameIds, rsGameSports, globalMinEv, allBets, now) {
  for (const [gameKey, game] of Object.entries(fdGames)) {
    const commenceTime = game.cm ? Math.floor(new Date(game.cm).getTime() / 1000) : 0;
    if (commenceTime && commenceTime <= now) continue;

    const rsKey = findRSGameKey(game.away, game.home, rsGames);
    if (!rsKey) continue;

    const rsMarkets = rsGames[rsKey];
    const gameId    = rsGameIds[rsKey] || null;
    const rsSport   = rsGameSports[rsKey] || sport.rsKey;
    const gameUrl   = buildRSUrl(gameId, rsSport);

    // Find RS ML market (Moneyline or Game Winner)
    const rsMktLabel = RS_ML_LABELS.find(l => rsMarkets[l]);
    if (!rsMktLabel) continue;

    const rsMkt      = rsMarkets[rsMktLabel];
    const rsOutcomes = rsMkt.outcomes || [];
    const rsVolume   = rsMkt.volume ?? 0;

    const mlPrices = game.ml || {};
    const awayPrice = mlPrices[game.away];
    const homePrice = mlPrices[game.home];
    if (awayPrice == null || homePrice == null) continue;

    const noVig = noVigFair(awayPrice, homePrice);
    if (!noVig) continue;

    const sides = [
      { name: game.away, fdOdds: awayPrice, fdFair: noVig.fa },
      { name: game.home, fdOdds: homePrice, fdFair: noVig.fb },
    ];

    for (const { name, fdOdds, fdFair } of sides) {
      const rsO = findRSOutcome(name, rsOutcomes);
      if (!rsO || !rsO.probability) continue;

      const ev = calcEV(fdFair, rsO.probability, rsVolume);
      if (ev == null || ev < globalMinEv) continue;

      const u = unitsEV(ev, fdFair);
      if (u <= 0) continue;

      allBets.push({
        sport, game: gameKey, market: 'ML', side: name,
        ev: Math.round(ev * 10) / 10, units: u, fdOdds, pt: null,
        rsPct: Math.round(rsO.probability * 1000) / 10,
        adjFairPct: Math.round(fdFair * 1000) / 10,
        gameUrl, commenceTime,
        betKey: `${sport.fdKey}|${gameKey}|ML|${name}|`,
      });
    }
  }
}

// NBA: fd_nba_alts — ML + spread + total
// Cache: { ok, games: { "Away @ Home": {
//   id, away, home, cm,
//   ml: { TeamName: price },
//   spreads: { TeamName: { handicap: price } },
//   totals: { Over: { line: price }, Under: { line: price } }
// } } }
function processNativeNBA(sport, fdGames, rsGames, rsGameIds, rsGameSports, globalMinEv, allBets, now) {
  for (const [gameKey, game] of Object.entries(fdGames)) {
    const commenceTime = game.cm ? Math.floor(new Date(game.cm).getTime() / 1000) : 0;
    if (commenceTime && commenceTime <= now) continue;

    const rsKey = findRSGameKey(game.away, game.home, rsGames);
    if (!rsKey) continue;

    const rsMarkets = rsGames[rsKey];
    const gameId    = rsGameIds[rsKey] || null;
    const rsSport   = rsGameSports[rsKey] || sport.rsKey;
    const gameUrl   = buildRSUrl(gameId, rsSport);

    // ── ML ──
    const rsMlLabel = RS_ML_LABELS.find(l => rsMarkets[l]);
    if (rsMlLabel) {
      const rsMkt      = rsMarkets[rsMlLabel];
      const rsOutcomes = rsMkt.outcomes || [];
      const rsVolume   = rsMkt.volume ?? 0;
      const mlPrices   = game.ml || {};
      const awayPrice  = mlPrices[game.away];
      const homePrice  = mlPrices[game.home];
      if (awayPrice != null && homePrice != null) {
        const noVig = noVigFair(awayPrice, homePrice);
        if (noVig) {
          for (const { name, fdOdds, fdFair } of [
            { name: game.away, fdOdds: awayPrice, fdFair: noVig.fa },
            { name: game.home, fdOdds: homePrice, fdFair: noVig.fb },
          ]) {
            const rsO = findRSOutcome(name, rsOutcomes);
            if (!rsO || !rsO.probability) continue;
            const ev = calcEV(fdFair, rsO.probability, rsVolume);
            if (ev == null || ev < globalMinEv) continue;
            const u = unitsEV(ev, fdFair);
            if (u <= 0) continue;
            allBets.push({
              sport, game: gameKey, market: 'ML', side: name,
              ev: Math.round(ev * 10) / 10, units: u, fdOdds, pt: null,
              rsPct: Math.round(rsO.probability * 1000) / 10,
              adjFairPct: Math.round(fdFair * 1000) / 10,
              gameUrl, commenceTime,
              betKey: `${sport.fdKey}|${gameKey}|ML|${name}|`,
            });
          }
        }
      }
    }

    // ── Spread ──
    const rsSpreadMkt = rsMarkets['Spread'];
    if (rsSpreadMkt && game.spreads) {
      const rsOutcomes = rsSpreadMkt.outcomes || [];
      const rsVolume   = rsSpreadMkt.volume ?? 0;
      for (const rsO of rsOutcomes) {
        if (!rsO.probability || rsO.line == null) continue;
        // Find which FD team name this RS outcome belongs to
        const nRsLabel = normName(rsO.label);
        const fdTeam = Object.keys(game.spreads).find(t => {
          const nFd = normName(t);
          return nFd.includes(nRsLabel) || nRsLabel.includes(nFd);
        });
        if (!fdTeam) continue;
        const otherTeam = Object.keys(game.spreads).find(t => t !== fdTeam);
        if (!otherTeam) continue;
        const fdPrice      = lookupByLine(game.spreads[fdTeam], rsO.line);
        const fdOtherPrice = lookupByLine(game.spreads[otherTeam], -rsO.line);
        if (fdPrice == null || fdOtherPrice == null) continue;
        const noVig = noVigFair(fdPrice, fdOtherPrice);
        if (!noVig) continue;
        const fdFair = noVig.fa;
        const ev = calcEV(fdFair, rsO.probability, rsVolume);
        if (ev == null || ev < globalMinEv) continue;
        const u = unitsEV(ev, fdFair);
        if (u <= 0) continue;
        const pt = rsO.line;
        allBets.push({
          sport, game: gameKey, market: 'Spread', side: fdTeam,
          ev: Math.round(ev * 10) / 10, units: u, fdOdds: fdPrice, pt,
          rsPct: Math.round(rsO.probability * 1000) / 10,
          adjFairPct: Math.round(fdFair * 1000) / 10,
          gameUrl, commenceTime,
          betKey: `${sport.fdKey}|${gameKey}|Spread|${fdTeam}|${pt ?? ''}`,
        });
      }
    }

    // ── Total ──
    const rsTotalMkt = rsMarkets['Total'];
    if (rsTotalMkt && game.totals) {
      const rsOutcomes = rsTotalMkt.outcomes || [];
      const rsVolume   = rsTotalMkt.volume ?? 0;
      for (const rsO of rsOutcomes) {
        if (!rsO.probability || rsO.line == null) continue;
        const side      = /over/i.test(rsO.label) ? 'Over' : 'Under';
        const otherSide = side === 'Over' ? 'Under' : 'Over';
        const fdPrice      = lookupByLine(game.totals[side], rsO.line);
        const fdOtherPrice = lookupByLine(game.totals[otherSide], rsO.line);
        if (fdPrice == null || fdOtherPrice == null) continue;
        const noVig = noVigFair(fdPrice, fdOtherPrice);
        if (!noVig) continue;
        const fdFair = noVig.fa;
        const ev = calcEV(fdFair, rsO.probability, rsVolume);
        if (ev == null || ev < globalMinEv) continue;
        const u = unitsEV(ev, fdFair);
        if (u <= 0) continue;
        const pt = rsO.line;
        allBets.push({
          sport, game: gameKey, market: 'Total', side,
          ev: Math.round(ev * 10) / 10, units: u, fdOdds: fdPrice, pt,
          rsPct: Math.round(rsO.probability * 1000) / 10,
          adjFairPct: Math.round(fdFair * 1000) / 10,
          gameUrl, commenceTime,
          betKey: `${sport.fdKey}|${gameKey}|Total|${side}|${pt ?? ''}`,
        });
      }
    }
  }
}

// FC: fd_fc — DK Asian Handicap spread
// Cache: { ok, games: { "Away @ Home": {
//   id, away, home, cm, league,
//   spreads: { Home: { "-0.5": price, ... }, Away: { "0.5": price, ... } }
// } } }
function processNativeFC(sport, fdGames, rsGames, rsGameIds, rsGameSports, globalMinEv, allBets, now) {
  for (const [gameKey, game] of Object.entries(fdGames)) {
    const commenceTime = game.cm ? Math.floor(new Date(game.cm).getTime() / 1000) : 0;
    if (commenceTime && commenceTime <= now) continue;

    const rsKey = findRSGameKey(game.away, game.home, rsGames);
    if (!rsKey) continue;

    const rsMarkets = rsGames[rsKey];
    const gameId    = rsGameIds[rsKey] || null;
    const rsSport   = rsGameSports[rsKey] || sport.rsKey;
    const gameUrl   = buildRSUrl(gameId, rsSport);

    const rsSpreadMkt = rsMarkets['Spread'];
    if (!rsSpreadMkt || !game.spreads) continue;

    const rsOutcomes = rsSpreadMkt.outcomes || [];
    const rsVolume   = rsSpreadMkt.volume ?? 0;

    for (const rsO of rsOutcomes) {
      if (!rsO.probability || rsO.line == null) continue;

      // Determine if this outcome is Home or Away by team name match
      const nRsLabel = normName(rsO.label);
      const nHome    = normName(game.home);
      const nAway    = normName(game.away);
      let dkSide;
      if (nHome.includes(nRsLabel) || nRsLabel.includes(nHome)) dkSide = 'Home';
      else if (nAway.includes(nRsLabel) || nRsLabel.includes(nAway)) dkSide = 'Away';
      else continue;

      const otherSide    = dkSide === 'Home' ? 'Away' : 'Home';
      const fdPrice      = lookupByLine(game.spreads[dkSide], rsO.line);
      const fdOtherPrice = lookupByLine(game.spreads[otherSide], -rsO.line);
      if (fdPrice == null || fdOtherPrice == null) continue;

      const noVig = noVigFair(fdPrice, fdOtherPrice);
      if (!noVig) continue;
      const fdFair = noVig.fa;

      const ev = calcEV(fdFair, rsO.probability, rsVolume);
      if (ev == null || ev < globalMinEv) continue;
      const u = unitsEV(ev, fdFair);
      if (u <= 0) continue;

      const sideName = dkSide === 'Home' ? game.home : game.away;
      const pt = rsO.line;
      allBets.push({
        sport, game: gameKey, market: 'Spread', side: sideName,
        ev: Math.round(ev * 10) / 10, units: u, fdOdds: fdPrice, pt,
        rsPct: Math.round(rsO.probability * 1000) / 10,
        adjFairPct: Math.round(fdFair * 1000) / 10,
        gameUrl, commenceTime,
        betKey: `${sport.fdKey}|${gameKey}|Spread|${sideName}|${pt ?? ''}`,
      });
    }
  }
}

// ── Main scheduled handler ─────────────────────────────

export default {
  async scheduled(event, env, ctx) {
    if (!env.TELEGRAM_BOT_TOKEN) return;

    const now = Math.floor(Date.now() / 1000);
    const FD_STALE_THRESHOLD = 30 * 60;
    const RS_STALE_THRESHOLD = 4 * 60 * 60;
    const RS_WARM_THRESHOLD  = 15;
    const RE_ALERT_EV_JUMP   = 4.0;
    // Midnight ET (UTC-4 during EDT) — taken bet suppression resets each calendar day
    const ET_OFFSET = 4 * 3600;
    const midnightET = Math.floor((now + ET_OFFSET) / 86400) * 86400 - ET_OFFSET;

    // Debug snapshot — written to D1 at end of each run for diagnostics
    const dbg = { ts: now, sports: {}, allBets: 0, sampleBets: [], sentCount: 0 };

    // 1. Load all verified, enabled users
    const users = await env.DB.prepare(
      `SELECT ns.user_id, ns.telegram_chat_id, ns.min_ev, ns.sports, ns.one_side, ns.unit_size
       FROM notification_settings ns
       JOIN users u ON u.id = ns.user_id
       WHERE ns.telegram_verified=1 AND ns.enabled=1 AND (u.plan='pro' OR u.is_admin=1)`
    ).all();

    if (!users.results || !users.results.length) {
      dbg.exit = 'no_users';
      await writeDebug(env, dbg);
      return;
    }

    // 2. Determine which sports are needed
    const sportsNeeded = new Set();
    for (const user of users.results) {
      if (!user.sports || user.sports === 'ALL') {
        ALL_SPORTS.forEach(s => sportsNeeded.add(s.fdKey));
      } else {
        user.sports.split(',').forEach(s => sportsNeeded.add(s.trim()));
      }
    }

    const globalMinEv = Math.min(...users.results.map(u => u.min_ev || 5));
    dbg.globalMinEv = globalMinEv;
    dbg.users = users.results.length;
    const allBets = [];

    // ── 3a. Native sports (FD/DK caches) ──────────────────

    for (const sport of NATIVE_SPORTS) {
      if (!sportsNeeded.has(sport.fdKey)) continue;

      // Load native FD/DK odds cache
      let fdGames = null;
      let fdAge = null;
      try {
        const cached = await env.DB.prepare(
          'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
        ).bind(sport.cacheKey).first();
        if (cached) {
          fdAge = now - cached.fetched_at;
          if (fdAge < FD_STALE_THRESHOLD) {
            const parsed = JSON.parse(cached.data);
            fdGames = parsed.games || null;
          }
        }
      } catch(e) {}

      const fdCount = fdGames ? Object.keys(fdGames).length : 0;
      if (!fdGames || !fdCount) {
        dbg.sports[sport.label] = { fdGames: 0, fdAge, rsGames: 0, reason: 'no_fd_cache' };
        continue;
      }

      // Warm RS cache if stale/missing, then load
      await warmRSCache(sport.fdKey, env, now, RS_WARM_THRESHOLD);
      const { games: rsGames, gameIds: rsGameIds, gameSports: rsGameSports, rsAge, reason: rsReason } =
        await loadRSCache(sport.rsKey, env, now, RS_STALE_THRESHOLD);

      const rsCount = Object.keys(rsGames).length;
      if (!rsCount) {
        dbg.sports[sport.label] = { fdGames: fdCount, fdAge, rsGames: 0, rsAge, reason: rsReason || 'no_rs_cache' };
        continue;
      }

      const beforeCount = allBets.length;
      if (sport.type === 'nba') {
        processNativeNBA(sport, fdGames, rsGames, rsGameIds, rsGameSports, globalMinEv, allBets, now);
      } else if (sport.type === 'ml_only') {
        processNativeML(sport, fdGames, rsGames, rsGameIds, rsGameSports, globalMinEv, allBets, now);
      } else if (sport.type === 'fc') {
        processNativeFC(sport, fdGames, rsGames, rsGameIds, rsGameSports, globalMinEv, allBets, now);
      }
      dbg.sports[sport.label] = { fdGames: fdCount, fdAge, rsGames: rsCount, betsAdded: allBets.length - beforeCount };
    }

    // ── 3b. Odds API sports (NCAAB + UFC) ─────────────────

    if (env.ODDS_API_KEY) {
      for (const sport of ODDS_API_SPORTS) {
        if (!sportsNeeded.has(sport.fdKey)) continue;

        let fdGames = null;
        try {
          const cached = await env.DB.prepare(
            `SELECT data, fetched_at FROM odds_cache WHERE cache_key LIKE ? ORDER BY fetched_at DESC LIMIT 1`
          ).bind('odds_' + sport.fdKey + '_%').first();
          if (cached && (now - cached.fetched_at) < FD_STALE_THRESHOLD) {
            fdGames = JSON.parse(cached.data);
          }
        } catch(e) {}

        if (!fdGames) {
          fdGames = await fetchFDOdds(sport.fdKey, env.ODDS_API_KEY);
          if (fdGames) {
            try {
              await env.DB.prepare(
                `INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?)
                 ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at`
              ).bind('odds_' + sport.fdKey + '_alerts', JSON.stringify(fdGames), now).run();
            } catch(e) {}
          }
        }

        if (!Array.isArray(fdGames) || !fdGames.length) continue;

        const { games: rsGames, gameIds: rsGameIds, gameSports: rsGameSports } =
          await loadRSCache(sport.rsKey, env, now, RS_STALE_THRESHOLD);

        if (!Object.keys(rsGames).length) continue;

        for (const game of fdGames) {
          const commenceTime = game.commence_time
            ? Math.floor(new Date(game.commence_time).getTime() / 1000)
            : 0;
          if (commenceTime && commenceTime <= now) continue;

          const fdAway = game.away_team;
          const fdHome = game.home_team;
          if (!fdAway || !fdHome) continue;

          const gameKey = fdAway + ' @ ' + fdHome;
          const rsKey   = findRSGameKey(fdAway, fdHome, rsGames);
          if (!rsKey) continue;

          const rsMarkets = rsGames[rsKey];
          const gameId    = rsGameIds[rsKey] || null;
          const rsSport   = rsGameSports[rsKey] || sport.rsKey;
          const gameUrl   = buildRSUrl(gameId, rsSport);

          const bms = game.bookmakers || [];
          const fd  = bms.find(b => b.key === 'fanduel') || bms.find(b => b.key === 'draftkings');
          if (!fd) continue;

          // ML only for Odds API sports
          const h2hMkt = (fd.markets || []).find(m => m.key === 'h2h');
          if (!h2hMkt) continue;

          const rsMktLabel = RS_ML_LABELS.find(l => rsMarkets[l]);
          if (!rsMktLabel) continue;

          const rsMkt      = rsMarkets[rsMktLabel];
          const rsOutcomes = rsMkt.outcomes || [];
          const rsVolume   = rsMkt.volume ?? 0;
          const fdOutcomes = h2hMkt.outcomes || [];
          if (fdOutcomes.length < 2) continue;

          const noVig = noVigFair(fdOutcomes[0].price, fdOutcomes[1].price);
          if (!noVig) continue;

          for (let i = 0; i < fdOutcomes.length; i++) {
            const fdO    = fdOutcomes[i];
            const fdFair = i === 0 ? noVig.fa : noVig.fb;
            const rsO    = findRSOutcome(fdO.name, rsOutcomes);
            if (!rsO || !rsO.probability) continue;

            const ev = calcEV(fdFair, rsO.probability, rsVolume);
            if (ev == null || ev < globalMinEv) continue;
            const u = unitsEV(ev, fdFair);
            if (u <= 0) continue;

            allBets.push({
              sport, game: gameKey, market: 'ML', side: fdO.name,
              ev: Math.round(ev * 10) / 10, units: u, fdOdds: fdO.price, pt: null,
              rsPct: Math.round(rsO.probability * 1000) / 10,
              adjFairPct: Math.round(fdFair * 1000) / 10,
              gameUrl, commenceTime,
              betKey: `${sport.fdKey}|${gameKey}|ML|${fdO.name}|`,
            });
          }
        }
      }
    }

    // ── 3c. MLB RFI (FD native, fd_rfi cache) ─────────────

    if (sportsNeeded.has('baseball_mlb')) {
      const rfiDbg = { rfiCacheAge: null, rfiMapSize: 0, rsMatchCount: 0, rfiMktCount: 0 };
      try {
        // Warm fd_rfi cache if stale
        if (env.SITE_URL && env.CRON_SECRET) {
          const rfiCheck = await env.DB.prepare(
            'SELECT fetched_at FROM odds_cache WHERE cache_key=?'
          ).bind('fd_rfi').first();
          if (!rfiCheck || (now - rfiCheck.fetched_at) > FD_STALE_THRESHOLD) {
            try { await fetch(`${env.SITE_URL}/api/fd/rfi?_cron_key=${env.CRON_SECRET}`, { signal: AbortSignal.timeout(15000) }); } catch(e) {}
          }
        }

        const rfiCached = await env.DB.prepare(
          'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
        ).bind('fd_rfi').first();

        rfiDbg.rfiCacheAge = rfiCached ? now - rfiCached.fetched_at : null;
        if (rfiCached && (now - rfiCached.fetched_at) < FD_STALE_THRESHOLD) {
          const rfiMap = JSON.parse(rfiCached.data).rfi || {};
          rfiDbg.rfiMapSize = Object.keys(rfiMap).length;
          const { games: rsGamesRfi, gameIds: rsGameIdsRfi, gameSports: rsGameSportsRfi } =
            await loadRSCache('mlb', env, now, RS_STALE_THRESHOLD);

          const mlbSport = NATIVE_SPORTS.find(s => s.fdKey === 'baseball_mlb');

          for (const [rfiGameKey, rfi] of Object.entries(rfiMap)) {
            const parts = rfiGameKey.split(' @ ');
            if (parts.length !== 2) continue;
            const rsKey = findRSGameKey(parts[0], parts[1], rsGamesRfi);
            if (!rsKey) continue;
            rfiDbg.rsMatchCount++;

            const rfiMkt = rsGamesRfi[rsKey]?.['Run in 1st inning?'];
            if (!rfiMkt) continue;
            rfiDbg.rfiMktCount++;

            const rsOutcomes = rfiMkt.outcomes || [];
            const rsVolume   = rfiMkt.volume ?? 0;
            const rsYes = rsOutcomes.find(o => /yrfi/i.test(o.label));
            const rsNo  = rsOutcomes.find(o => /nrfi/i.test(o.label));
            const gameId  = rsGameIdsRfi[rsKey] || null;
            const rsSport = rsGameSportsRfi[rsKey] || 'mlb';
            const gameUrl = buildRSUrl(gameId, rsSport);

            for (const { side, fdFair, fdOdds, rsO } of [
              { side: 'Yes (YRFI)', fdFair: rfi.yesFair, fdOdds: rfi.yesAm, rsO: rsYes },
              { side: 'No (NRFI)',  fdFair: rfi.noFair,  fdOdds: rfi.noAm,  rsO: rsNo  },
            ]) {
              if (!rsO || !rsO.probability) continue;
              const ev = calcEV(fdFair, rsO.probability, rsVolume);
              if (ev == null || ev < globalMinEv) continue;
              const u = unitsEV(ev, fdFair);
              if (u <= 0) continue;
              allBets.push({
                sport: mlbSport, game: rfiGameKey, market: 'RFI', side,
                ev: Math.round(ev * 10) / 10, units: u, fdOdds, pt: null,
                rsPct: Math.round(rsO.probability * 1000) / 10,
                adjFairPct: Math.round(fdFair * 1000) / 10,
                gameUrl, commenceTime: 0,
                betKey: `baseball_mlb|${rfiGameKey}|RFI|${side}|`,
              });
            }
          }
        }
      } catch(e) {}
      const rfiCount = allBets.filter(b => b.market === 'RFI').length;
      dbg.sports['MLB_RFI'] = { rfiGames: rfiCount, ...rfiDbg };
    }

    dbg.allBets = allBets.length;
    dbg.sampleBets = allBets.slice(0, 8).map(b => ({
      sport: b.sport.label, game: b.game, market: b.market, side: b.side, ev: b.ev,
      rsPct: b.rsPct, adjFairPct: b.adjFairPct
    }));

    if (!allBets.length) {
      dbg.exit = 'no_bets';
      await writeDebug(env, dbg);
      return;
    }

    // ── 4. Per-user alerting ───────────────────────────────

    for (const user of users.results) {
      const userSports = (!user.sports || user.sports === 'ALL')
        ? null
        : new Set(user.sports.split(',').map(s => s.trim()));

      const minEv    = user.min_ev || 5;
      const oneSide  = user.one_side === 1;
      const unitSize = user.unit_size || 100;

      let userBets = allBets.filter(b =>
        b.ev >= minEv && (!userSports || userSports.has(b.sport.fdKey))
      );

      // Skip markets the user marked taken today (ET day) — resets each calendar day
      try {
        const takenRows = await env.DB.prepare(
          'SELECT DISTINCT game, market FROM alert_messages WHERE user_id=? AND taken=1 AND sent_at>=?'
        ).bind(user.user_id, midnightET).all();
        const takenKeys = new Set((takenRows.results || []).map(r => r.game + '|' + r.market));
        if (takenKeys.size) {
          userBets = userBets.filter(b => !takenKeys.has(b.game + '|' + b.market));
        }
      } catch(e) {}

      // 1 Side filter: keep only highest EV side per game+market
      if (oneSide) {
        const bestPerMarket = new Map();
        for (const b of userBets) {
          const key = b.game + '|' + b.market;
          if (!bestPerMarket.has(key) || b.ev > bestPerMarket.get(key).ev) {
            bestPerMarket.set(key, b);
          }
        }
        userBets = Array.from(bestPerMarket.values());
      }

      if (!userBets.length) continue;

      // Batch-load existing alert log
      const betKeys = userBets.map(b => b.betKey);
      const placeholders = betKeys.map(() => '?').join(',');
      let existingLog = {};
      try {
        const logRows = await env.DB.prepare(
          `SELECT bet_key, last_ev, sent_at FROM alert_sent_log WHERE user_id=? AND bet_key IN (${placeholders})`
        ).bind(user.user_id, ...betKeys).all();
        for (const row of (logRows.results || [])) {
          existingLog[row.bet_key] = { ev: row.last_ev, sentAt: row.sent_at };
        }
      } catch(e) {}

      for (const bet of userBets) {
        const entry = existingLog[bet.betKey];
        if (entry) {
          const hoursSince = (now - entry.sentAt) / 3600;
          // Suppress re-alert only if: EV hasn't jumped 4%+ AND last alert was within 2 hours
          // The 2h escape hatch prevents algorithm-change EV mismatches from silencing alerts forever
          if (bet.ev - entry.ev < RE_ALERT_EV_JUMP && hoursSince < 2) continue;
        }

        const dollarAmt = Math.round(bet.units * unitSize);
        const message   = formatAlert(bet.sport, bet.game, bet.market, bet.side, bet.ev, bet.units, dollarAmt, bet.pt, bet.rsPct, bet.adjFairPct, bet.gameUrl);

        let alertRowId = null;
        try {
          const ins = await env.DB.prepare(
            `INSERT INTO alert_messages (user_id, chat_id, bet_key, sport, game, market, side, pt, ev, units, dollar_amt, sent_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(user.user_id, user.telegram_chat_id, bet.betKey, bet.sport.label, bet.game, bet.market, bet.side, bet.pt ?? null, bet.ev, bet.units, dollarAmt, now).run();
          alertRowId = ins.meta.last_row_id;
        } catch(e) {}

        const replyMarkup = alertRowId ? {
          inline_keyboard: [[{ text: '✅ Mark Bet Taken', callback_data: 't:' + alertRowId }]]
        } : undefined;

        const msgId = await sendTelegram(user.telegram_chat_id, message, env.TELEGRAM_BOT_TOKEN, replyMarkup);
        if (msgId) dbg.sentCount++;

        if (msgId && alertRowId) {
          try {
            await env.DB.prepare('UPDATE alert_messages SET msg_id=? WHERE id=?').bind(msgId, alertRowId).run();
          } catch(e) {}
        }

        try {
          await env.DB.prepare(
            `INSERT INTO alert_sent_log (user_id, bet_key, last_ev, sent_at) VALUES (?,?,?,?)
             ON CONFLICT(user_id, bet_key) DO UPDATE SET last_ev=excluded.last_ev, sent_at=excluded.sent_at`
          ).bind(user.user_id, bet.betKey, bet.ev, now).run();
        } catch(e) {}

        await new Promise(r => setTimeout(r, 50));
      }
    }

    // ── 5. Cleanup + debug write ───────────────────────────

    await writeDebug(env, dbg);

    try {
      await env.DB.prepare('DELETE FROM alert_sent_log WHERE sent_at < ?')
        .bind(now - 36 * 3600).run();
    } catch(e) {}

    try {
      await env.DB.prepare('DELETE FROM telegram_verify_tokens WHERE expires_at < ?')
        .bind(now).run();
    } catch(e) {}
  }
};

async function writeDebug(env, dbg) {
  try {
    await env.DB.prepare(
      'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
    ).bind('cron_debug', JSON.stringify(dbg), dbg.ts).run();
  } catch(e) {}
}
