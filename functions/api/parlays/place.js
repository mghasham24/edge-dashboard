// functions/api/parlays/place.js
// POST /api/parlays/place
// Validates parlay slip, assigns deposit card, writes parlays + parlay_legs to D1.
// Returns deposit card URL and 30-min expiry window.
import { getSession }     from '../../_lib/session.js';
import { ok, err }        from '../../_lib/response.js';
import { rsUrlEncode, hashidsEncode } from '../../_lib/hashids.js';
import { checkRateLimit } from '../../_lib/rateLimit.js';

// ── RS Stat Tracker ───────────────────────────────────────────────────────────
// Fires once at placement for MLB player prop legs. Silent on failure.
const TRACKER_STAT_TYPE = { hits:9, total_bases:21, rbis:3, pitcher_ks:70, outs_ou:106, hrbi:33 };
const TRACKER_SITEKEY   = '0x4AAAAAADHHMQ4l_2uyXqiu';
const MLB_API           = 'https://statsapi.mlb.com/api/v1';
const RS_TRACKER_BASE   = 'https://web.realapp.com';
const RS_TRACKER_UUID   = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';

function trackerHeaders(authInfo, sessionToken, withBody = false) {
  const h = {
    'Accept': 'application/json', 'Origin': 'https://www.realapp.com',
    'Referer': 'https://www.realapp.com/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
    'real-auth-info': authInfo, 'real-session-token': sessionToken || '',
    'real-device-uuid': RS_TRACKER_UUID, 'real-device-type': 'desktop_web',
    'real-version': '36', 'real-request-token': hashidsEncode(Date.now()),
    'real-device-name': '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
  };
  if (withBody) h['Content-Type'] = 'application/json';
  return h;
}

async function solveTrackerTurnstile(capsolverKey) {
  const created = await fetch('https://api.capsolver.com/createTask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey: capsolverKey, task: { type: 'AntiTurnstileTaskProxyLess', websiteURL: 'https://www.realapp.com/', websiteKey: TRACKER_SITEKEY } }),
    signal: AbortSignal.timeout(10000),
  }).then(r => r.json());
  if (created.errorId !== 0 || !created.taskId) throw new Error('CapSolver create failed');
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const poll = await fetch('https://api.capsolver.com/getTaskResult', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: capsolverKey, taskId: created.taskId }),
      signal: AbortSignal.timeout(8000),
    }).then(r => r.json());
    if (poll.status === 'ready') return poll.solution.token;
    if (poll.status === 'failed') throw new Error('CapSolver solve failed');
  }
  throw new Error('CapSolver timeout');
}

async function createTrackerGroup(env, parlayId, legs) {
  try {
    const authInfo   = env.EDGEBOT_AUTH_INFO;
    const capKey     = env.CAPSOLVER_API_KEY;
    const sessionTok = env.EDGEBOT_SESSION_TOKEN || '';
    if (!authInfo || !capKey) return;

    // Only MLB player prop legs with a mappable stat type
    const mappable = legs.filter(l => TRACKER_STAT_TYPE[l.marketType] != null);
    if (!mappable.length) return;

    // Look up MLB player IDs in parallel
    const playerById = {};
    await Promise.all([...new Set(mappable.map(l => l.playerName))].map(async name => {
      try {
        const r = await fetch(`${MLB_API}/people/search?names=${encodeURIComponent(name)}&sportId=1&hydrate=currentTeam`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return;
        const people = (await r.json()).people || [];
        const match = people.find(p => p.active) || people[0];
        if (match?.id) playerById[name] = { id: match.id, name: match.fullName, teamId: match.currentTeam?.id };
      } catch(_) {}
    }));

    // Group legs by game_date, look up gamePks per date
    const dateTeams = {};
    for (const leg of mappable) {
      const p = playerById[leg.playerName];
      if (!p?.teamId) continue;
      const gd = leg.gameDate;
      if (!dateTeams[gd]) dateTeams[gd] = new Set();
      dateTeams[gd].add(p.teamId);
    }
    const gamePkByDateTeam = {};
    await Promise.all(Object.entries(dateTeams).map(async ([date, teamIds]) => {
      try {
        const r = await fetch(`${MLB_API}/schedule?date=${date}&sportId=1`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return;
        const games = (await r.json()).dates?.[0]?.games || [];
        for (const teamId of teamIds) {
          const g = games.find(g => g.teams?.home?.team?.id === teamId || g.teams?.away?.team?.id === teamId);
          if (g) gamePkByDateTeam[`${date}:${teamId}`] = g.gamePk;
        }
      } catch(_) {}
    }));

    // Build stat entries
    const stats = [];
    const seen  = new Set();
    for (const leg of mappable) {
      const p = playerById[leg.playerName];
      if (!p?.teamId) continue;
      const gamePk = gamePkByDateTeam[`${leg.gameDate}:${p.teamId}`];
      if (!gamePk) continue;
      const statType = TRACKER_STAT_TYPE[leg.marketType];
      const value    = parseFloat(leg.threshold);
      const type     = leg.direction === 'less' ? 'under' : 'over';
      const key      = `${p.id}_player_${statType}_${value}_${gamePk}`;
      if (seen.has(key)) continue;
      seen.add(key);
      stats.push({
        entityType: 'player', entityId: p.id, label: p.name,
        entity: { id: p.id, sport: 'mlb', name: p.name, key: `${p.id}_mlb`, gameId: gamePk },
        statType, value, type, gameId: gamePk, key,
        team: null, isMoneyline: false, isTeamSelection: false,
      });
    }
    if (!stats.length) return;

    // Use the game date of the first leg (RS tracker is per-day)
    const gameDate = mappable[0].gameDate;
    const turnstileToken = await solveTrackerTurnstile(capKey);

    const postRes = await fetch(`${RS_TRACKER_BASE}/stattrackergroups/mlb`, {
      method: 'POST',
      headers: { ...trackerHeaders(authInfo, sessionTok, true), 'real-turnstile-token': turnstileToken },
      body: JSON.stringify({ stats, notificationType: 'individual', day: gameDate }),
      signal: AbortSignal.timeout(15000),
    });
    if (!postRes.ok) return;

    const data    = await postRes.json().catch(() => ({}));
    const groupId = data.statTrackerGroup?.id;
    if (!groupId) return;

    const trackerUrl = 'https://www.realapp.com/' + rsUrlEncode(19, 0, 0, groupId);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      'INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES (?,?,?) ' +
      'ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at'
    ).bind(`meta:tracker_parlay_${parlayId}`, JSON.stringify({ url: trackerUrl }), now).run();
  } catch(_) { /* background — silent */ }
}

function generateShareToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

function impliedProb(odds) {
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

// Only assign cards reconcile-confirmed owned within the last 15 minutes.
// Reconcile runs every 2–5 min — this survives ~3–7 consecutive failures before blocking.
const VERIFY_MAX_AGE    = 15 * 60;
// card_inventory snapshot must be within 2 reconcile intervals to be trusted as a fallback.
const INVENTORY_MAX_AGE = 10 * 60;
const EDGEBOT_USER      = 'V3yGgkkJ';
const RS_DEVICE_UUID    = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';

// Read the shared RS auth token from D1 — refreshed every 30s, always fresh.
async function getSharedRsToken(env) {
  try {
    const row = await env.DB.prepare(
      "SELECT data FROM odds_cache WHERE cache_key='meta:rs_auth_token'"
    ).first();
    if (!row?.data) return null;
    const parsed = JSON.parse(row.data);
    return parsed.token || null;
  } catch { return null; }
}

// Real-time check via RS API — uses the always-fresh shared token, no session expiry risk.
// Returns true (edgebot owns it), false (someone else owns it), null (can't determine).
async function verifyLive(cardId, rsToken) {
  if (!rsToken) return null;
  try {
    const res = await fetch(`https://web.realapp.com/collectingcards/${cardId}`, {
      headers: {
        'Accept':           'application/json',
        'real-auth-info':   rsToken,
        'real-device-uuid': RS_DEVICE_UUID,
        'real-device-type': 'desktop_web',
        'real-version':     '36',
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

// Snapshot fallback — reads the full owned-card set written by card-reconcile every 5 min.
// Returns true/false/null (null = snapshot missing or too stale).
async function verifySnapshot(cardId, env, now) {
  try {
    const row = await env.DB.prepare(
      "SELECT data, fetched_at FROM odds_cache WHERE cache_key='card_inventory'"
    ).first();
    if (!row || (now - row.fetched_at) > INVENTORY_MAX_AGE) return null;
    const ids = JSON.parse(row.data);
    return Array.isArray(ids) && ids.includes(Number(cardId));
  } catch { return null; }
}

// Combined: real-time RS check first (always-fresh token), fall back to D1 snapshot.
// Returns true/false/null (null = neither source could determine ownership).
async function verifyEdgebotOwns(cardId, env, now, rsToken) {
  const live = await verifyLive(cardId, rsToken);
  if (live !== null) return live;
  return verifySnapshot(cardId, env, now);
}

// Pick a verified, unassigned card (up to 5 attempts).
// Each candidate is verified against RS in real-time before being assigned.
// Returns card_id or null when none are available.
async function pickCard(env, now) {
  const rsToken  = await getSharedRsToken(env); // fetch once, reuse across attempts
  const excluded = [];
  for (let i = 0; i < 5; i++) {
    const notIn = excluded.length
      ? ' AND card_id NOT IN (' + excluded.map(() => '?').join(',') + ')'
      : '';
    const row = await env.DB.prepare(
      'SELECT card_id FROM deposit_cards WHERE assigned_to_parlay_id IS NULL AND freed_at IS NULL AND verified_at > ?' +
      ' AND card_id NOT IN (SELECT card_id FROM casino_deposits WHERE status=\'pending\' AND card_id IS NOT NULL)' +
      notIn + ' ORDER BY verified_at DESC LIMIT 1'
    ).bind(now - VERIFY_MAX_AGE, ...excluded).first();
    if (!row) break;

    const owned = await verifyEdgebotOwns(row.card_id, env, now, rsToken);
    if (owned === false) {
      // Confirmed not owned by edgebot — remove ghost from pool and try next
      await env.DB.prepare('DELETE FROM deposit_cards WHERE card_id=?').bind(row.card_id).run();
      excluded.push(row.card_id);
      continue;
    }
    if (owned === null) {
      // Neither live check nor snapshot could verify — skip rather than risk a ghost
      excluded.push(row.card_id);
      continue;
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

export async function onRequestPost(ctx) {
  let creditConsumedForUserId = null;
  try {
    return await _place(ctx, (userId) => { creditConsumedForUserId = userId; });
  } catch (e) {
    // If the credit was consumed before the crash, restore it so the user doesn't lose it
    if (creditConsumedForUserId) {
      try {
        await ctx.env.DB.prepare(
          'UPDATE users SET free_play_credits=free_play_credits+1 WHERE id=?'
        ).bind(creditConsumedForUserId).run();
      } catch (_) {}
    }
    return new Response(JSON.stringify({ error: 'Server error: ' + e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function _place({ request, env, waitUntil }, onCreditConsumed) {
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

  const { legs, freePlay } = body;
  let { stake } = body;

  const isFreePlay = freePlay === true;

  if (isFreePlay) {
    // Verify and atomically consume one free play credit
    const creditRes = await env.DB.prepare(
      'UPDATE users SET free_play_credits=free_play_credits-1 WHERE id=? AND free_play_credits>0'
    ).bind(user.id).run();
    if (creditRes.meta.changes === 0) return err('No free plays available', 400);
    onCreditConsumed(user.id); // register for rollback on crash
    stake = 100; // locked
  }

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

    const VALID_SPORTS = ['mlb', 'wnba', 'nfl', 'ufc', 'cfb'];
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
      'valkyries','fire','tempo', // 2026 expansion teams: GS Valkyries, Portland Fire, Toronto Tempo
    ]);
    // soccer_* slugs (e.g. soccer_eng.1) pass through as-is — not in VALID_SPORTS list.
    // cfb_* market types (e.g. cfb_pass_yds) pass through directly.
    let legSport = (leg.sport && leg.sport.startsWith('soccer_')) ? leg.sport
      : VALID_SPORTS.includes(leg.sport) ? leg.sport : 'mlb';
    // CFB: trust sport field directly — can't enumerate 130+ team nicknames, and cfb_ market prefix confirms props.
    if (leg.sport === 'cfb' || (leg.marketType && leg.marketType.startsWith('cfb_'))) {
      legSport = 'cfb';
    } else if (TEAM_MARKETS.has(leg.marketType)) {
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
    if (!group || group === 'batter') continue; // batter same-game correlation allowed
    const gameKey = l.eventName || l.eventId;
    const scopeKey = group === 'bball_player' ? (l.playerName || gameKey) : gameKey;
    const key = group + ':' + scopeKey;
    groupGameCounts[key] = (groupGameCounts[key] || 0) + 1;
    if (groupGameCounts[key] > 1) {
      const label = group === 'pitcher' ? 'pitcher' : 'player';
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
  // 1inn_runs_ou Under + 1inn_runs_exact Exactly 0 (same game): both require NRFI — correlated.
  // Also: two 1inn_runs_exact Exactly 0 from same game are correlated (both teams scoring 0 = NRFI).
  const inn1RunsExactZeroEids = new Set(
    normalized
      .filter(l => l.marketType === '1inn_runs_exact' && (l.threshold === 0 || l.threshold === '0'))
      .map(l => l.eventName || l.eventId)
      .filter(Boolean)
  );
  const inn1RunsOuUnderEids = new Set(
    normalized
      .filter(l => l.marketType === '1inn_runs_ou' && l.direction === 'less')
      .map(l => l.eventName || l.eventId)
      .filter(Boolean)
  );
  for (const eid of inn1RunsExactZeroEids) {
    if (inn1RunsOuUnderEids.has(eid))
      return err('Cannot combine 1st inning Runs Under with Exactly 0 runs for the same game — picks are correlated (both require NRFI).', 400);
  }
  // Count Exactly 0 legs per game — two from same game is NRFI expressed twice
  const inn1ExactZeroCounts = {};
  for (const l of normalized) {
    if (l.marketType !== '1inn_runs_exact') continue;
    if (l.threshold !== 0 && l.threshold !== '0') continue;
    const eid = l.eventName || l.eventId;
    if (!eid) continue;
    inn1ExactZeroCounts[eid] = (inn1ExactZeroCounts[eid] || 0) + 1;
    if (inn1ExactZeroCounts[eid] > 1)
      return err('Cannot combine Exactly 0 runs for multiple teams in the same game — picks are correlated (both require NRFI).', 400);
  }

  // 1inn_run_yn "No Score" correlation rules.
  // Rule A: Two "No Score" legs from the same game = NRFI expressed twice (both teams can't score = Under 0.5 total).
  // Rule B: "No Score" leg + 1inn_runs_ou Under from same game = correlated (Under 0.5 means neither team scores).
  const inn1RunYnNoByGame = {};
  for (const l of normalized) {
    if (l.marketType !== '1inn_run_yn') continue;
    const isNo = l.label && l.label.trim().toLowerCase() === 'no';
    if (!isNo) continue;
    const eid = l.eventName || l.eventId;
    if (!eid) continue;
    inn1RunYnNoByGame[eid] = (inn1RunYnNoByGame[eid] || 0) + 1;
    if (inn1RunYnNoByGame[eid] > 1)
      return err('Cannot combine multiple "No Score" picks from the same game — picks are correlated (both teams not scoring = NRFI).', 400);
  }
  for (const eid of Object.keys(inn1RunYnNoByGame)) {
    if (inn1RunsOuUnderEids.has(eid))
      return err('Cannot combine a "No Score" pick with 1st inning Runs Under from the same game — picks are correlated (Under 0.5 means neither team can score).', 400);
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
  // RS takes 10% commission on deposit, so effective stake = stake * 0.9.
  // Hard cap: 20,000 Rax. Max stake formula ensures payout never exceeds 20k.
  // Parlays over 2.5x are docked 10 Rax to cover deposit card acquisition cost.
  const trueProb      = normalized.reduce((acc, l) => acc * l.impliedProb, 1);
  const effectiveStake = Math.floor(stake * 0.9);
  const rawPayout = Math.min(Math.floor(effectiveStake * 0.70 / trueProb), 20000);
  let payoutRax = Math.floor((rawPayout + 2) / 10) * 10;
  if (0.70 / trueProb > 2.5) payoutRax = Math.max(0, payoutRax - 10);
  if (isFreePlay) payoutRax = Math.min(payoutRax, 3000);

  // Daily caps (admins bypass)
  if (!isAdmin) {
    const todayStart = etTodayStart();
    const exposureRow = await env.DB.prepare(
      "SELECT COALESCE(SUM(CASE WHEN status='won' THEN payout_rax ELSE -stake_rax END),0) AS net_loss " +
      "FROM parlays WHERE created_at >= ? AND status IN ('won','lost')"
    ).bind(todayStart).first();

    if ((exposureRow?.net_loss || 0) >= 200000) {
      return err('Parlays are temporarily unavailable — daily limit reached. Try again tomorrow.', 503);
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

  // Derive parlay-level sport from legs (use most common, or first)
  const sportCounts = {};
  for (const l of normalized) { sportCounts[l.sport] = (sportCounts[l.sport] || 0) + 1; }
  const parlayS = Object.entries(sportCounts).sort((a, b) => b[1] - a[1])[0][0];

  // Free play path: no card deposit, goes straight to active
  if (isFreePlay) {
    const fpRes = await env.DB.prepare(
      'INSERT INTO parlays (user_id, sport, legs_count, stake_rax, true_prob, payout_rax, ' +
      'rs_username, is_free_play, status, received_rax, expires_at, deposited_at, created_at, share_token) ' +
      "VALUES (?, ?, ?, 100, ?, ?, ?, 1, 'active', 0, 0, ?, ?, ?)"
    ).bind(user.id, parlayS, normalized.length, trueProb, payoutRax, user.rs_username, now, now, generateShareToken()).run();
    const fpId = fpRes.meta.last_row_id;
    if (waitUntil) waitUntil(createTrackerGroup(env, fpId, normalized));
    return placeLegsAndRespond(env.DB, fpId, null, normalized, 100, payoutRax, null, user.rs_username, now, true);
  }

  const cardId = await pickCard(env, now);
  if (!cardId) return err('No deposit cards available — contact support', 503);
  const expiresAt = now + 30 * 60;

  // Insert parlay row
  const parlayRes = await env.DB.prepare(
    'INSERT INTO parlays (user_id, sport, legs_count, stake_rax, true_prob, payout_rax, ' +
    'deposit_card_id, rs_username, expires_at, created_at, share_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    user.id, parlayS, normalized.length, stake,
    trueProb, payoutRax, cardId, user.rs_username, expiresAt, now, generateShareToken()
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
      'deposit_card_id, rs_username, expires_at, created_at, share_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      user.id, parlayS, normalized.length, stake,
      trueProb, payoutRax, retryCardId, user.rs_username, expiresAt, now, generateShareToken()
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

    if (waitUntil) waitUntil(createTrackerGroup(env, newParlayId, normalized));
    return placeLegsAndRespond(env.DB, newParlayId, retryCardId, normalized, stake, payoutRax, expiresAt, user.rs_username, now, false);
  }

  if (waitUntil) waitUntil(createTrackerGroup(env, parlayId, normalized));
  return placeLegsAndRespond(env.DB, parlayId, cardId, normalized, stake, payoutRax, expiresAt, user.rs_username, now, false);
}

async function placeLegsAndRespond(db, parlayId, cardId, legs, stake, payoutRax, expiresAt, rsUsername, now, isFreePlay = false) {
  await db.batch(legs.map(leg =>
    db.prepare(
      'INSERT INTO parlay_legs (parlay_id, sport, event_id, event_name, game_date, subcat_id, ' +
      'market_type, market_id, selection_id, player_name, label, threshold, direction, ' +
      'american_odds, implied_prob, headshot_url, game_start_ms, rs_game_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      parlayId, leg.sport,
      leg.eventId, leg.eventName, leg.gameDate, leg.subcatId,
      leg.marketType, leg.marketId, leg.selectionId, leg.playerName,
      leg.label, leg.threshold, leg.direction, leg.americanOdds, leg.impliedProb,
      leg.headshotUrl, leg.gameStartMs || null,
      leg.rsGameId || null
    )
  ));

  const mult = (0.70 / legs.reduce((a, l) => a * l.impliedProb, 1)).toFixed(2);

  if (isFreePlay) {
    return ok({
      parlayId,
      payoutRax,
      stake:      100,
      legs:       legs.length,
      multiplier: mult,
      rsUsername,
      freePlay:   true,
      active:     true,
    });
  }

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
