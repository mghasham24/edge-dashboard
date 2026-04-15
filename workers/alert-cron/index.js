// workers/alert-cron/index.js
// Runs every 60 seconds via Cloudflare Cron Trigger.
// For each pro user with Telegram verified:
//   1. Fetch FD odds + RS fair probabilities from D1 cache (or live if stale)
//   2. Calculate EV for each pre-game bet
//   3. Alert if EV >= user threshold and bet not already sent
//   4. Re-alert if EV jumped +4% since last message (new unit tier)

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

// EV% — FD no-vig is the "true" probability baseline; RS is the betting market.
// Positive EV when RS crowd undervalues a side (rsImpliedProb < fdNoVigProb).
// Formula: EV = (fdNoVigProb / rsImpliedProb - 1) * 100
function calcEV(fdNoVigProb, rsImpliedProb) {
  if (!fdNoVigProb || !rsImpliedProb || rsImpliedProb <= 0) return null;
  return (fdNoVigProb / rsImpliedProb - 1) * 100;
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

const SPORTS = [
  { fdKey: 'basketball_nba',        rsKey: 'nba',    label: 'NBA'  },
  { fdKey: 'icehockey_nhl',         rsKey: 'nhl',    label: 'NHL'  },
  { fdKey: 'baseball_mlb',          rsKey: 'mlb',    label: 'MLB'  },
  { fdKey: 'basketball_ncaab',      rsKey: 'cbb',    label: 'NCAAB'},
  { fdKey: 'mma_mixed_martial_arts',rsKey: 'ufc',    label: 'UFC'  },
  { fdKey: 'soccer_fc',             rsKey: 'soccer', label: 'FC'   },
];

// Market label mapping between FD API key and RS label
// Each entry is an array of possible RS labels to try in order
const FD_MKT_TO_RS = {
  h2h:     ['Moneyline', 'Game Winner'],
  spreads: ['Spread', 'Puck Line', 'Run Line'],
  totals:  ['Total', 'Total Runs', 'Total Goals'],
};
const FD_MKT_TO_DISPLAY = { h2h: 'ML', spreads: 'Spread', totals: 'Total' };

// ── Odds API fetch ─────────────────────────────────────

async function fetchFDOdds(sport, apiKey) {
  const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${apiKey}&regions=us&markets=h2h,spreads,totals&bookmakers=fanduel&oddsFormat=american`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const games = await res.json();
  if (!Array.isArray(games)) return null;
  return games;
}

// ── Real Sports RS data from D1 cache ─────────────────

function parseRSCache(cacheData) {
  // cacheData is the marketMap stored by real/sync.js
  // Structure: { "Away @ Home": { "Moneyline": { outcomes: [{label, probability}] }, ... }, "Away @ Home__gid": 123, ... }
  const games = {};
  const gameIds = {};
  const gameSports = {};
  if (!cacheData || typeof cacheData !== 'object') return { games, gameIds, gameSports };
  for (const [key, val] of Object.entries(cacheData)) {
    if (key.endsWith('__gid'))   { gameIds[key.slice(0, -5)] = val; continue; }
    if (key.endsWith('__sport')) { gameSports[key.slice(0, -7)] = val; continue; }
    if (key.endsWith('__lines')) continue;
    if (val && typeof val === 'object' &&
        (val['Moneyline'] || val['Game Winner'] || val['Spread'] || val['Total'] || val['Total Runs'] || val['Total Goals'] || val['Run in 1st inning?'])) {
      games[key] = val;
    }
  }
  return { games, gameIds, gameSports };
}

// ── Game key normalization for matching ───────────────

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

// Try to find a matching RS game key for a given FD game
function findRSGameKey(fdAway, fdHome, rsGames) {
  // Direct match first
  const directKey = fdAway + ' @ ' + fdHome;
  if (rsGames[directKey]) return directKey;

  // Normalize and find closest match
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

// ── Telegram send ──────────────────────────────────────

// Returns the sent message_id (needed to edit the message later)
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
  const evStr     = (ev >= 0 ? '+' : '') + ev.toFixed(1) + '% EV';
  const unitStr   = units + 'u (' + dollarAmt + ' Rax)';
  const ptStr     = pt != null ? ' ' + (pt > 0 ? '+' : '') + pt : '';
  const lineStr   = market === 'ML' ? side : side + ptStr;
  const rsPctStr  = rsPct != null ? rsPct.toFixed(1) + '% RS' : '';
  const adjStr    = adjFairPct != null ? adjFairPct.toFixed(1) + '% Fair' : '';
  const statsStr  = [rsPctStr, adjStr].filter(Boolean).join(' · ');
  const teams     = game.split(' @ ');
  const shortGame = (teams[0] || game) + ' @ ' + (teams[1] || '');
  const linkLine  = gameUrl ? `\n<a href="${gameUrl}">View on Real Sports ↗</a>` : '';

  return (
    `🔔 <b>RaxEdge Alert</b>\n\n` +
    `<b>${lineStr}</b> · ${market} · ${sport.label}\n` +
    `${evStr} · ${unitStr}\n` +
    (statsStr ? statsStr + '\n' : '') +
    `\n<i>${shortGame}</i>${linkLine}`
  );
}

// ── Main scheduled handler ─────────────────────────────

export default {
  async scheduled(event, env, ctx) {
    if (!env.TELEGRAM_BOT_TOKEN) return;
    if (!env.ODDS_API_KEY) return;

    const now = Math.floor(Date.now() / 1000);
    const FD_STALE_THRESHOLD = 5 * 60;   // 5 minutes — FD odds change fast
    const RS_STALE_THRESHOLD = 30 * 60;  // 30 minutes — RS fair value changes slowly
    const RE_ALERT_EV_JUMP = 4.0;

    // 1. Load all verified, enabled users
    const users = await env.DB.prepare(
      `SELECT ns.user_id, ns.telegram_chat_id, ns.min_ev, ns.sports, ns.one_side, ns.unit_size
       FROM notification_settings ns
       JOIN users u ON u.id = ns.user_id
       WHERE ns.telegram_verified=1 AND ns.enabled=1 AND (u.plan='pro' OR u.is_admin=1)`
    ).all();

    if (!users.results || !users.results.length) return;

    // 2. Determine which sports are needed (union across all user prefs)
    const sportsNeeded = new Set();
    for (const user of users.results) {
      if (!user.sports || user.sports === 'ALL') {
        SPORTS.forEach(s => sportsNeeded.add(s.fdKey));
      } else {
        user.sports.split(',').forEach(s => sportsNeeded.add(s.trim()));
      }
    }

    // 3. For each needed sport, collect bets above the global minimum EV threshold
    const globalMinEv = Math.min(...users.results.map(u => u.min_ev || 5));

    // allBets: array of { sport, sportLabel, game, market, side, ev, units, fdOdds, pt, commenceTime, betKey }
    const allBets = [];

    for (const sport of SPORTS) {
      if (!sportsNeeded.has(sport.fdKey)) continue;

      // Load FD odds from D1 cache — try any key for this sport
      let fdGames = null;
      try {
        const cached = await env.DB.prepare(
          `SELECT data, fetched_at FROM odds_cache WHERE cache_key LIKE ? ORDER BY fetched_at DESC LIMIT 1`
        ).bind('odds_' + sport.fdKey + '_%').first();

        if (cached && (now - cached.fetched_at) < FD_STALE_THRESHOLD) {
          fdGames = JSON.parse(cached.data);
        }
      } catch(e) {}

      // Cache stale or empty — fetch fresh from Odds API
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

      // Load RS fair probabilities from D1 cache
      let rsGames = {}, rsGameIds = {}, rsGameSports = {};
      try {
        const rsCached = await env.DB.prepare(
          'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
        ).bind('real_sync_' + sport.rsKey + '_v5').first();

        if (rsCached && (now - rsCached.fetched_at) < RS_STALE_THRESHOLD) {
          const parsed = parseRSCache(JSON.parse(rsCached.data));
          rsGames = parsed.games;
          rsGameIds = parsed.gameIds;
          rsGameSports = parsed.gameSports;
        }
      } catch(e) {}

      // No RS data available for this sport — skip (can't calculate EV without fair value)
      if (!Object.keys(rsGames).length) continue;

      // Process each FD game
      for (const game of fdGames) {
        const commenceTime = game.commence_time
          ? Math.floor(new Date(game.commence_time).getTime() / 1000)
          : 0;

        // Pre-game only: skip if game has already started
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

        // Get FD bookmaker data
        const fd = (game.bookmakers || []).find(b => b.key === 'fanduel' || b.key === 'draftkings');
        if (!fd) continue;

        for (const fdMkt of (fd.markets || [])) {
          const rsMktLabels = FD_MKT_TO_RS[fdMkt.key];
          const displayMkt  = FD_MKT_TO_DISPLAY[fdMkt.key];
          if (!rsMktLabels) continue;
          // Try each possible RS label in order until one matches
          const rsMktLabel = rsMktLabels.find(l => rsMarkets[l]);
          if (!rsMktLabel) continue;

          const rsOutcomes = rsMarkets[rsMktLabel].outcomes || [];
          const fdOutcomes = fdMkt.outcomes || [];
          if (fdOutcomes.length < 2) continue;

          // Calculate no-vig fair probability from FD odds (for 2-way markets)
          const noVig = fdOutcomes.length === 2
            ? noVigFair(fdOutcomes[0].price, fdOutcomes[1].price)
            : null;

          for (const fdO of fdOutcomes) {
            // Find matching RS outcome by normalized label
            const nFdName = normName(fdO.name);
            const rsO = rsOutcomes.find(o => {
              const nRsLabel = normName(o.label);
              return nRsLabel.includes(nFdName) || nFdName.includes(nRsLabel);
            });
            if (!rsO || !rsO.probability) continue;

            // FD no-vig probability for this side (our "true" probability baseline)
            const isFirstOutcome = fdOutcomes[0].name === fdO.name;
            const fdNoVigProb = noVig ? (isFirstOutcome ? noVig.fa : noVig.fb) : null;
            if (!fdNoVigProb) continue; // need both sides for no-vig calc

            // EV = (FD no-vig prob / RS implied prob) - 1
            // Positive when RS crowd undervalues this side vs the sharp market
            const ev = calcEV(fdNoVigProb, rsO.probability);
            if (ev == null || ev < globalMinEv) continue;

            const u = unitsEV(ev, fdNoVigProb);
            if (u <= 0) continue;

            const adjFairPct = Math.round(fdNoVigProb * 1000) / 10; // already have it

            const pt = fdO.point !== undefined ? fdO.point : null;
            const betKey = `${sport.fdKey}|${gameKey}|${displayMkt}|${fdO.name}|${pt ?? ''}`;

            allBets.push({
              sport,
              game: gameKey,
              market: displayMkt,
              side: fdO.name,
              ev: Math.round(ev * 10) / 10,
              units: u,
              fdOdds: fdO.price,
              pt,
              rsPct: Math.round(rsO.probability * 1000) / 10,   // e.g. 57.3
              adjFairPct: adjFairPct != null ? Math.round(adjFairPct * 10) / 10 : null,
              gameUrl,
              commenceTime,
              betKey
            });
          }
        }
      }
    }

    // ── MLB RFI alerts (YRFI / NRFI) ─────────────────────
    // Uses FD native API cache (fd_rfi) + RS "Run in 1st inning?" probability
    if (sportsNeeded.has('baseball_mlb')) {
      try {
        const rfiCached = await env.DB.prepare(
          'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
        ).bind('fd_rfi').first();

        if (rfiCached && (now - rfiCached.fetched_at) < FD_STALE_THRESHOLD) {
          const rfiMap = JSON.parse(rfiCached.data).rfi || {};

          // Load MLB RS cache (may already be warm from the SPORTS loop above)
          let rsGamesRfi = {}, rsGameIdsRfi = {}, rsGameSportsRfi = {};
          try {
            const rsCached = await env.DB.prepare(
              'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
            ).bind('real_sync_mlb_v5').first();
            if (rsCached && (now - rsCached.fetched_at) < RS_STALE_THRESHOLD) {
              const parsed = parseRSCache(JSON.parse(rsCached.data));
              rsGamesRfi      = parsed.games;
              rsGameIdsRfi    = parsed.gameIds;
              rsGameSportsRfi = parsed.gameSports;
            }
          } catch(e) {}

          const mlbSport = SPORTS.find(s => s.fdKey === 'baseball_mlb');

          for (const [rfiGameKey, rfi] of Object.entries(rfiMap)) {
            const parts = rfiGameKey.split(' @ ');
            if (parts.length !== 2) continue;
            const rsKey = findRSGameKey(parts[0], parts[1], rsGamesRfi);
            if (!rsKey) continue;

            const rfiMkt = rsGamesRfi[rsKey]?.['Run in 1st inning?'];
            if (!rfiMkt) continue;

            const rsOutcomes = rfiMkt.outcomes || [];
            const rsYes = rsOutcomes.find(o => /yes/i.test(o.label));
            const rsNo  = rsOutcomes.find(o => /no/i.test(o.label));

            const gameId  = rsGameIdsRfi[rsKey] || null;
            const rsSport = rsGameSportsRfi[rsKey] || 'mlb';
            const gameUrl = buildRSUrl(gameId, rsSport);

            const rfiSides = [
              { side: 'Yes (YRFI)', fdFair: rfi.yesFair, fdOdds: rfi.yesAm, rsO: rsYes },
              { side: 'No (NRFI)',  fdFair: rfi.noFair,  fdOdds: rfi.noAm,  rsO: rsNo  },
            ];

            for (const { side, fdFair, fdOdds, rsO } of rfiSides) {
              if (!rsO || !rsO.probability) continue;

              const ev = calcEV(fdFair, rsO.probability);
              if (ev == null || ev < globalMinEv) continue;

              const u = unitsEV(ev, fdFair);
              if (u <= 0) continue;

              allBets.push({
                sport:        mlbSport,
                game:         rfiGameKey,
                market:       'RFI',
                side,
                ev:           Math.round(ev * 10) / 10,
                units:        u,
                fdOdds,
                pt:           null,
                rsPct:        Math.round(rsO.probability * 1000) / 10,
                adjFairPct:   Math.round(fdFair * 1000) / 10,
                gameUrl,
                commenceTime: 0, // FD native API only returns OPEN markets
                betKey:       `baseball_mlb|${rfiGameKey}|RFI|${side}|`,
              });
            }
          }
        }
      } catch(e) {}
    }

    if (!allBets.length) return;

    // 4. For each user, find their matching bets and send alerts
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

      // Skip any game+market the user already marked as taken
      try {
        const takenRows = await env.DB.prepare(
          'SELECT DISTINCT game, market FROM alert_messages WHERE user_id=? AND taken=1'
        ).bind(user.user_id).all();
        const takenKeys = new Set((takenRows.results || []).map(r => r.game + '|' + r.market));
        if (takenKeys.size) {
          userBets = userBets.filter(b => !takenKeys.has(b.game + '|' + b.market));
        }
      } catch(e) {}

      // 1 Side filter: per game+market, keep only the highest EV side
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

      // Batch-load existing alert log for this user
      const betKeys = userBets.map(b => b.betKey);
      const placeholders = betKeys.map(() => '?').join(',');
      let existingLog = {};
      try {
        const logRows = await env.DB.prepare(
          `SELECT bet_key, last_ev FROM alert_sent_log WHERE user_id=? AND bet_key IN (${placeholders})`
        ).bind(user.user_id, ...betKeys).all();
        for (const row of (logRows.results || [])) {
          existingLog[row.bet_key] = row.last_ev;
        }
      } catch(e) {}

      for (const bet of userBets) {
        const lastEv = existingLog[bet.betKey];

        // Skip if already sent — unless EV has jumped 4%+ since last alert
        if (lastEv !== undefined && bet.ev - lastEv < RE_ALERT_EV_JUMP) continue;

        const dollarAmt = Math.round(bet.units * unitSize);
        const message = formatAlert(bet.sport, bet.game, bet.market, bet.side, bet.ev, bet.units, dollarAmt, bet.pt, bet.rsPct, bet.adjFairPct, bet.gameUrl);

        // Insert alert_messages row first to get its ID for the callback button
        let alertRowId = null;
        try {
          const ins = await env.DB.prepare(
            `INSERT INTO alert_messages (user_id, chat_id, bet_key, sport, game, market, side, pt, ev, units, dollar_amt, sent_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(user.user_id, user.telegram_chat_id, bet.betKey, bet.sport.label, bet.game, bet.market, bet.side, bet.pt ?? null, bet.ev, bet.units, dollarAmt, now).run();
          alertRowId = ins.meta.last_row_id;
        } catch(e) {}

        const replyMarkup = alertRowId ? {
          inline_keyboard: [[
            { text: '✅ Mark Bet Taken', callback_data: 't:' + alertRowId }
          ]]
        } : undefined;

        const msgId = await sendTelegram(user.telegram_chat_id, message, env.TELEGRAM_BOT_TOKEN, replyMarkup);

        // Store telegram message_id so we can edit the button later
        if (msgId && alertRowId) {
          try {
            await env.DB.prepare('UPDATE alert_messages SET msg_id=? WHERE id=?').bind(msgId, alertRowId).run();
          } catch(e) {}
        }

        // Update alert log
        try {
          await env.DB.prepare(
            `INSERT INTO alert_sent_log (user_id, bet_key, last_ev, sent_at) VALUES (?,?,?,?)
             ON CONFLICT(user_id, bet_key) DO UPDATE SET last_ev=excluded.last_ev, sent_at=excluded.sent_at`
          ).bind(user.user_id, bet.betKey, bet.ev, now).run();
        } catch(e) {}

        // Small delay between messages to avoid Telegram rate limits (30 msg/sec global limit)
        await new Promise(r => setTimeout(r, 50));
      }
    }

    // 5. Cleanup: remove stale log entries (bets from > 36h ago — games are long over)
    try {
      await env.DB.prepare(
        'DELETE FROM alert_sent_log WHERE sent_at < ?'
      ).bind(now - 36 * 3600).run();
    } catch(e) {}

    // 6. Cleanup: remove expired verify tokens
    try {
      await env.DB.prepare(
        'DELETE FROM telegram_verify_tokens WHERE expires_at < ?'
      ).bind(now).run();
    } catch(e) {}
  }
};
