// functions/api/dk/tennis-lines.js
// GET /api/dk/tennis-lines?leagues=72778,72779
// Returns today's tennis match winner (ML) odds from DK for the parlay builder.
// Pass ?leagues= as comma-separated DK league IDs. Default: 72778+72779 (US Open M+W).
// Subcat 6364 = Tennis Match Winner.

import { getSessionOrCron } from '../../_lib/auth.js';

const DK_BASE      = 'https://sportsbook-nash.draftkings.com/sites/US-SB/api/sportscontent';
const LINES_SUBCAT = '6364';  // Tennis Match Winner
const CACHE_TTL    = 900;     // 15 minutes
const DEFAULT_LEAGUES = ['72778', '72779']; // US Open Men's + Women's 2026

const DK_HEADERS = {
  'Accept':         '*/*',
  'User-Agent':     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
  'Origin':         'https://sportsbook.draftkings.com',
  'Referer':        'https://sportsbook.draftkings.com/',
  'x-client-name': 'web',
};

const ESPN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Accept':     'application/json',
};

function todayET() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

function parseOdds(american) {
  if (!american) return null;
  const s = String(american).replace(/−/g, '-').replace(/[^\d+\-]/g, '');
  if (!s || s === '-' || s === '+') return null;
  const n = parseInt(s, 10);
  return isFinite(n) ? n : null;
}

function normName(n) {
  return (n || '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

function eventsUrl(leagueId) {
  const eq = encodeURIComponent(`$filter=leagueId eq '${leagueId}' AND clientMetadata/Subcategories/any(s: s/Id eq '${LINES_SUBCAT}')`);
  const mq = encodeURIComponent(`$filter=clientMetadata/subCategoryId eq '${LINES_SUBCAT}' AND tags/all(t: t ne 'SportcastBetBuilder')`);
  return `${DK_BASE}/controldata/league/leagueSubcategory/v1/markets?isBatchable=false&templateVars=${leagueId}%2C${LINES_SUBCAT}&eventsQuery=${eq}&marketsQuery=${mq}&include=Events&entity=events`;
}

function linesUrl(eventId) {
  const mq = encodeURIComponent(
    `$filter=eventId eq '${eventId}' AND clientMetadata/subCategoryId eq '${LINES_SUBCAT}' AND tags/all(t: t ne 'SportcastBetBuilder')`
  );
  return `${DK_BASE}/controldata/event/eventSubcategory/v1/markets?isBatchable=false` +
         `&templateVars=${eventId}%2C${LINES_SUBCAT}&marketsQuery=${mq}&include=MarketSplits&entity=markets`;
}

function parseMatch(data, eventId, player1, player2, timeStr, startMs) {
  const selsByMarket = new Map();
  for (const s of (data.selections || [])) {
    const arr = selsByMarket.get(String(s.marketId)) || [];
    arr.push(s);
    selsByMarket.set(String(s.marketId), arr);
  }

  for (const mkt of (data.markets || [])) {
    const sels = selsByMarket.get(String(mkt.id)) || [];
    const name = (mkt.name || '').toLowerCase();
    if (!name.includes('match winner') && !name.includes('money line') && name !== 'moneyline') continue;

    // DK tennis: Home = first-listed player, Away = second-listed player
    const p1Sel = sels.find(s => s.outcomeType === 'Home');
    const p2Sel = sels.find(s => s.outcomeType === 'Away');
    if (!p1Sel || !p2Sel) continue;
    const p1Odds = parseOdds(p1Sel.displayOdds?.american);
    const p2Odds = parseOdds(p2Sel.displayOdds?.american);
    if (!p1Odds || !p2Odds) continue;
    return {
      eventId: String(eventId),
      player1, player2,
      time: timeStr, startMs,
      p1Odds, p2Odds,
      p1SelId: String(p1Sel.id), p2SelId: String(p2Sel.id),
      marketId: String(mkt.id),
    };
  }
  return null;
}

async function fetchLeagueMatches(leagueId, today) {
  const evRes = await fetch(eventsUrl(leagueId), { headers: DK_HEADERS, signal: AbortSignal.timeout(12000) });
  if (!evRes.ok) return [];
  const evData = await evRes.json();
  const leagueName = evData.leagues?.[0]?.name || 'Tennis';

  const todayEvents = (evData.events || []).filter(e => {
    const d = e.startEventDate
      ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(e.startEventDate))
      : '';
    return d === today;
  });

  return Promise.all(todayEvents.map(async e => {
    const startMs = e.startEventDate ? new Date(e.startEventDate).getTime() : 0;
    const timeStr = startMs
      ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(startMs))
      : '';
    const parts    = e.participants || [];
    const p1Part   = parts.find(p => p.venueRole === 'Home') || parts[0];
    const p2Part   = parts.find(p => p.venueRole === 'Away') || parts[1];
    const player1  = p1Part?.name || '';
    const player2  = p2Part?.name || '';
    const p1ExtId  = p1Part?.metadata?.externalId || p1Part?.metadata?.playerId || p1Part?.providerId || null;
    const p2ExtId  = p2Part?.metadata?.externalId || p2Part?.metadata?.playerId || p2Part?.providerId || null;
    const p1Country = p1Part?.countryCode || null;
    const p2Country = p2Part?.countryCode || null;
    if (!player1 || !player2) return null;

    try {
      const res = await fetch(linesUrl(String(e.id)), { headers: DK_HEADERS, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const data = await res.json();
      const match = parseMatch(data, e.id, player1, player2, timeStr, startMs);
      if (match) {
        match.p1ExtId   = p1ExtId;   match.p2ExtId   = p2ExtId;
        match.p1Country = p1Country; match.p2Country = p2Country;
        match.leagueName = leagueName;
      }
      return match;
    } catch { return null; }
  }));
}

// Fetch player headshots from ESPN tennis scoreboards (ATP + WTA).
// ESPN tennis: matches are in event.groupings[].competitions[], not event.competitions[].
// Headshot URL built from competitor.id: https://a.espncdn.com/i/headshots/tennis/players/full/{id}.png
async function fetchESPNHeadshots(today) {
  const espnDate = today.replace(/-/g, '');
  const hs = {};
  await Promise.all(['atp', 'wta'].map(async tour => {
    try {
      const res = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/tennis/${tour}/scoreboard?dates=${espnDate}`,
        { headers: ESPN_HEADERS, signal: AbortSignal.timeout(8000) }
      );
      if (!res.ok) return;
      const data = await res.json();
      for (const ev of (data.events || [])) {
        for (const grouping of (ev.groupings || [])) {
          for (const match of (grouping.competitions || [])) {
            for (const c of (match.competitors || [])) {
              if (!c.id || !c.athlete?.displayName) continue;
              const key = normName(c.athlete.displayName);
              const url = `https://a.espncdn.com/i/headshots/tennis/players/full/${c.id}.png`;
              if (key && !hs[key]) hs[key] = url;
            }
          }
        }
      }
    } catch(_) {}
  }));
  return hs;
}

// Attach p1Headshot / p2Headshot to each match using espnHs map.
// Tries exact normalized name first, then last-name-only fallback.
function attachHeadshots(matches, espnHs) {
  const entries = Object.entries(espnHs);
  for (const m of matches) {
    const k1 = normName(m.player1);
    const k2 = normName(m.player2);
    const lastNameLookup = k => {
      const ln = k.split(' ').pop();
      if (!ln || ln.length <= 3) return null;
      for (const [ek, ev] of entries) {
        if (ek === k || ek.endsWith(' ' + ln)) return ev;
      }
      return null;
    };
    m.p1Headshot = espnHs[k1] || lastNameLookup(k1) || null;
    m.p2Headshot = espnHs[k2] || lastNameLookup(k2) || null;
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSessionOrCron(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  const url       = new URL(request.url);
  const debug     = url.searchParams.get('debug');
  const nocache   = url.searchParams.has('nocache');
  const leaguesParam = url.searchParams.get('leagues');
  const leagueIds = leaguesParam ? leaguesParam.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_LEAGUES;
  const cacheKey  = `dk_tennis_lines_v2_${leagueIds.slice().sort().join('_')}`;

  const now   = Math.floor(Date.now() / 1000);
  const today = todayET();
  const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=600' };

  if (!nocache && !debug) {
    try {
      const cached = await env.DB.prepare('SELECT data, fetched_at FROM odds_cache WHERE cache_key=?').bind(cacheKey).first();
      if (cached) {
        if ((now - cached.fetched_at) < CACHE_TTL) return new Response(cached.data, { headers: JSON_HEADERS });
        context.waitUntil(refreshTennisCache(env, now, today, leagueIds, cacheKey));
        return new Response(cached.data, { headers: JSON_HEADERS });
      }
    } catch(e) {}
  }

  if (debug === '1') {
    const evRes = await fetch(eventsUrl(leagueIds[0]), { headers: DK_HEADERS, signal: AbortSignal.timeout(12000) });
    const evData = await evRes.json();
    return new Response(JSON.stringify({ leagueId: leagueIds[0], events: evData.events?.slice(0, 3) || [] }, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (debug === '2') {
    const evRes = await fetch(eventsUrl(leagueIds[0]), { headers: DK_HEADERS, signal: AbortSignal.timeout(12000) });
    const evData = await evRes.json();
    const firstEvent = evData.events?.[0];
    if (!firstEvent) return new Response(JSON.stringify({ error: 'no events' }), { headers: { 'Content-Type': 'application/json' } });
    const linesRes = await fetch(linesUrl(String(firstEvent.id)), { headers: DK_HEADERS, signal: AbortSignal.timeout(8000) });
    const linesData = await linesRes.json();
    return new Response(JSON.stringify({
      eventId: firstEvent.id,
      name: firstEvent.name,
      participants: firstEvent.participants,
      firstMarket: linesData.markets?.[0],
      firstSelections: linesData.selections?.slice(0, 4),
    }, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }

  if (debug === '3') {
    const espnHs = await fetchESPNHeadshots(today).catch(() => ({}));
    return new Response(JSON.stringify({ count: Object.keys(espnHs).length, headshots: espnHs }, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const [allResults, espnHs] = await Promise.all([
    Promise.all(leagueIds.map(id => fetchLeagueMatches(id, today).catch(() => []))),
    fetchESPNHeadshots(today).catch(() => ({})),
  ]);
  const matches = allResults.flat().filter(Boolean).sort((a, b) => a.startMs - b.startMs);
  attachHeadshots(matches, espnHs);
  const payload = JSON.stringify({ ok: true, matches, count: matches.length, ts: now });

  if (matches.length > 0) {
    context.waitUntil(
      env.DB.prepare(
        'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
      ).bind(cacheKey, payload, now).run().catch(() => {})
    );
  }

  return new Response(payload, { headers: JSON_HEADERS });
}

async function refreshTennisCache(env, now, today, leagueIds, cacheKey) {
  try {
    const [allResults, espnHs] = await Promise.all([
      Promise.all(leagueIds.map(id => fetchLeagueMatches(id, today).catch(() => []))),
      fetchESPNHeadshots(today).catch(() => ({})),
    ]);
    const matches = allResults.flat().filter(Boolean).sort((a, b) => a.startMs - b.startMs);
    if (!matches.length) return;
    attachHeadshots(matches, espnHs);
    const payload = JSON.stringify({ ok: true, matches, count: matches.length, ts: now });
    await env.DB.prepare(
      'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
    ).bind(cacheKey, payload, now).run();
  } catch(e) {}
}
