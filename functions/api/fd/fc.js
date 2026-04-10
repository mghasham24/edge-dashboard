// functions/api/fd/fc.js
// Fetches DraftKings real-time soccer spread (Asian handicap ±0.5) odds for top 6 European leagues
// Step 1: Fetch DK league events for each target competition
// Step 2: Filter to today's games in ET
// Step 3: Fetch spread markets per game
// debug=1: discover DK soccer category/league structure

const DK_BASE = 'https://sportsbook-nash.draftkings.com/sites/US-SB/api/sportscontent';
const CACHE_TTL = 30;

// DK league IDs for soccer — populated via debug=1 discovery
// Format: { id: DK_LEAGUE_ID, label: display_label }
// Placeholders until confirmed via debug
const TARGET_LEAGUES = [
  { id: '3',    label: 'EPL' },       // English Premier League — needs confirmation
  { id: '7',    label: 'UCL' },       // UEFA Champions League — needs confirmation
  { id: '11',   label: 'La Liga' },   // Spanish La Liga — needs confirmation
  { id: '13',   label: 'Bundesliga' },// German Bundesliga — needs confirmation
  { id: '14',   label: 'Serie A' },   // Italian Serie A — needs confirmation
  { id: '15',   label: 'Ligue 1' },   // French Ligue 1 — needs confirmation
];

const DK_HEADERS = {
  'Accept': '*/*',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
  'Origin': 'https://sportsbook.draftkings.com',
  'Referer': 'https://sportsbook.draftkings.com/'
};

function isToday_ET(dateStr) {
  if (!dateStr) return false;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  return fmt.format(new Date(dateStr)) === fmt.format(new Date());
}

function parseAmerican(str) {
  if (!str) return null;
  const s = String(str).replace(/\u2212/g, '-').replace(/[^0-9+\-]/g, '');
  const n = parseInt(s, 10);
  return isFinite(n) ? n : null;
}

async function getSession(request, db) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return null;
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    'SELECT u.id as user_id, u.plan FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).bind(m[1], now).first();
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');

  const reqUrl = new URL(request.url);
  const debugMode = reqUrl.searchParams.get('debug');

  const now = Math.floor(Date.now() / 1000);
  const cacheKey = 'fd_fc';

  if (!debugMode) {
    try {
      const cached = await env.DB.prepare(
        'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
      ).bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < CACHE_TTL) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
      }
    } catch(e) {}
  }

  try {
    const nowMs = Date.now();

    // debug=1: discover DK soccer league structure
    // Fetches DK's sport/category listing to find correct league IDs for soccer competitions
    if (debugMode === '1') {
      const results = [];

      // Try DK sport categories listing
      const catUrls = [
        `${DK_BASE}/controldata/sport/v1/categories`,
        `${DK_BASE}/v1/featured`,
        `${DK_BASE}/controldata/sport/v1/leagues`,
        `${DK_BASE}/controldata/sport/v1/sports`,
      ];
      for (const url of catUrls) {
        try {
          const r = await fetch(url, { headers: DK_HEADERS });
          if (r.ok) {
            const d = await r.json();
            results.push({ url, status: 200, keys: Object.keys(d || {}), preview: JSON.stringify(d).slice(0, 500) });
          } else {
            results.push({ url, status: r.status });
          }
        } catch(e) { results.push({ url, error: e.message }); }
        await new Promise(r => setTimeout(r, 80));
      }

      // Also try fetching each placeholder league ID to see what comes back
      for (const league of TARGET_LEAGUES) {
        const evQuery = encodeURIComponent(`$filter=leagueId eq '${league.id}'`);
        const url = `${DK_BASE}/controldata/league/leagueSubcategory/v1/markets?isBatchable=false&templateVars=${league.id}&eventsQuery=${evQuery}&include=Events&entity=events`;
        try {
          const r = await fetch(url, { headers: DK_HEADERS });
          if (r.ok) {
            const d = await r.json();
            const evSample = (d.events || []).slice(0, 3).map(e => ({ id: e.id, name: e.name, date: e.startEventDate, status: e.status }));
            results.push({ type: 'league-probe', id: league.id, label: league.label, status: 200, eventCount: (d.events || []).length, evSample });
          } else {
            results.push({ type: 'league-probe', id: league.id, label: league.label, status: r.status });
          }
        } catch(e) { results.push({ type: 'league-probe', id: league.id, label: league.label, error: e.message }); }
        await new Promise(r => setTimeout(r, 100));
      }

      return new Response(JSON.stringify({ results }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Main flow — placeholder until league IDs confirmed
    return new Response(JSON.stringify({ ok: true, games: {}, note: 'League IDs pending confirmation via debug=1' }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch(e) {
    return fail(500, e.message);
  }
}
