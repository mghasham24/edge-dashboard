// workers/alert-cron/index.js
// Runs every 60 seconds via Cloudflare Cron Trigger.
// For each pro user with Telegram verified:
//   1. Load odds from native FD/DK caches (same source as the site)
//   2. Calculate EV vs RS fair probabilities
//   3. Alert if EV >= user threshold and bet not already sent
//   4. Re-alert if EV jumped +4% since last message (new unit tier)
//   5. Includes live in-game bets (FD/DK still showing open markets)
//
// Native cache sources (matches the site exactly):
//   NBA  → fd_nba_alts   (FD native, ML + spread + total)
//   WNBA → fd_wnba_alts  (FD native, ML + spread + total)
//   MLB  → fd_mlb        (FD native, ML only)  + fd_rfi (RFI)
//   NHL  → fd_nhl        (FD native, ML + spread + total)
//   FC   → fd_fc         (DK native, AH spread)
//   NCAAB, UFC → Odds API (no native endpoint exists)

import Hashids from 'hashids';

const _hashids = new Hashids('routing', 11);
const RS_SPORT_KEY_ID = { nba:1, nfl:2, cbb:3, mlb:4, nhl:7, ufc:10, wnba:12, soccer:14 };

function buildRSUrl(gid, rsSportKey, marketId) {
  if (marketId) {
    return 'https://www.realapp.com/' + _hashids.encode([36, 0, 0, marketId]);
  }
  if (!gid) return null;
  const sportId = RS_SPORT_KEY_ID[rsSportKey] ?? 0;
  return 'https://www.realapp.com/' + _hashids.encode([4, sportId, 0, gid]);
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

// Probability-based rake — empirically measured via RS Socket.io payout data.
// Rake depends on RS probability (underdogs pay more), not volume.
// Volume only affects slippage (small for typical bet sizes, ignored here).
function rsBaseTake(p) {
  const pts = [[0.0918,0.0535],[0.13,0.065],[0.1737,0.0464],[0.32,0.046],[0.3757,0.039],[0.49,0.020],[0.59,0.018],[0.73,0.015],[0.7816,0.0125]];
  if (p <= pts[0][0]) return pts[0][1];
  if (p >= pts[pts.length-1][0]) return pts[pts.length-1][1];
  for (let i = 0; i < pts.length - 1; i++) {
    if (p >= pts[i][0] && p < pts[i+1][0]) {
      const t = (p - pts[i][0]) / (pts[i+1][0] - pts[i][0]);
      return pts[i][1] + t * (pts[i+1][1] - pts[i][1]);
    }
  }
  return 0.034;
}

// EV% — FD/DK no-vig is the "true" probability; RS is the betting market.
function calcEV(fdNoVigProb, rsImpliedProb) {
  if (!fdNoVigProb || !rsImpliedProb || rsImpliedProb <= 0) return null;
  const rake = rsBaseTake(rsImpliedProb);
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
  { fdKey: 'basketball_nba',        rsKey: 'nba',    label: 'NBA',   cacheKey: 'fd_nba_alts',  type: 'nba'     },
  { fdKey: 'basketball_wnba',       rsKey: 'wnba',   label: 'WNBA',  cacheKey: 'fd_wnba_alts', type: 'nba'     },
  { fdKey: 'baseball_mlb',          rsKey: 'mlb',    label: 'MLB',   cacheKey: 'fd_mlb',       type: 'ml_only' },
  { fdKey: 'icehockey_nhl',         rsKey: 'nhl',    label: 'NHL',   cacheKey: 'fd_nhl',       type: 'nhl'     },
  { fdKey: 'soccer_fc',             rsKey: 'soccer', label: 'FC',    cacheKey: 'fd_fc',        type: 'fc'      },
  { fdKey: 'soccer_wc',             rsKey: 'soccer', label: 'WC',    cacheKey: 'fd_wc',        type: 'fc'      },
];

// FD/DK site endpoints — cron calls these to keep odds fresh during live games
const FD_ENDPOINT_MAP = {
  'basketball_nba':  '/api/fd/nbaalts',
  'basketball_wnba': '/api/fd/wnbaalts',
  'baseball_mlb':    '/api/fd/mlb',
  'icehockey_nhl':   '/api/fd/nhl',
  'soccer_fc':       '/api/fd/fc',
  'soccer_wc':       '/api/fd/wc',
};

// DK alt lines endpoints — NBA and NHL only; alt spreads/totals stay open longer during live games
const DK_ALT_ENDPOINT_MAP = {
  'basketball_nba': { endpoint: '/api/dk/nbaalts', cacheKey: 'dk_nba_alts' },
  'icehockey_nhl':  { endpoint: '/api/dk/nhalalts', cacheKey: 'dk_nhl_alts' },
};

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
  const gameStartMs = {};
  if (!cacheData || typeof cacheData !== 'object') return { games, gameIds, gameSports, gameStartMs };
  for (const [key, val] of Object.entries(cacheData)) {
    if (key.endsWith('__gid'))     { gameIds[key.slice(0, -5)] = val; continue; }
    if (key.endsWith('__sport'))   { gameSports[key.slice(0, -7)] = val; continue; }
    if (key.endsWith('__startMs')) { gameStartMs[key.slice(0, -9)] = val; continue; }
    if (key.endsWith('__lines')) continue;
    if (val && typeof val === 'object' &&
        (val['Moneyline'] || val['Game Winner'] || val['Spread'] || val['Total'] ||
         val['Total Runs'] || val['Total Goals'] || val['Run in 1st inning?'] ||
         val['Fight Outcome'] || val['Fight Winner'] || val['Match Winner'] || val['Winner'] ||
         val['Match Result'])) {
      games[key] = val;
    }
  }
  return { games, gameIds, gameSports, gameStartMs };
}

const FDKEY_TO_RSKEY = {
  'basketball_nba': 'nba', 'basketball_wnba': 'wnba', 'baseball_mlb': 'mlb',
  'icehockey_nhl': 'nhl', 'soccer_fc': 'soccer', 'soccer_wc': 'soccer',
  'basketball_ncaab': 'cbb', 'mma_mixed_martial_arts': 'ufc'
};

async function warmRSCache(fdKey, env, now, staleThreshold) {
  if (!env.SITE_URL || !env.CRON_SECRET) return;
  try {
    const rsKey = FDKEY_TO_RSKEY[fdKey] || fdKey;
    // Use LIKE to match any version of the RS sync cache key
    const cached = await env.DB.prepare(
      "SELECT fetched_at FROM odds_cache WHERE cache_key LIKE ? ORDER BY fetched_at DESC LIMIT 1"
    ).bind('real_sync_' + rsKey + '_%').first();
    if (cached && (now - cached.fetched_at) < staleThreshold) return;
    const r = await fetch(`${env.SITE_URL}/api/real/sync?sport=${fdKey}&_cron_key=${env.CRON_SECRET}`, {
      signal: AbortSignal.timeout(25000)
    });
    await r.body?.cancel();
  } catch(e) {}
}

// Keeps FD/DK native odds cache fresh during live games — cron calls site endpoint with cron key bypass
async function warmFDCache(fdKey, cacheKey, env, now, staleThreshold, endpointOverride) {
  if (!env.SITE_URL || !env.CRON_SECRET) return;
  const endpoint = endpointOverride || FD_ENDPOINT_MAP[fdKey];
  if (!endpoint) return;
  try {
    const cached = await env.DB.prepare(
      'SELECT fetched_at FROM odds_cache WHERE cache_key=?'
    ).bind(cacheKey).first();
    if (cached && (now - cached.fetched_at) < staleThreshold) return;
    const r = await fetch(`${env.SITE_URL}${endpoint}?_cron_key=${env.CRON_SECRET}`, {
      signal: AbortSignal.timeout(15000)
    });
    await r.body?.cancel();
  } catch(e) {}
}

async function loadRSCache(rsKey, env, now, staleThreshold) {
  try {
    // Use LIKE to match any version of the RS sync cache key — version bumps in sync.js
    // no longer break the alert cron
    const cached = await env.DB.prepare(
      "SELECT data, fetched_at FROM odds_cache WHERE cache_key LIKE ? ORDER BY fetched_at DESC LIMIT 1"
    ).bind('real_sync_' + rsKey + '_%').first();
    const age = cached ? now - cached.fetched_at : null;
    if (cached && age < staleThreshold) {
      return { ...parseRSCache(JSON.parse(cached.data)), rsAge: age };
    }
    if (cached) return { games: {}, gameIds: {}, gameSports: {}, gameStartMs: {}, rsAge: age, reason: 'rs_stale' };
  } catch(e) {}
  return { games: {}, gameIds: {}, gameSports: {}, gameStartMs: {}, rsAge: null, reason: 'rs_missing' };
}

// ── Game key normalization ─────────────────────────────

// normName strips "united", so "United States" becomes "states" and "USA" becomes "usa".
// This alias map lets them still match each other for WC team name lookups.
const WC_NORM_ALIAS = { 'usa': 'states', 'states': 'usa', 'turkiye': 'turkey', 'turkey': 'turkiye' };

function normName(name) {
  return (name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // ü→u, é→e, etc.
    .toLowerCase()
    .replace(/\bfc\b/g, '')
    .replace(/\bunited\b/g, '')
    .replace(/\bcity\b/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findRSGameKey(fdAway, fdHome, rsGames, fdGameKey) {
  const gameNumMatch = fdGameKey && fdGameKey.match(/\(Game (\d+)\)/);
  const isDH2 = gameNumMatch && parseInt(gameNumMatch[1]) >= 2;
  const baseKey = fdAway + ' @ ' + fdHome;
  const dh2Key  = baseKey + ' (2)';

  if (isDH2) {
    if (rsGames[dh2Key])  return dh2Key;
    if (rsGames[baseKey]) return baseKey;
  } else {
    if (rsGames[baseKey]) return baseKey;
  }

  const nAway = normName(fdAway);
  const nHome = normName(fdHome);
  const _nAwayAlt = WC_NORM_ALIAS[nAway] || '';
  const _nHomeAlt = WC_NORM_ALIAS[nHome] || '';
  let fallback = null;
  for (const rsKey of Object.keys(rsGames)) {
    const isVariant = rsKey.endsWith(' (2)');
    if (!isDH2 && isVariant) continue;
    const basePart = isVariant ? rsKey.slice(0, -4) : rsKey;
    const parts = basePart.split(' @ ');
    if (parts.length !== 2) continue;
    const nRA = normName(parts[0]);
    const nRH = normName(parts[1]);
    const _nRAAlt = WC_NORM_ALIAS[nRA] || '';
    const _nRHAlt = WC_NORM_ALIAS[nRH] || '';
    if (
      (nRA.includes(nAway) || nAway.includes(nRA) || (_nAwayAlt && nRA.includes(_nAwayAlt)) || (_nRAAlt && _nRAAlt.includes(nAway))) &&
      (nRH.includes(nHome) || nHome.includes(nRH) || (_nHomeAlt && nRH.includes(_nHomeAlt)) || (_nRHAlt && _nRHAlt.includes(nHome)))
    ) {
      if (isDH2 && isVariant) return rsKey;
      fallback = rsKey;
    }
  }
  return fallback;
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

function formatAlert(sport, game, market, side, ev, units, dollarAmt, pt, rsPct, adjFairPct, gameUrl, isLive) {
  const ptStr   = pt != null ? ' ' + (pt > 0 ? '+' : '') + pt : '';
  const lineStr = market === 'ML' || market === 'RFI' ? side : side + ptStr;
  const header  = isLive ? '⚡ <b>Live Alert</b>' : '🔔 <b>RaxEdge Alert</b>';

  const evStr  = (ev >= 0 ? '+' : '') + ev.toFixed(1) + '% EV';
  const rsLine = rsPct != null
    ? rsPct.toFixed(1) + '% RS · ' + evStr + ' · ' + units + 'u · ' + dollarAmt + ' Rax'
    : evStr + ' · ' + units + 'u · ' + dollarAmt + ' Rax';

  let sensLine = '';
  let fairLine = '';
  if (rsPct != null && adjFairPct != null) {
    const rsProb1  = Math.min(0.999, rsPct / 100 + 0.01);
    const fdFair   = adjFairPct / 100;
    const evPlus1  = calcEV(fdFair, rsProb1);
    const uPlus1   = unitsEV(evPlus1, fdFair);
    const evP1Str  = (evPlus1 >= 0 ? '+' : '') + evPlus1.toFixed(1) + '% EV';
    const bet1     = uPlus1 > 0 ? Math.round(uPlus1 * dollarAmt / units) : 0;
    const u1Str    = uPlus1 > 0 ? uPlus1 + 'u · ' + bet1 + ' Rax' : '0u';
    sensLine = (rsProb1 * 100).toFixed(1) + '% RS · ' + evP1Str + ' · ' + u1Str + '\n';
    fairLine = adjFairPct.toFixed(1) + '% Fair\n';
  } else if (adjFairPct != null) {
    fairLine = adjFairPct.toFixed(1) + '% Fair\n';
  }

  const teams     = game.split(' @ ');
  const shortGame = (teams[0] || game) + ' @ ' + (teams[1] || '');
  const linkLine  = gameUrl ? `\n<a href="${gameUrl}">View on Real Sports ↗</a>` : '';

  return (
    `${header}\n\n` +
    `<b>${lineStr}</b> · ${market} · ${sport.label}\n` +
    `${rsLine}\n` +
    sensLine +
    fairLine +
    `\n<i>${shortGame}</i>${linkLine}`
  );
}

// ── Native cache processors ────────────────────────────

// ML-only sports: MLB (fd_mlb) and NHL (fd_nhl)
// Cache: { ok, games: { "Away @ Home": { id, away, home, cm, ml: { TeamName: price } } } }
function processNativeML(sport, fdGames, rsGames, rsGameIds, rsGameSports, globalMinEv, allBets, now, rsGameStartMs) {
  for (const [gameKey, game] of Object.entries(fdGames)) {
    const commenceTime = game.cm ? Math.floor(new Date(game.cm).getTime() / 1000) : 0;
    if (commenceTime && commenceTime < now - 4 * 3600) continue; // skip games ended >4h ago
    const isLive = commenceTime > 0 && commenceTime <= now;

    const rsKey = findRSGameKey(game.away, game.home, rsGames, gameKey);
    if (!rsKey) continue;

    // Guard: don't match a future FD game to an already-started RS game (e.g. late game past midnight)
    if (commenceTime > 0 && !isLive && rsGameStartMs) {
      const rsStart = rsGameStartMs[rsKey];
      if (rsStart && rsStart < (now - 3600) * 1000) continue;
    }

    const rsMarkets = rsGames[rsKey];
    const gameId    = rsGameIds[rsKey] || null;
    const rsSport   = rsGameSports[rsKey] || sport.rsKey;

    // Find RS ML market (Moneyline or Game Winner)
    const rsMktLabel = RS_ML_LABELS.find(l => rsMarkets[l]);
    if (!rsMktLabel) continue;

    const rsMkt      = rsMarkets[rsMktLabel];
    const gameUrl    = buildRSUrl(gameId, rsSport, rsMkt.id);
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

      const ev = calcEV(fdFair, rsO.probability);
      if (ev == null || ev < globalMinEv || ev > 200) continue;

      const u = unitsEV(ev, fdFair);
      if (u <= 0) continue;

      allBets.push({
        sport, game: gameKey, market: 'ML', side: name,
        ev: Math.round(ev * 10) / 10, units: u, fdOdds, pt: null,
        rsPct: Math.round(rsO.probability * 1000) / 10,
        adjFairPct: Math.round(fdFair * 1000) / 10,
        gameUrl, commenceTime, isLive, rsGameId: gameId, rsSport,
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
function processNativeNBA(sport, fdGames, rsGames, rsGameIds, rsGameSports, globalMinEv, allBets, now, rsGameStartMs) {
  for (const [gameKey, game] of Object.entries(fdGames)) {
    const commenceTime = game.cm ? Math.floor(new Date(game.cm).getTime() / 1000) : 0;
    if (commenceTime && commenceTime < now - 4 * 3600) continue; // skip games ended >4h ago
    const isLive = commenceTime > 0 && commenceTime <= now;

    const rsKey = findRSGameKey(game.away, game.home, rsGames, gameKey);
    if (!rsKey) continue;

    // Guard: don't match a future FD game to an already-started RS game (e.g. late game past midnight)
    if (commenceTime > 0 && !isLive && rsGameStartMs) {
      const rsStart = rsGameStartMs[rsKey];
      if (rsStart && rsStart < (now - 3600) * 1000) continue;
    }

    const rsMarkets = rsGames[rsKey];
    const gameId    = rsGameIds[rsKey] || null;
    const rsSport   = rsGameSports[rsKey] || sport.rsKey;

    // ── ML ──
    const rsMlLabel = RS_ML_LABELS.find(l => rsMarkets[l]);
    if (rsMlLabel) {
      const rsMkt      = rsMarkets[rsMlLabel];
      const gameUrl    = buildRSUrl(gameId, rsSport, rsMkt.id);
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
            const ev = calcEV(fdFair, rsO.probability);
            if (ev == null || ev < globalMinEv || ev > 200) continue;
            const u = unitsEV(ev, fdFair);
            if (u <= 0) continue;
            allBets.push({
              sport, game: gameKey, market: 'ML', side: name,
              ev: Math.round(ev * 10) / 10, units: u, fdOdds, pt: null,
              rsPct: Math.round(rsO.probability * 1000) / 10,
              adjFairPct: Math.round(fdFair * 1000) / 10,
              gameUrl, commenceTime, isLive, rsGameId: gameId, rsSport,
              betKey: `${sport.fdKey}|${gameKey}|ML|${name}|`,
            });
          }
        }
      }
    }

    // ── Spread ──
    const rsSpreadMkt = rsMarkets['Spread'];
    if (rsSpreadMkt && game.spreads) {
      const spreadUrl  = buildRSUrl(gameId, rsSport, rsSpreadMkt.id);
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
        const ev = calcEV(fdFair, rsO.probability);
        if (ev == null || ev < globalMinEv || ev > 200) continue;
        const u = unitsEV(ev, fdFair);
        if (u <= 0) continue;
        const pt = rsO.line;
        allBets.push({
          sport, game: gameKey, market: 'Spread', side: fdTeam,
          ev: Math.round(ev * 10) / 10, units: u, fdOdds: fdPrice, pt,
          rsPct: Math.round(rsO.probability * 1000) / 10,
          adjFairPct: Math.round(fdFair * 1000) / 10,
          gameUrl: spreadUrl, commenceTime, isLive, rsGameId: gameId, rsSport,
          betKey: `${sport.fdKey}|${gameKey}|Spread|${fdTeam}|${pt ?? ''}`,
        });
      }
    }

    // ── Total ──
    const rsTotalMkt = rsMarkets['Total'] || rsMarkets['Total Goals'];
    if (rsTotalMkt && game.totals) {
      const totalUrl   = buildRSUrl(gameId, rsSport, rsTotalMkt.id);
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
        const ev = calcEV(fdFair, rsO.probability);
        if (ev == null || ev < globalMinEv || ev > 200) continue;
        const u = unitsEV(ev, fdFair);
        if (u <= 0) continue;
        const pt = rsO.line;
        allBets.push({
          sport, game: gameKey, market: 'Total', side,
          ev: Math.round(ev * 10) / 10, units: u, fdOdds: fdPrice, pt,
          rsPct: Math.round(rsO.probability * 1000) / 10,
          adjFairPct: Math.round(fdFair * 1000) / 10,
          gameUrl: totalUrl, commenceTime, isLive, rsGameId: gameId, rsSport,
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
function processNativeFC(sport, fdGames, rsGames, rsGameIds, rsGameSports, globalMinEv, allBets, now, rsGameStartMs) {
  for (const [gameKey, game] of Object.entries(fdGames)) {
    const commenceTime = game.cm ? Math.floor(new Date(game.cm).getTime() / 1000) : 0;
    if (commenceTime && commenceTime < now - 4 * 3600) continue; // skip games ended >4h ago
    const isLive = commenceTime > 0 && commenceTime <= now;

    const rsKey = findRSGameKey(game.away, game.home, rsGames, gameKey);
    if (!rsKey) continue;

    // Guard: don't match a future FD game to an already-started RS game (e.g. late game past midnight)
    if (commenceTime > 0 && !isLive && rsGameStartMs) {
      const rsStart = rsGameStartMs[rsKey];
      if (rsStart && rsStart < (now - 3600) * 1000) continue;
    }

    const rsMarkets   = rsGames[rsKey];
    const gameId      = rsGameIds[rsKey] || null;
    const rsSport     = rsGameSports[rsKey] || sport.rsKey;
    if (!game.spreads) continue;

    const rsSpreadMkt = rsMarkets['Spread'];
    const rsMRMkt     = rsMarkets['Match Result'];

    if (rsSpreadMkt) {
      // Normal FC path — RS has AH spread markets with explicit lines.
      const gameUrl    = buildRSUrl(gameId, rsSport, rsSpreadMkt.id);
      const rsOutcomes = rsSpreadMkt.outcomes || [];

      for (const rsO of rsOutcomes) {
        if (!rsO.probability || rsO.line == null) continue;

        const nRsLabel = normName(rsO.label);
        const nHome    = normName(game.home);
        const nAway    = normName(game.away);
        const _nRsAlt  = WC_NORM_ALIAS[nRsLabel] || '';
        let dkSide;
        if (nHome.includes(nRsLabel) || nRsLabel.includes(nHome) || (_nRsAlt && (nHome.includes(_nRsAlt) || _nRsAlt === nHome))) dkSide = 'Home';
        else if (nAway.includes(nRsLabel) || nRsLabel.includes(nAway) || (_nRsAlt && (nAway.includes(_nRsAlt) || _nRsAlt === nAway))) dkSide = 'Away';
        else continue;

        const otherSide    = dkSide === 'Home' ? 'Away' : 'Home';
        const fdPrice      = lookupByLine(game.spreads[dkSide], rsO.line);
        const fdOtherPrice = lookupByLine(game.spreads[otherSide], -rsO.line);
        if (fdPrice == null || fdOtherPrice == null) continue;

        const noVig = noVigFair(fdPrice, fdOtherPrice);
        if (!noVig) continue;
        const fdFair = noVig.fa;

        const ev = calcEV(fdFair, rsO.probability);
        if (ev == null || ev < globalMinEv || ev > 200) continue;
        const u = unitsEV(ev, fdFair);
        if (u <= 0) continue;

        const sideName = dkSide === 'Home' ? game.home : game.away;
        const pt = rsO.line;
        allBets.push({
          sport, game: gameKey, market: 'Spread', side: sideName,
          ev: Math.round(ev * 10) / 10, units: u, fdOdds: fdPrice, pt,
          rsPct: Math.round(rsO.probability * 1000) / 10,
          adjFairPct: Math.round(fdFair * 1000) / 10,
          gameUrl, commenceTime, isLive, rsGameId: gameId, rsSport,
          betKey: `${sport.fdKey}|${gameKey}|Spread|${sideName}|${pt ?? ''}`,
        });
      }

    } else if (rsMRMkt) {
      // WC fallback — RS only has Match Result (3-way). Convert to AH ±0.5:
      //   Home -0.5 = P(Home win outright)
      //   Away +0.5 = P(Away win) + P(Draw) = 1 - P(Home win)
      const gameUrl  = buildRSUrl(gameId, rsSport, rsMRMkt.id);
      const nHome    = normName(game.home);
      const nAway    = normName(game.away);
      let pHome = null, pAway = null, pDraw = null;
      let homeIsWod = false, awayIsWod = false;

      for (const o of (rsMRMkt.outcomes || [])) {
        if (!o.probability) continue;
        const nL  = normName(o.label);
        const alt = WC_NORM_ALIAS[nL] || '';
        const wod = /win or draw/i.test(o.rawLabel || o.label);
        if (nL === 'draw' || nL === 'tie') { pDraw = o.probability; continue; }
        if (nHome.includes(nL) || nL.includes(nHome) || (alt && (nHome.includes(alt) || alt === nHome))) { pHome = o.probability; homeIsWod = wod; }
        else if (nAway.includes(nL) || nL.includes(nAway) || (alt && (nAway.includes(alt) || alt === nAway))) { pAway = o.probability; awayIsWod = wod; }
      }
      if (pHome == null || pAway == null) continue;

      // WoD detection uses rawLabel (original RS label before keyToName strips " Win or Draw").
      // The team whose rawLabel contains "Win or Draw" is the +0.5 underdog side.
      let homeAHLine, awayAHLine, pHomeAH, pAwayAH;
      if (homeIsWod && !awayIsWod) {
        homeAHLine =  0.5; awayAHLine = -0.5;
        pHomeAH = pHome; pAwayAH = pAway;
      } else if (awayIsWod && !homeIsWod) {
        homeAHLine = -0.5; awayAHLine =  0.5;
        pHomeAH = pHome; pAwayAH = pAway;
      } else {
        // Standard 3-way (separate Draw outcome)
        homeAHLine = -0.5; awayAHLine =  0.5;
        pHomeAH = pHome; pAwayAH = pAway + (pDraw || 0);
      }

      const ahSides = [
        { side: 'Home', rsPct: pHomeAH, otherSide: 'Away', line: homeAHLine, otherLine: awayAHLine, sideName: game.home },
        { side: 'Away', rsPct: pAwayAH, otherSide: 'Home', line: awayAHLine, otherLine: homeAHLine, sideName: game.away },
      ];
      for (const { side, rsPct, otherSide, line, otherLine, sideName } of ahSides) {
        const fdPrice      = lookupByLine(game.spreads[side], line);
        const fdOtherPrice = lookupByLine(game.spreads[otherSide], otherLine);
        if (fdPrice == null || fdOtherPrice == null) continue;

        const noVig = noVigFair(fdPrice, fdOtherPrice);
        if (!noVig) continue;
        const fdFair = noVig.fa;

        const ev = calcEV(fdFair, rsPct);
        if (ev == null || ev < globalMinEv || ev > 200) continue;
        const u = unitsEV(ev, fdFair);
        if (u <= 0) continue;

        allBets.push({
          sport, game: gameKey, market: 'Spread', side: sideName,
          ev: Math.round(ev * 10) / 10, units: u, fdOdds: fdPrice, pt: line,
          rsPct: Math.round(rsPct * 1000) / 10,
          adjFairPct: Math.round(fdFair * 1000) / 10,
          gameUrl, commenceTime, isLive, rsGameId: gameId, rsSport,
          betKey: `${sport.fdKey}|${gameKey}|Spread|${sideName}|${line}`,
        });
      }
    }
  }
}

// ── Main cron logic (called by scheduler and HTTP trigger) ────────────────

async function runCron(env, ctx) {
  if (!env.TELEGRAM_BOT_TOKEN) return;

    const now = Math.floor(Date.now() / 1000);
    const FD_STALE_THRESHOLD = 30 * 60;
    const FD_WARM_THRESHOLD  = 30;  // refresh FD if no recent site traffic (keeps live odds current)
    const RS_STALE_THRESHOLD = 4 * 60 * 60;
    const RS_WARM_THRESHOLD  = 0;   // always warm RS — sync endpoint returns in <1s if cache is fresh (15s TTL), so no wasted work
    const RE_ALERT_EV_JUMP   = 4.0;
    const RESEND_AFTER_SECS  = 1 * 3600; // re-alert on persistent +EV bets every hour
    // Midnight ET — taken bet suppression resets each calendar day.
    // Compute by asking Intl how many seconds into the current ET day we are,
    // then subtracting that from now. Handles EDT/EST automatically.
    const _etParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).formatToParts(new Date(now * 1000));
    const _etH = parseInt(_etParts.find(p => p.type === 'hour').value);
    const _etMin = parseInt(_etParts.find(p => p.type === 'minute').value);
    const _etSec = parseInt(_etParts.find(p => p.type === 'second').value);
    const midnightET = now - (_etH * 3600 + _etMin * 60 + _etSec);

    // Debug snapshot — written to D1 at end of each run for diagnostics
    const dbg = { ts: now, sports: {}, allBets: 0, sampleBets: [], sentCount: 0, suppressedCount: 0, failedSends: 0 };

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
    // Use a lower threshold for ev_bets_latest so the VPS group poster can apply
    // WS payout EV (which is often higher than the traditional formula) as the real gate.
    const posterMinEv = Math.min(globalMinEv, 5);
    dbg.globalMinEv = globalMinEv;
    dbg.posterMinEv = posterMinEv;
    dbg.users = users.results.length;
    const allBets = [];

    // ── 3a. Native sports (FD/DK caches) ──────────────────

    // Warm FD + RS caches in background — fired via ctx.waitUntil so they don't consume
    // CPU budget on the critical path. Next cron tick reads whatever is in D1 already.
    const sportsNativeNeeded = NATIVE_SPORTS.filter(s => sportsNeeded.has(s.fdKey));
    const sportsOddsApiNeeded = ODDS_API_SPORTS.filter(s => sportsNeeded.has(s.fdKey));
    ctx.waitUntil(Promise.all([
      ...sportsNativeNeeded.flatMap(s => {
        const dkAlt = DK_ALT_ENDPOINT_MAP[s.fdKey];
        return [
          warmFDCache(s.fdKey, s.cacheKey, env, now, FD_WARM_THRESHOLD),
          warmRSCache(s.fdKey, env, now, RS_WARM_THRESHOLD),
          ...(dkAlt ? [warmFDCache(s.fdKey, dkAlt.cacheKey, env, now, FD_WARM_THRESHOLD, dkAlt.endpoint)] : []),
        ];
      }),
      ...sportsOddsApiNeeded.map(s => warmRSCache(s.fdKey, env, now, RS_WARM_THRESHOLD)),
    ]));

    for (const sport of NATIVE_SPORTS) {
      if (!sportsNeeded.has(sport.fdKey)) continue;

      // Load native FD/DK odds cache (fresh after parallel warm above)
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

      const { games: rsGames, gameIds: rsGameIds, gameSports: rsGameSports, gameStartMs: rsGameStartMs, rsAge, reason: rsReason } =
        await loadRSCache(sport.rsKey, env, now, RS_STALE_THRESHOLD);

      const rsCount = Object.keys(rsGames).length;
      if (!rsCount) {
        dbg.sports[sport.label] = { fdGames: fdCount, fdAge, rsGames: 0, rsAge, reason: rsReason || 'no_rs_cache' };
        continue;
      }

      // Merge DK alt spread/total lines into fdGames for NBA/NHL
      // DK alt markets stay open longer during live play — fills gaps when FD suspends its alt markets
      const dkAltCfg = DK_ALT_ENDPOINT_MAP[sport.fdKey];
      if (dkAltCfg) {
        try {
          const dkRow = await env.DB.prepare(
            'SELECT data FROM odds_cache WHERE cache_key=?'
          ).bind(dkAltCfg.cacheKey).first();
          if (dkRow) {
            const dkGames = JSON.parse(dkRow.data).games || {};
            for (const [gameKey, game] of Object.entries(fdGames)) {
              const dkGame = dkGames[gameKey];
              if (!dkGame) continue;
              // For live games with frozen FD data, prefer fresh DK alt prices over stale frozen FD prices
              const preferDk = game.live === true;
              if (dkGame.spreads) {
                if (!game.spreads) game.spreads = {};
                if ((preferDk || !game.spreads[game.away] || !Object.keys(game.spreads[game.away]).length) &&
                    dkGame.spreads.Away && Object.keys(dkGame.spreads.Away).length) {
                  game.spreads[game.away] = dkGame.spreads.Away;
                }
                if ((preferDk || !game.spreads[game.home] || !Object.keys(game.spreads[game.home]).length) &&
                    dkGame.spreads.Home && Object.keys(dkGame.spreads.Home).length) {
                  game.spreads[game.home] = dkGame.spreads.Home;
                }
              }
              if (dkGame.totals) {
                if (!game.totals) game.totals = {};
                if ((preferDk || !game.totals.Over  || !Object.keys(game.totals.Over ).length) &&
                    dkGame.totals.Over  && Object.keys(dkGame.totals.Over ).length) {
                  game.totals.Over  = dkGame.totals.Over;
                }
                if ((preferDk || !game.totals.Under || !Object.keys(game.totals.Under).length) &&
                    dkGame.totals.Under && Object.keys(dkGame.totals.Under).length) {
                  game.totals.Under = dkGame.totals.Under;
                }
              }
            }
          }
        } catch(e) {}
      }

      const beforeCount = allBets.length;
      if (sport.type === 'nba' || sport.type === 'nhl') {
        processNativeNBA(sport, fdGames, rsGames, rsGameIds, rsGameSports, posterMinEv, allBets, now, rsGameStartMs);
      } else if (sport.type === 'ml_only') {
        processNativeML(sport, fdGames, rsGames, rsGameIds, rsGameSports, posterMinEv, allBets, now, rsGameStartMs);
      } else if (sport.type === 'fc') {
        processNativeFC(sport, fdGames, rsGames, rsGameIds, rsGameSports, posterMinEv, allBets, now, rsGameStartMs);
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
          const rsKey   = findRSGameKey(fdAway, fdHome, rsGames, gameKey);
          if (!rsKey) continue;

          const rsMarkets = rsGames[rsKey];
          const gameId    = rsGameIds[rsKey] || null;
          const rsSport   = rsGameSports[rsKey] || sport.rsKey;

          const bms = game.bookmakers || [];
          const fd  = bms.find(b => b.key === 'fanduel') || bms.find(b => b.key === 'draftkings');
          if (!fd) continue;

          // ML only for Odds API sports
          const h2hMkt = (fd.markets || []).find(m => m.key === 'h2h');
          if (!h2hMkt) continue;

          const rsMktLabel = RS_ML_LABELS.find(l => rsMarkets[l]);
          if (!rsMktLabel) continue;

          const rsMkt      = rsMarkets[rsMktLabel];
          const gameUrl    = buildRSUrl(gameId, rsSport, rsMkt.id);
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

            const ev = calcEV(fdFair, rsO.probability);
            if (ev == null || ev < posterMinEv || ev > 200) continue;
            const u = unitsEV(ev, fdFair);
            if (u <= 0) continue;

            allBets.push({
              sport, game: gameKey, market: 'ML', side: fdO.name,
              ev: Math.round(ev * 10) / 10, units: u, fdOdds: fdO.price, pt: null,
              rsPct: Math.round(rsO.probability * 1000) / 10,
              adjFairPct: Math.round(fdFair * 1000) / 10,
              gameUrl, commenceTime, rsGameId: gameId, rsSport,
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
          const { games: rsGamesRfi, gameIds: rsGameIdsRfi, gameSports: rsGameSportsRfi, gameStartMs: rsRfiStartMs } =
            await loadRSCache('mlb', env, now, RS_STALE_THRESHOLD);

          const mlbSport = NATIVE_SPORTS.find(s => s.fdKey === 'baseball_mlb');
          const usedRsKeys = new Set(); // dedup: one FD event per RS game (blocks phantom DH entries)

          for (const [rfiGameKey, rfi] of Object.entries(rfiMap)) {
            const parts = rfiGameKey.split(' @ ');
            if (parts.length !== 2) continue;
            // Strip "(Game X)" from home team so DH2 resolution works correctly
            const rfiHome = parts[1].replace(/\s*\(Game \d+\)$/i, '');
            const rsKey = findRSGameKey(parts[0], rfiHome, rsGamesRfi, rfiGameKey);
            if (!rsKey) continue;
            // If multiple FD events map to the same RS game (phantom/cancelled DH),
            // only use the first match — later entries are stale duplicates.
            if (usedRsKeys.has(rsKey)) continue;
            usedRsKeys.add(rsKey);
            rfiDbg.rsMatchCount++;

            const rfiMkt = rsGamesRfi[rsKey]?.['Run in 1st inning?'];
            if (!rfiMkt) continue;
            rfiDbg.rfiMktCount++;

            const rsOutcomes = rfiMkt.outcomes || [];
            const rsVolume   = rfiMkt.volume ?? 0;
            const rsYes = rsOutcomes.find(o => /yrfi/i.test(o.label));
            const rsNo  = rsOutcomes.find(o => /nrfi/i.test(o.label));

            // Skip if market is already settled — isWinner being set means the 1st inning is done
            if (rsYes?.isWinner != null || rsNo?.isWinner != null) continue;

            const gameId  = rsGameIdsRfi[rsKey] || null;
            const rsSport = rsGameSportsRfi[rsKey] || 'mlb';
            const gameUrl = buildRSUrl(gameId, rsSport, rfiMkt.id);

            const rfiCommence = rfi.cm || 0;
            const rfiIsLive   = rfiCommence > 0 && rfiCommence <= now;
            // RFI is a pre-game market — skip if game has started per FD commence time
            if (rfiIsLive) continue;
            // Secondary guard: skip if RS reports the game has already started
            // (catches phantom DH events with future FD openDate that match a live RS game)
            const rsStartMs = rsRfiStartMs[rsKey];
            if (rsStartMs && rsStartMs <= now * 1000) continue;

            for (const { side, fdFair, fdOdds, rsO } of [
              { side: 'Yes (YRFI)', fdFair: rfi.yesFair, fdOdds: rfi.yesAm, rsO: rsYes },
              { side: 'No (NRFI)',  fdFair: rfi.noFair,  fdOdds: rfi.noAm,  rsO: rsNo  },
            ]) {
              if (!rsO || !rsO.probability) continue;
              const ev = calcEV(fdFair, rsO.probability);
              if (ev == null || ev < posterMinEv || ev > 200) continue;
              const u = unitsEV(ev, fdFair);
              if (u <= 0) continue;
              allBets.push({
                sport: mlbSport, game: rfiGameKey, market: 'RFI', side,
                ev: Math.round(ev * 10) / 10, units: u, fdOdds, pt: null,
                rsPct: Math.round(rsO.probability * 1000) / 10,
                adjFairPct: Math.round(fdFair * 1000) / 10,
                gameUrl, commenceTime: rfiCommence, isLive: false, rsGameId: gameId, rsSport,
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

    // Write full bet list for Mac EV group poster
    try {
      await env.DB.prepare(
        'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
      ).bind('ev_bets_latest', JSON.stringify({
        ts: now,
        bets: allBets.slice(0, 100).map(b => ({
          sport: b.sport.label, game: b.game, market: b.market, side: b.side,
          ev: b.ev, units: b.units, pt: b.pt, fdOdds: b.fdOdds,
          rsPct: b.rsPct, adjFairPct: b.adjFairPct,
          gameUrl: b.gameUrl, betKey: b.betKey, isLive: b.isLive || false,
          commenceTime: b.commenceTime || 0,
          rsGameId: b.rsGameId || null, rsSport: b.rsSport || null,
        }))
      }), now).run();
    } catch(e) {}

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
        b.ev >= minEv && !b.isLive && (!userSports || userSports.has(b.sport.fdKey))
      );
      if (!dbg.userBets) dbg.userBets = {};
      dbg.userBets[user.user_id] = { minEv, betsAfterFilter: userBets.length };

      // Skip bets marked taken within the last 2 hours unless EV jumped to a higher bracket.
      // After 2 hours, treat as normal (RESEND_AFTER_SECS handles re-alert frequency).
      // Live games bypass this entirely — EV changes with game state and the user may want to add.
      const TAKEN_SUPPRESS_SECS = 2 * 3600;
      try {
        const takenRows = await env.DB.prepare(
          'SELECT game, market, MAX(ev) as taken_ev, MAX(sent_at) as last_sent FROM alert_messages WHERE user_id=? AND taken=1 AND sent_at>=? GROUP BY game, market'
        ).bind(user.user_id, now - TAKEN_SUPPRESS_SECS).all();
        if (takenRows.results?.length) {
          const evBracket = ev => ev >= 35 ? 3 : ev >= 20 ? 2 : ev >= 10 ? 1 : 0;
          const takenMap = new Map((takenRows.results || []).map(r => [r.game + '|' + r.market, r.taken_ev]));
          userBets = userBets.filter(b => {
            if (b.isLive) return true; // live games always re-alert regardless of taken status
            const takenEv = takenMap.get(b.game + '|' + b.market);
            if (takenEv === undefined) return true;
            return evBracket(b.ev) > evBracket(takenEv);
          });
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
          // Live game, last alert was pre-game → fire one re-alert at game start
          // After that, entry.sentAt >= commenceTime so the 4% jump rule resumes
          const wasAlertedPreGame = bet.isLive && bet.commenceTime && entry.sentAt < bet.commenceTime;
          const isStale = (now - entry.sentAt) >= RESEND_AFTER_SECS;
          const evChanged = Math.abs(bet.ev - entry.ev) >= RE_ALERT_EV_JUMP;
          if (!wasAlertedPreGame && !isStale && !evChanged) { dbg.suppressedCount++; continue; }
        }

        const dollarAmt = Math.round(bet.units * unitSize);
        const message   = formatAlert(bet.sport, bet.game, bet.market, bet.side, bet.ev, bet.units, dollarAmt, bet.pt, bet.rsPct, bet.adjFairPct, bet.gameUrl, bet.isLive);

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
        if (msgId) {
          dbg.sentCount++;
          if (alertRowId) {
            try {
              await env.DB.prepare('UPDATE alert_messages SET msg_id=? WHERE id=?').bind(msgId, alertRowId).run();
            } catch(e) {}
          }
          // Only log after confirmed send — prevents suppressing bets on future runs when Telegram failed
          try {
            await env.DB.prepare(
              `INSERT INTO alert_sent_log (user_id, bet_key, last_ev, sent_at) VALUES (?,?,?,?)
               ON CONFLICT(user_id, bet_key) DO UPDATE SET last_ev=excluded.last_ev, sent_at=excluded.sent_at`
            ).bind(user.user_id, bet.betKey, bet.ev, now).run();
          } catch(e) {}
        } else {
          dbg.failedSends++;
        }

        await new Promise(r => setTimeout(r, 50));
      }
    }

    // ── 5. Cleanup + debug write ───────────────────────────

    await writeDebug(env, dbg);

    // Reset alert_sent_log at midnight ET — entries from before today are cleared so
    // each new calendar day gets fresh alerts (same game in a series re-alerts correctly)
    try {
      await env.DB.prepare('DELETE FROM alert_sent_log WHERE sent_at < ?')
        .bind(midnightET).run();
    } catch(e) {}

    try {
      await env.DB.prepare('DELETE FROM telegram_verify_tokens WHERE expires_at < ?')
        .bind(now).run();
    } catch(e) {}

    try {
      await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?')
        .bind(now - 86400).run();
    } catch(e) {}
}

// ── Export: HTTP fetch (Telegram callback + /trigger) + scheduled ─────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Manual trigger — VPS watchdog calls this if CF scheduler goes silent
    if (url.pathname === '/trigger') {
      const key = url.searchParams.get('_key');
      if (!env.EV_POSTER_KEY || key !== env.EV_POSTER_KEY)
        return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      ctx.waitUntil(runCron(env, ctx));
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.method !== 'POST') return new Response('ok');
    const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET)
      return new Response('Forbidden', { status: 403 });
    const body = await request.json().catch(() => null);
    if (!body?.callback_query) return new Response('ok');
    const { id: queryId, data, message } = body.callback_query;
    const chatId    = message?.chat?.id;
    const messageId = message?.message_id;
    let nowTaken = false;
    if (data?.startsWith('t:')) {
      const alertId = parseInt(data.slice(2));
      if (alertId) {
        try {
          const row = await env.DB.prepare('SELECT taken FROM alert_messages WHERE id=?').bind(alertId).first();
          nowTaken = !row?.taken;
          await env.DB.prepare('UPDATE alert_messages SET taken=? WHERE id=?').bind(nowTaken ? 1 : 0, alertId).run();
        } catch(e) {}
      }
    }
    const base = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
    await fetch(`${base}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: queryId, text: nowTaken ? '✅ Bet marked as taken' : 'Bet unmarked' }),
    }).catch(() => {});
    if (chatId && messageId) {
      const buttonText = nowTaken ? '✅ Bet Taken' : 'Mark Bet Taken';
      await fetch(`${base}/editMessageReplyMarkup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [[{ text: buttonText, callback_data: data }]] },
        }),
      }).catch(() => {});
    }
    return new Response('ok');
  },

  async scheduled(event, env, ctx) {
    return runCron(env, ctx);
  },
};

async function writeDebug(env, dbg) {
  try {
    await env.DB.prepare(
      'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
    ).bind('cron_debug', JSON.stringify(dbg), dbg.ts).run();
  } catch(e) {}
}
