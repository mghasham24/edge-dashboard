// functions/api/fd/ufc.js
// GET /api/fd/ufc — DK native UFC moneylines (all upcoming events, grouped by subcategory)
// Pro-only. Fetches all subcategories in league 9034; returns fights tagged with eventGroup.
// Add ?debug=raw to inspect the raw DK/VPS response structure.

import { getSessionOrCron } from '../../_lib/auth.js';

const DK_LEAGUE_ID = '9034';  // UFC main card league
const CACHE_KEY    = 'dk_ufc_v8';  // v8: 8h shift so post-midnight fights stay on same card
const CACHE_TTL    = 30;
const VPS_HOST     = 'http://vps.raxedge.com:3003';

function parseAmerican(str) {
  if (!str) return null;
  const s = String(str).replace(/−/g, '-').replace(/−/g, '-').replace(/[^0-9+\-]/g, '');
  const n = parseInt(s, 10);
  return isFinite(n) ? n : null;
}

function decToAmerican(dec) {
  if (!dec || dec <= 1) return null;
  return dec >= 2 ? Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1));
}

function groupToKey(label) {
  return (label || 'ufc').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function fail(status, msg) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url      = new URL(request.url);
  const session  = await getSessionOrCron(request, env);
  if (!session) return fail(401, 'Not authenticated');

  const freshMode = url.searchParams.get('fresh');
  const debugRaw  = url.searchParams.get('debug') === 'raw';
  const debugMov  = url.searchParams.get('debug') === 'mov';
  const now       = Math.floor(Date.now() / 1000);

  if (!freshMode && !debugRaw && !debugMov) {
    try {
      const cached = await env.DB.prepare(
        'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
      ).bind(CACHE_KEY).first();
      if (cached && (now - cached.fetched_at) < CACHE_TTL) {
        return new Response(cached.data, {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
    } catch (e) {}
  }

  try {
    const proxyKey = env.VPS_DK_KEY || '';
    // No subcat filter — fetch all upcoming UFC events across every subcategory (330, 331, Fight Night, etc.)
    const proxyUrl = VPS_HOST + '/dk-mma?league=' + DK_LEAGUE_ID + '&key=' + proxyKey;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return fail(res.status, 'DK UFC proxy failed: ' + res.status);
    const data = await res.json();

    if (debugRaw) {
      const ev0 = (data.events || [])[0] || null;
      // Also dump fighter sdid values to check ID format
      const sdidSample = (data.selections || []).slice(0, 20).map(s => ({
        label: s.label,
        participant: s.participants?.[0] ? { name: s.participants[0].name, metadata: s.participants[0].metadata } : null,
      }));
      const sample = {
        topLevelKeys:   Object.keys(data),
        firstEventKeys: ev0 ? Object.keys(ev0) : [],
        firstEvent:     ev0 ? { id: ev0.id, name: ev0.name } : null,
        eventCount:     (data.events || []).length,
        sdidSample,
      };
      return new Response(JSON.stringify({ ok: true, _sample: sample }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    const events     = data.events     || [];
    const markets    = data.markets    || [];
    const selections = data.selections || [];

    // Build league name lookup: leagueId → "UFC 330", "UFC Fight Night", etc.
    const leagueNameById = {};
    for (const lg of (data.leagues || [])) {
      if (lg.leagueId != null && lg.name) leagueNameById[String(lg.leagueId)] = lg.name;
      else if (lg.id != null && lg.name)  leagueNameById[String(lg.id)]       = lg.name;
    }

    // Index moneyline market ID by event ID
    const mlMktByEvent = {};
    for (const mkt of markets) {
      if (mkt.name !== 'Moneyline' && mkt.name !== 'Fight Winner') continue;
      const eid = String(mkt.eventId ?? '');
      if (eid) mlMktByEvent[eid] = String(mkt.id ?? '');
    }

    // Index Total Rounds market ID by event ID
    const trMktByEvent = {};
    for (const mkt of markets) {
      if (mkt.name !== 'Total Rounds') continue;
      const eid = String(mkt.eventId ?? '');
      if (eid) trMktByEvent[eid] = String(mkt.id ?? '');
    }

    // Index selections by market ID; capture sdid per fighter name
    const selsByMkt = {};
    const sdidByName = {};
    for (const sel of selections) {
      const mid = String(sel.marketId ?? '');
      if (mid) {
        if (!selsByMkt[mid]) selsByMkt[mid] = [];
        selsByMkt[mid].push(sel);
      }
      const sdid = sel.participants?.[0]?.metadata?.sdid;
      if (sdid && sel.label) sdidByName[sel.label] = String(sdid);
    }

    const fights = {};
    for (const event of events) {
      if (event.status && event.status !== 'NOT_STARTED') continue;
      const eid     = String(event.id ?? '');
      const mlMktId = mlMktByEvent[eid];
      if (!mlMktId) continue;

      let home = null, away = null;
      for (const p of (event.participants || [])) {
        if (p.venueRole === 'Home') home = p.name;
        else if (p.venueRole === 'Away') away = p.name;
      }
      if (!home || !away) continue;

      const ml = {};
      for (const sel of (selsByMkt[mlMktId] || [])) {
        const am = parseAmerican(sel?.displayOdds?.american) ?? decToAmerican(sel.trueOdds);
        if (am == null) continue;
        if (sel.outcomeType === 'Home') ml[home] = am;
        else if (sel.outcomeType === 'Away') ml[away] = am;
      }
      if (Object.keys(ml).length < 2) continue;

      // Group by ET date — DK's league array only returns the generic "UFC" name for all fights,
      // so league name lookup is useless for separating UFC 330 from UFC 331.
      const lgId = String(event.leagueId ?? '');
      const eventGroup =
        event.subCategoryName || event.leagueSubcategoryName
        || event.eventGroupName || event.eventGroup
        || (event.startEventDate
            ? new Date(new Date(event.startEventDate).getTime() - 8 * 3600000)
                .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' })
            : 'UFC');

      // Populate Total Rounds from league response selections
      const trMktId = trMktByEvent[eid];
      const totals = {};
      for (const sel of (selsByMkt[trMktId] || [])) {
        if (sel.points == null) continue;
        const am = parseAmerican(sel?.displayOdds?.american) ?? decToAmerican(sel.trueOdds);
        if (am == null) continue;
        const lineStr = String(sel.points);
        if (sel.outcomeType === 'Over')  { if (!totals.Over)  totals.Over  = {}; totals.Over[lineStr]  = am; }
        if (sel.outcomeType === 'Under') { if (!totals.Under) totals.Under = {}; totals.Under[lineStr] = am; }
      }

      const gameKey = away + ' @ ' + home;
      fights[gameKey] = {
        id:         eid,
        home,
        away,
        cm:         event.startEventDate || null,
        ml,
        totals,
        mov:        {},
        home_sdid:  sdidByName[home] || null,
        away_sdid:  sdidByName[away] || null,
        eventGroup,
        subCatId: lgId,
      };
    }

    // Build ordered groups list (chronological by first fight's start time)
    const groupOrder  = [];
    const groupSeen   = new Set();
    const sortedFights = Object.values(fights).sort((a, b) =>
      (a.cm ? new Date(a.cm).getTime() : 9e12) - (b.cm ? new Date(b.cm).getTime() : 9e12)
    );
    for (const f of sortedFights) {
      if (!groupSeen.has(f.eventGroup)) {
        groupSeen.add(f.eventGroup);
        groupOrder.push({ key: groupToKey(f.eventGroup), label: f.eventGroup });
      }
    }

    // Fetch Method of Victory per event in parallel (subcat 18911): ko / sub / dec
    const MOV_SUBCAT = '18911';
    const MOV_NORM   = { 'KO/TKO/DQ': 'ko', 'Submission': 'sub', 'Decision': 'dec' };
    const eidToGameKey = {};
    for (const [gk, f] of Object.entries(fights)) eidToGameKey[f.id] = gk;

    await Promise.all(Object.keys(eidToGameKey).map(async eid => {
      const fight = fights[eidToGameKey[eid]];
      if (!fight) return;
      try {
        const movUrl = VPS_HOST + '/dk-event-subcat?event=' + eid + '&subcat=' + MOV_SUBCAT + '&key=' + proxyKey;
        const res = await fetch(movUrl, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return;
        const data = await res.json();
        const mov = { home: {}, away: {} };
        const mktToMethod = {};
        for (const mkt of (data.markets || [])) {
          const method = MOV_NORM[mkt.name];
          if (method) mktToMethod[mkt.id] = method;
        }
        for (const sel of (data.selections || [])) {
          const method = mktToMethod[sel.marketId];
          if (!method) continue;
          const am = parseAmerican(sel?.displayOdds?.american) ?? decToAmerican(sel.trueOdds);
          if (am == null) continue;
          if (sel.outcomeType === 'Home')      mov.home[method] = am;
          else if (sel.outcomeType === 'Away') mov.away[method] = am;
        }
        fight.mov = mov;
      } catch (_) {}
    }));

    if (debugMov) {
      const firstEntry = Object.entries(fights)[0];
      let rawMovDebug = null;
      if (firstEntry) {
        const [gk, f] = firstEntry;
        const movUrl = VPS_HOST + '/dk-event-subcat?event=' + f.id + '&subcat=18911&key=' + proxyKey;
        try {
          const r = await fetch(movUrl, { signal: AbortSignal.timeout(8000) });
          const txt = await r.text();
          let parsed = null;
          try { parsed = JSON.parse(txt); } catch (_) {}
          rawMovDebug = {
            fight: gk, eventId: f.id, status: r.status, ok: r.ok,
            url: movUrl,
            topLevelKeys: parsed ? Object.keys(parsed) : null,
            marketsCount: parsed?.markets?.length ?? null,
            selectionsCount: parsed?.selections?.length ?? null,
            firstMarket: (parsed?.markets || [])[0] ?? null,
            firstSelection: (parsed?.selections || [])[0] ?? null,
            rawSnippet: txt.slice(0, 500),
          };
        } catch (e) {
          rawMovDebug = { fight: gk, eventId: f.id, error: e.message };
        }
      }
      return new Response(JSON.stringify({ ok: true, rawMovDebug }, null, 2), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    const body = JSON.stringify({ ok: true, fights, groups: groupOrder });
    try {
      await env.DB.prepare(
        'INSERT INTO odds_cache(cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at'
      ).bind(CACHE_KEY, body, now).run();
    } catch (e) {}

    return new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch (e) {
    return fail(500, 'Internal error: ' + e.message);
  }
}
