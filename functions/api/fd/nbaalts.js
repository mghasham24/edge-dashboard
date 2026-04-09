// functions/api/fd/nba-alts.js
// Fetches FanDuel live alternate spread + total lines for NBA games
// directly from FanDuel's native API — same approach as fd/rfi.js

const FD_AK       = 'FhMFpcPWXMeyZxOx';
const FD_LIST_URL = `https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=nba&_ak=${FD_AK}&timezone=America/New_York`;
const FD_EVENT_URL = (id) => `https://sbapi.nj.sportsbook.fanduel.com/api/event-page?_ak=${FD_AK}&eventId=${id}&tab=all&timezone=America/New_York`;
const CACHE_TTL = 30; // 30s — matches live odds cache

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

function parseEventName(name) {
  // "Boston Celtics @ Miami Heat" or "Boston Celtics @ Miami Heat (Period 2)"
  const m = name.match(/^(.+?)\s*(?:\([^)]*\))?\s*@\s*(.+?)\s*(?:\([^)]*\))?\s*$/);
  if (!m) return null;
  return { away: m[1].trim(), home: m[2].trim() };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');
  const url = new URL(request.url);
  const debug = url.searchParams.get('debug') === '1';

  const now = Math.floor(Date.now() / 1000);
  const cacheKey = 'fd_nba_alts';

  // Try cache first (skip in debug mode)
  if (!debug) {
    try {
      const cached = await env.DB.prepare(
        'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
      ).bind(cacheKey).first();
      if (cached && (now - cached.fetched_at) < CACHE_TTL) {
        return new Response(cached.data, { headers: { 'Content-Type': 'application/json' } });
      }
    } catch(e) {}
  }

  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
  };

  try {
    // Step 1: Get today's NBA events from FanDuel
    const listRes = await fetch(FD_LIST_URL, { headers });
    if (!listRes.ok) return fail(listRes.status, 'FD NBA list fetch failed');
    const listData = await listRes.json();

    const events = listData?.attachments?.events || {};
    const nowMs = Date.now();
    const todayEvents = Object.values(events).filter(e => {
      if (!e.openDate) return false;
      const t = new Date(e.openDate).getTime();
      // Games within last 4 hours (live) or next 12 hours (upcoming today)
      return t >= nowMs - 4 * 60 * 60 * 1000 && t <= nowMs + 12 * 60 * 60 * 1000;
    });

    if (!todayEvents.length) {
      const body = JSON.stringify({ ok: true, games: {} });
      return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    }

    // Step 2: Fetch each event page and extract alternate spread + total markets
    const gamesMap = {};
    const debugInfo = {};

    for (let i = 0; i < todayEvents.length; i++) {
      const event = todayEvents[i];
      const teams = parseEventName(event.name);
      if (!teams) continue;

      const gameKey = teams.away + ' @ ' + teams.home;
      const altData = { spreads: {}, totals: {} };

      try {
        const evRes = await fetch(FD_EVENT_URL(event.eventId), { headers });
        if (!evRes.ok) continue;
        const evData = await evRes.json();

        const markets = evData?.attachments?.markets || {};
        const runners = evData?.attachments?.runners || {};

        if (debug) {
          const attachments = evData?.attachments || {};
          debugInfo[gameKey] = {
            attachmentKeys: Object.keys(attachments),
            marketCount: Object.keys(markets).length,
            markets: Object.values(markets).map(function(mkt) {
              return { marketType: mkt.marketType, marketName: mkt.marketName };
            }),
            // Inspect competitions structure for nested market groups
            competitionsSample: Object.values(attachments.competitions || {}).slice(0, 2).map(function(c) {
              return { id: c.id, name: c.name, keys: Object.keys(c) };
            }),
            // Check marketGroups if it exists
            marketGroupsKeys: Object.keys(attachments.marketGroups || {}),
            marketGroupsSample: Object.values(attachments.marketGroups || {}).slice(0, 5).map(function(mg) {
              return { name: mg.name || mg.marketGroupName, type: mg.type, keys: Object.keys(mg) };
            })
          };
        }

        Object.values(markets).forEach(function(mkt) {
          const mktName = (mkt.marketName || '').toLowerCase();
          const mktType = (mkt.marketType || '').toLowerCase();
          const isAltSpread = mktName.includes('alternate spread') || mktName.includes('alt spread')
            || mktType.includes('alternate_handicap') || mktType.includes('alt_handicap')
            || mktType.includes('alternatehandicap') || mktType.includes('alternative_handicap');
          const isAltTotal  = mktName.includes('alternate total') || mktName.includes('alt total')
            || mktType.includes('alternate_total') || mktType.includes('alt_total')
            || mktType.includes('alternatetotal') || mktType.includes('alternative_total');

          if (!isAltSpread && !isAltTotal) return;

          const mktRunners = (mkt.runners || []).map(function(rRef) {
            // runners can be inline or referenced by ID
            return rRef.selectionId ? (runners[rRef.selectionId] || rRef) : rRef;
          });

          mktRunners.forEach(function(runner) {
            if (runner.runnerStatus !== 'ACTIVE') return;
            const price = runner.winRunnerOdds?.americanDisplayOdds?.americanOddsInt;
            if (price == null) return;
            const name  = runner.runnerName || '';
            const handicap = runner.handicap;

            if (isAltSpread && handicap != null) {
              // name is team name (e.g. "Phoenix Suns"), handicap is the point value
              if (!altData.spreads[name]) altData.spreads[name] = {};
              altData.spreads[name][handicap] = price;
            }

            if (isAltTotal && handicap != null) {
              // name is "Over" or "Under"
              const side = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
              if (side === 'Over' || side === 'Under') {
                if (!altData.totals[side]) altData.totals[side] = {};
                altData.totals[side][handicap] = price;
              }
            }
          });
        });
      } catch(e) {}

      gamesMap[gameKey] = altData;
      if (i < todayEvents.length - 1) await new Promise(r => setTimeout(r, 150));
    }

    if (debug) {
      return new Response(JSON.stringify({ ok: true, debug: debugInfo }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const body = JSON.stringify({ ok: true, games: gamesMap });
    try {
      await env.DB.prepare(
        'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
      ).bind(cacheKey, body, now).run();
    } catch(e) {}

    return new Response(body, { headers: { 'Content-Type': 'application/json' } });

  } catch(e) {
    return fail(500, e.message);
  }
}
