// functions/api/parlays/tracker-sync.js
// POST /api/parlays/tracker-sync?_cron_key=CRON_SECRET
// Syncs today's active parlay legs to the RS stat tracker.
// Called by alert-cron every 60s; exits immediately if all legs already tracked.
// Only calls CapSolver when new legs need to be added (first run after a new parlay).

import { ok, err }       from '../../_lib/response.js';
import { hashidsEncode } from '../../_lib/hashids.js';

const RS_DEVICE_UUID    = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';
const CAPSOLVER_SITEKEY = '0x4AAAAAADHHMQ4l_2uyXqiu';
const MLB_API           = 'https://statsapi.mlb.com/api/v1';

// Maps our market_type → RS statType integer
const STAT_TYPE = {
  hits:        9,
  total_bases: 21,
  rbis:        3,
  pitcher_ks:  70,
  outs_ou:     106,
  hrbi:        33,
};

function buildHeaders(authInfo, sessionToken, deviceUuid) {
  return {
    'Accept':             'application/json',
    'Content-Type':       'application/json',
    'Origin':             'https://www.realapp.com',
    'Referer':            'https://www.realapp.com/',
    'User-Agent':         'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
    'real-auth-info':     authInfo,
    'real-session-token': sessionToken,
    'real-device-uuid':   deviceUuid || RS_DEVICE_UUID,
    'real-device-type':   'desktop_web',
    'real-device-name':   '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
    'real-version':       '35',
    'real-request-token': hashidsEncode(Date.now()),
  };
}

async function solveTurnstile(capsolverKey) {
  const created = await fetch('https://api.capsolver.com/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: capsolverKey,
      task: { type: 'AntiTurnstileTaskProxyLess', websiteURL: 'https://www.realapp.com/', websiteKey: CAPSOLVER_SITEKEY },
    }),
    signal: AbortSignal.timeout(10000),
  }).then(r => r.json());

  if (created.errorId !== 0 || !created.taskId)
    throw new Error('CapSolver create failed: ' + (created.errorCode || 'unknown'));

  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const poll = await fetch('https://api.capsolver.com/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: capsolverKey, taskId: created.taskId }),
      signal: AbortSignal.timeout(8000),
    }).then(r => r.json());
    if (poll.status === 'ready')  return poll.solution.token;
    if (poll.status === 'failed') throw new Error('CapSolver solve failed');
  }
  throw new Error('CapSolver timeout after 15s');
}

// GET current RS tracker state — returns existing stat objects (for reuse in POST) and a key set
async function getTrackerState(authInfo, sessionToken, deviceUuid) {
  const res = await fetch('https://web.realapp.com/stattrackergroups/mlb', {
    headers: buildHeaders(authInfo, sessionToken, deviceUuid),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return { existingStats: [], existingKeys: new Set() };

  const data  = await res.json();
  const stats = data.statTrackerGroup?.stats || [];
  // Strip server-side fields — only keep what the POST body expects
  const existingStats = stats.map(s => ({
    entityType:      s.entityType,
    entityId:        s.entityId,
    label:           s.label || '',
    statType:        s.statType,
    value:           s.value,
    type:            s.type,
    gameId:          s.gameId,
    key:             s.key,
    team:            s.team       || null,
    isMoneyline:     s.isMoneyline     || false,
    isTeamSelection: s.isTeamSelection || false,
  }));
  return { existingStats, existingKeys: new Set(existingStats.map(s => s.key)) };
}

// Look up MLB player by name → {id, name, teamId}
async function searchMlbPlayer(name) {
  const res = await fetch(`${MLB_API}/people/search?names=${encodeURIComponent(name)}&sportId=1&hydrate=currentTeam`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const people = (await res.json()).people || [];
  const match  = people.find(p => p.active) || people[0];
  return match ? { id: match.id, name: match.fullName, teamId: match.currentTeam?.id } : null;
}

// Find the MLB gamePk for a team on a given date
async function getGamePkForTeam(date, teamId) {
  const res = await fetch(`${MLB_API}/schedule?date=${date}&sportId=1`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const games = (await res.json()).dates?.[0]?.games || [];
  return games.find(g =>
    g.teams?.home?.team?.id === teamId ||
    g.teams?.away?.team?.id === teamId
  )?.gamePk || null;
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  if (!env.CRON_SECRET || url.searchParams.get('_cron_key') !== env.CRON_SECRET)
    return err('Unauthorized', 401);

  // TEMPORARILY DISABLED — causing RS 500 errors on stattrackergroups endpoint
  return ok({ synced: 0, reason: 'disabled' });

  const capsolverKey = env.CAPSOLVER_API_KEY;
  if (!capsolverKey) return err('CAPSOLVER_API_KEY not configured', 500);

  const authInfo   = env.EDGEBOT_AUTH_INFO;
  const sessionToken = env.EDGEBOT_SESSION_TOKEN || '';
  const deviceUuid   = env.EDGEBOT_DEVICE_UUID   || RS_DEVICE_UUID;
  if (!authInfo) return err('EDGEBOT_AUTH_INFO env var not configured', 500);

  // Today in ET (matches game_date stored at bet placement time)
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const [m, d, y] = et.split('/');
  const today = `${y}-${m}-${d}`;

  // Load ALL active pending player prop legs (any game_date — handles late-night games past midnight ET)
  const { results: legs } = await env.DB.prepare(
    'SELECT DISTINCT pl.player_name, pl.market_type, pl.threshold, pl.direction, pl.game_date ' +
    'FROM parlay_legs pl JOIN parlays p ON p.id = pl.parlay_id ' +
    "WHERE p.status = 'active' AND pl.status = 'pending' " +
    "AND pl.market_type NOT LIKE 'team_%'"
  ).all();

  const debug = url.searchParams.has('debug');
  if (debug) return ok({ today, legs });

  if (!legs.length) return ok({ synced: 0, reason: 'no_pending_legs' });

  const mappable = legs.filter(l => STAT_TYPE[l.market_type] != null);
  if (!mappable.length) return ok({ synced: 0, reason: 'no_mappable_market_types' });

  // Group by game_date — each date gets its own RS tracker group
  const byDate = {};
  for (const leg of mappable) {
    const gd = leg.game_date || today;
    if (!byDate[gd]) byDate[gd] = [];
    byDate[gd].push(leg);
  }
  const dates = Object.keys(byDate);

  // Look up MLB IDs for all unique players (shared across all dates)
  const uniqueNames = [...new Set(mappable.map(l => l.player_name))];
  const playerById  = {};
  await Promise.all(uniqueNames.map(async name => {
    const player = await searchMlbPlayer(name).catch(() => null);
    if (player?.id) playerById[name] = player;
  }));

  // Process each game_date separately — RS tracker groups are per-day
  const results = [];
  let totalSynced = 0;

  for (const gameDate of dates) {
    const dateLegs = byDate[gameDate];

    // Look up gamePks for this date
    const gamePkByTeam = {};
    const teamIds = [...new Set(dateLegs.map(l => playerById[l.player_name]?.teamId).filter(Boolean))];
    await Promise.all(teamIds.map(async teamId => {
      const pk = await getGamePkForTeam(gameDate, teamId).catch(() => null);
      if (pk) gamePkByTeam[teamId] = pk;
    }));

    // Get current RS tracker state for this date
    const { existingStats, existingKeys } = await getTrackerState(authInfo, sessionToken, deviceUuid);

    // Build new stats for this date
    const newStats = [];
    for (const leg of dateLegs) {
      const player = playerById[leg.player_name];
      if (!player?.teamId) continue;
      const gamePk = gamePkByTeam[player.teamId];
      if (!gamePk) continue;

      const statType = STAT_TYPE[leg.market_type];
      const value    = parseFloat(leg.threshold);
      const type     = leg.direction === 'less' ? 'under' : 'over';
      const key      = `${player.id}_player_${statType}_${value}_${gamePk}`;

      if (existingKeys.has(key)) continue;

      newStats.push({
        entityType: 'player',
        entityId:   player.id,
        label:      player.name,
        entity:     { id: player.id, sport: 'mlb', name: player.name, key: `${player.id}_mlb`, gameId: gamePk },
        statType,
        value,
        type,
        gameId:          gamePk,
        key,
        team:            null,
        isMoneyline:     false,
        isTeamSelection: false,
      });
    }

    if (!newStats.length) {
      results.push({ date: gameDate, synced: 0, reason: 'all_already_tracked' });
      continue;
    }

    // Solve Turnstile for this date's POST
    let turnstileToken;
    try { turnstileToken = await solveTurnstile(capsolverKey); }
    catch (e) {
      results.push({ date: gameDate, synced: 0, reason: 'turnstile_failed', error: e.message });
      continue;
    }

    const allStats = [...existingStats, ...newStats];
    const postRes  = await fetch('https://web.realapp.com/stattrackergroups/mlb', {
      method:  'POST',
      headers: { ...buildHeaders(authInfo, sessionToken, deviceUuid), 'real-turnstile-token': turnstileToken },
      body:    JSON.stringify({ stats: allStats, notificationType: 'individual', day: gameDate }),
      signal:  AbortSignal.timeout(15000),
    });

    if (!postRes.ok) {
      const text = await postRes.text().catch(() => '');
      results.push({ date: gameDate, synced: 0, reason: 'post_failed', error: `${postRes.status}: ${text.slice(0, 200)}` });
      continue;
    }

    const data    = await postRes.json().catch(() => ({}));
    const groupId = data.statTrackerGroup?.id || null;

    if (groupId) {
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        "INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) " +
        "ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at"
      ).bind(`meta:tracker_group_${gameDate}`, String(groupId), now).run();
    }

    totalSynced += newStats.length;
    results.push({ date: gameDate, synced: newStats.length, groupId, added: newStats.map(s => `${s.label} ${s.type} ${s.value} stat:${s.statType}`) });
  }

  return ok({ synced: totalSynced, results });
}

export const onRequestGet = onRequestPost;
