// functions/api/bets/settle.js
// POST /api/bets/settle — auto-settle pending bet_log entries using ESPN scores

const ESPN = {
  basketball_nba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=',
  icehockey_nhl:  'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=',
  baseball_mlb:   'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=',
};

function normLast(s) {
  return (s || '').toLowerCase().replace(/[^a-z ]/g, '').trim().split(' ').pop();
}

function dateStr(unixSec) {
  const d = new Date(unixSec * 1000);
  return d.getFullYear().toString()
    + String(d.getMonth() + 1).padStart(2, '0')
    + String(d.getDate()).padStart(2, '0');
}

async function fetchScores(espnUrl, dateKey) {
  try {
    const res = await fetch(espnUrl + dateKey, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.events || []).map(ev => {
      const comp = (ev.competitions || [])[0];
      if (!comp) return null;
      if (!comp.status?.type?.completed) return null;
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away) return null;
      return {
        homeName: home.team?.displayName || '',
        awayName: away.team?.displayName || '',
        homeScore: parseFloat(home.score) || 0,
        awayScore: parseFloat(away.score) || 0,
      };
    }).filter(Boolean);
  } catch { return []; }
}

function findGame(games, betGame) {
  const parts = betGame.split(' @ ');
  const awayLast = normLast(parts[0]);
  const homeLast  = normLast(parts[1]);
  return games.find(g =>
    normLast(g.homeName) === homeLast && normLast(g.awayName) === awayLast
  ) || null;
}

function determineResult(bet, g) {
  const mkt = bet.market.toLowerCase();
  const sideLow = (bet.side || '').toLowerCase();
  const homeLast = normLast(g.homeName);
  const awayLast = normLast(g.awayName);
  const betOnHome = normLast(bet.side) === homeLast || g.homeName.toLowerCase().includes(normLast(bet.side));
  const betOnAway = normLast(bet.side) === awayLast || g.awayName.toLowerCase().includes(normLast(bet.side));
  const margin = g.homeScore - g.awayScore; // positive = home wins

  if (mkt.startsWith('ml')) {
    if (betOnHome) return margin > 0 ? 'win' : margin < 0 ? 'loss' : 'push';
    if (betOnAway) return margin < 0 ? 'win' : margin > 0 ? 'loss' : 'push';
    return null;
  }

  if (mkt.startsWith('spread')) {
    const m = bet.market.match(/([+-]?\d+\.?\d*)/);
    if (!m) return null;
    const line = parseFloat(m[1]);
    const sideMargin = betOnHome ? margin : betOnAway ? -margin : null;
    if (sideMargin === null) return null;
    const covered = sideMargin + line;
    return covered > 0 ? 'win' : covered < 0 ? 'loss' : 'push';
  }

  if (mkt.startsWith('total') || mkt.startsWith('over') || mkt.startsWith('under')) {
    const m = bet.market.match(/(\d+\.?\d*)/);
    if (!m) return null;
    const line = parseFloat(m[1]);
    const total = g.homeScore + g.awayScore;
    const isOver = sideLow === 'over' || mkt.includes('over');
    const isUnder = sideLow === 'under' || mkt.includes('under');
    if (isOver)  return total > line ? 'win' : total < line ? 'loss' : 'push';
    if (isUnder) return total < line ? 'win' : total > line ? 'loss' : 'push';
    return null;
  }

  return null;
}

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Authentication required');

  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - 3 * 3600; // game must have started 3+ hours ago

  // Load pending bets with a known game_time that's old enough
  const { results: pending } = await env.DB.prepare(
    `SELECT id, game, market, side, sport, game_time
     FROM bet_log
     WHERE user_id=? AND result='pending' AND game_time IS NOT NULL AND game_time < ?`
  ).bind(session.user_id, cutoff).all();

  if (!pending.length) return json({ ok: true, settled: 0 });

  // Group by sport + date to minimize ESPN fetches
  const groups = {};
  for (const b of pending) {
    const espnUrl = ESPN[b.sport];
    if (!espnUrl) continue;
    const dk = dateStr(b.game_time);
    const key = b.sport + ':' + dk;
    if (!groups[key]) groups[key] = { espnUrl, dk, bets: [] };
    groups[key].bets.push(b);
  }

  let settled = 0;
  const updates = [];

  for (const { espnUrl, dk, bets } of Object.values(groups)) {
    const games = await fetchScores(espnUrl, dk);
    // Also check next day (late games can bleed past midnight ET)
    const nextDaySec = Math.min(...bets.map(b => b.game_time)) + 24 * 3600;
    const games2 = await fetchScores(espnUrl, dateStr(nextDaySec));
    const allGames = [...games, ...games2];

    for (const bet of bets) {
      const g = findGame(allGames, bet.game);
      if (!g) continue;
      const result = determineResult(bet, g);
      if (!result) continue;
      updates.push({ id: bet.id, result });
      settled++;
    }
  }

  // Batch update
  for (const { id, result } of updates) {
    await env.DB.prepare('UPDATE bet_log SET result=? WHERE id=? AND user_id=?')
      .bind(result, id, session.user_id).run();
  }

  return json({ ok: true, settled });
}

function getToken(req) {
  const c = req.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  return m ? m[1] : null;
}

async function getSession(request, db) {
  const token = getToken(request);
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    'SELECT u.id as user_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(token, now).first();
}

function json(data) {
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), { status, headers: { 'Content-Type': 'application/json' } });
}
