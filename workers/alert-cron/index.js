// workers/alert-cron/index.js
// Runs every 60 seconds via Cloudflare Cron Trigger.
// For each pro user with Telegram verified:
//   1. Fetch FD odds + RS fair probabilities from D1 cache (or live if stale)
//   2. Calculate EV for each pre-game bet
//   3. Alert if EV >= user threshold and bet not already sent
//   4. Re-alert if EV jumped +4% since last message (new unit tier)

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

// EV% given RS fair probability and FD American odds for same side
function calcEV(rsFairProb, fdAmerican) {
  if (!rsFairProb || !fdAmerican) return null;
  const payout = fdAmerican > 0 ? fdAmerican / 100 : 100 / Math.abs(fdAmerican);
  return (rsFairProb * (1 + payout) - 1) * 100;
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
const FD_MKT_TO_RS = { h2h: 'Moneyline', spreads: 'Spread', totals: 'Total' };
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
  if (!cacheData || typeof cacheData !== 'object') return games;
  for (const [key, val] of Object.entries(cacheData)) {
    if (key.endsWith('__gid') || key.endsWith('__lines') || key.endsWith('__sport')) continue;
    if (val && typeof val === 'object' && (val['Moneyline'] || val['Spread'] || val['Total'])) {
      games[key] = val;
    }
  }
  return games;
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

async function sendTelegram(chatId, text, botToken) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
  } catch(e) {}
}

function formatAlert(sport, game, market, side, ev, units, fdOdds, pt) {
  const evStr    = (ev >= 0 ? '+' : '') + ev.toFixed(1) + '% EV';
  const unitStr  = units + 'u';
  const oddsStr  = fdOdds > 0 ? '+' + fdOdds : String(fdOdds);
  const ptStr    = pt != null ? ' ' + (pt > 0 ? '+' : '') + pt : '';
  const lineStr  = market === 'ML' ? side : side + ptStr;
  const teams    = game.split(' @ ');
  const shortGame = (teams[0] || game) + ' @ ' + (teams[1] || '');

  return (
    `🔔 <b>RaxEdge Alert</b>\n\n` +
    `<b>${lineStr}</b> · ${market} · ${sport.label}\n` +
    `${evStr} · ${unitStr}\n` +
    `FanDuel ${oddsStr}\n\n` +
    `<i>${shortGame}</i>`
  );
}

// ── Main scheduled handler ─────────────────────────────

export default {
  async scheduled(event, env, ctx) {
    if (!env.TELEGRAM_BOT_TOKEN) return;
    if (!env.ODDS_API_KEY) return;

    const now = Math.floor(Date.now() / 1000);
    const STALE_THRESHOLD = 5 * 60; // 5 minutes
    const RE_ALERT_EV_JUMP = 4.0;

    // 1. Load all verified, enabled users
    const users = await env.DB.prepare(
      `SELECT ns.user_id, ns.telegram_chat_id, ns.min_ev, ns.sports
       FROM notification_settings ns
       JOIN users u ON u.id = ns.user_id
       WHERE ns.telegram_verified=1 AND ns.enabled=1 AND u.plan='pro'`
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

        if (cached && (now - cached.fetched_at) < STALE_THRESHOLD) {
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
      let rsGames = {};
      try {
        const rsCached = await env.DB.prepare(
          'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
        ).bind('real_sync_' + sport.rsKey + '_v5').first();

        if (rsCached && (now - rsCached.fetched_at) < STALE_THRESHOLD) {
          rsGames = parseRSCache(JSON.parse(rsCached.data));
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

        // Get FD bookmaker data
        const fd = (game.bookmakers || []).find(b => b.key === 'fanduel' || b.key === 'draftkings');
        if (!fd) continue;

        for (const fdMkt of (fd.markets || [])) {
          const rsMktLabel = FD_MKT_TO_RS[fdMkt.key];
          const displayMkt = FD_MKT_TO_DISPLAY[fdMkt.key];
          if (!rsMktLabel || !rsMarkets[rsMktLabel]) continue;

          const rsOutcomes = rsMarkets[rsMktLabel].outcomes || [];
          const fdOutcomes = fdMkt.outcomes || [];
          if (fdOutcomes.length < 2) continue;

          for (const fdO of fdOutcomes) {
            // Find matching RS outcome by normalized label
            const nFdName = normName(fdO.name);
            const rsO = rsOutcomes.find(o => {
              const nRsLabel = normName(o.label);
              return nRsLabel.includes(nFdName) || nFdName.includes(nRsLabel);
            });
            if (!rsO || !rsO.probability) continue;

            const ev = calcEV(rsO.probability, fdO.price);
            if (ev == null || ev < globalMinEv) continue;

            const u  = unitsEV(ev, rsO.probability);
            if (u <= 0) continue;

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
              commenceTime,
              betKey
            });
          }
        }
      }
    }

    if (!allBets.length) return;

    // 4. For each user, find their matching bets and send alerts
    for (const user of users.results) {
      const userSports = (!user.sports || user.sports === 'ALL')
        ? null
        : new Set(user.sports.split(',').map(s => s.trim()));

      const minEv = user.min_ev || 5;

      const userBets = allBets.filter(b =>
        b.ev >= minEv && (!userSports || userSports.has(b.sport.fdKey))
      );

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

        const message = formatAlert(bet.sport, bet.game, bet.market, bet.side, bet.ev, bet.units, bet.fdOdds, bet.pt);
        await sendTelegram(user.telegram_chat_id, message, env.TELEGRAM_BOT_TOKEN);

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
