// functions/api/dk/contender-series.js
// GET /api/dk/contender-series — DK native Dana White's Contender Series moneylines
// Pro-only. Single controldata request — no prelive step needed.

import { getSessionOrCron } from '../../_lib/auth.js';

const DK_LEAGUE_ID = '187059';
const DK_SUBCAT_ID = '13025';
const CACHE_KEY    = 'dk_contender_series';
const CACHE_TTL    = 30;
const VPS_HOST     = 'http://vps.raxedge.com:3003';

function parseAmerican(str) {
  if (!str) return null;
  const s = String(str).replace(/−/g, '-').replace(/[^0-9+\-]/g, '');
  const n = parseInt(s, 10);
  return isFinite(n) ? n : null;
}

function decToAmerican(dec) {
  if (!dec || dec <= 1) return null;
  return dec >= 2 ? Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1));
}

function fail(status, msg) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSessionOrCron(request, env);
  if (!session) return fail(401, 'Not authenticated');
  if (session.plan !== 'pro' && !session.is_admin) return fail(403, 'Pro plan required');

  const now      = Math.floor(Date.now() / 1000);
  const freshMode = new URL(request.url).searchParams.get('fresh');

  if (!freshMode) {
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
    const proxyUrl = VPS_HOST + '/dk-mma?league=' + DK_LEAGUE_ID + '&subcat=' + DK_SUBCAT_ID + '&key=' + proxyKey;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return fail(res.status, 'DK CS proxy failed: ' + res.status);
    const data = await res.json();

    const events     = data.events     || [];
    const markets    = data.markets    || [];
    const selections = data.selections || [];

    // Index moneyline market ID by event ID
    const mlMktByEvent = {};
    for (const mkt of markets) {
      if (mkt.name !== 'Moneyline') continue;
      const eid = String(mkt.eventId ?? '');
      if (eid) mlMktByEvent[eid] = String(mkt.id ?? '');
    }

    // Index selections by market ID
    const selsByMkt = {};
    for (const sel of selections) {
      const mid = String(sel.marketId ?? '');
      if (!mid) continue;
      if (!selsByMkt[mid]) selsByMkt[mid] = [];
      selsByMkt[mid].push(sel);
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

      const gameKey = away + ' @ ' + home;
      fights[gameKey] = { id: eid, home, away, cm: event.startEventDate || null, ml, eventGroup: 'Contender Series' };
    }

    const body = JSON.stringify({ ok: true, fights });
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
