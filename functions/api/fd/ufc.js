// functions/api/fd/ufc.js
// GET /api/fd/ufc — DK native UFC odds (Moneyline + Total Rounds)
// Pro-only. No Odds API credits used.

import { getSessionOrCron } from '../../_lib/auth.js';

const DK_BASE      = 'https://sportsbook-nash.draftkings.com/sites/US-SB/api/sportscontent';
const DK_LEAGUE_ID = '9034';
const CACHE_TTL    = 30;

const DK_HEADERS = {
  'Accept':       '*/*',
  'User-Agent':   'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
  'Origin':       'https://sportsbook.draftkings.com',
  'Referer':      'https://sportsbook.draftkings.com/',
};

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
  const reqUrl   = new URL(request.url);
  const freshMode = reqUrl.searchParams.get('fresh');

  if (!freshMode) {
    try {
      const cached = await env.DB.prepare(
        'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
      ).bind('dk_ufc').first();
      if (cached && (now - cached.fetched_at) < CACHE_TTL) {
        return new Response(cached.data, {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
    } catch (e) {}
  }

  try {
    // Step 1: get prelive event IDs for UFC
    const preliveUrl = `${DK_BASE}/prepacks/league/v2/leagues/contentcards/prelive?entityIds=${DK_LEAGUE_ID}`;
    const preliveRes = await fetch(preliveUrl, { headers: DK_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!preliveRes.ok) return fail(preliveRes.status, 'DK prelive failed');
    const preliveData = await preliveRes.json();

    const eventIds = [];
    const cards = preliveData?.contentCards || preliveData?.data?.contentCards || [];
    for (const card of cards) {
      const eid = card?.eventId ?? card?.data?.eventId ?? card?.data?.event?.eventId;
      if (eid != null) {
        const s = String(eid);
        if (!eventIds.includes(s)) eventIds.push(s);
      }
    }

    if (!eventIds.length) {
      const body = JSON.stringify({ ok: true, fights: {} });
      try { await env.DB.prepare("INSERT INTO odds_cache(cache_key,data,fetched_at) VALUES('dk_ufc',?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at").bind(body, now).run(); } catch (e) {}
      return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    }

    // Step 2: fetch events in batches of 20
    const fights = {};
    const BATCH  = 20;
    for (let i = 0; i < eventIds.length; i += BATCH) {
      const batch  = eventIds.slice(i, i + BATCH);
      const evUrl  = `${DK_BASE}/pagedata/league/v1/events?eventIds=${batch.join(',')}`;
      let evData;
      try {
        const evRes = await fetch(evUrl, { headers: DK_HEADERS, signal: AbortSignal.timeout(12000) });
        evData = await evRes.json();
      } catch (e) { continue; }

      const events     = evData?.events     || [];
      const markets    = evData?.markets    || [];
      const selections = evData?.selections || [];

      // Index markets by eventId
      const mktsByEvent = {};
      for (const mkt of markets) {
        const eid = String(mkt?.eventId ?? '');
        if (!eid) continue;
        if (!mktsByEvent[eid]) mktsByEvent[eid] = [];
        mktsByEvent[eid].push(mkt);
      }

      // Index selections by marketId
      const selsByMkt = {};
      for (const sel of selections) {
        const mid = String(sel?.marketId ?? '');
        if (!mid) continue;
        if (!selsByMkt[mid]) selsByMkt[mid] = [];
        selsByMkt[mid].push(sel);
      }

      for (const event of events) {
        const eid = String(event?.eventId ?? event?.id ?? '');
        if (!eid) continue;

        // Extract participants
        const participants = event?.teamParticipants || event?.participants || [];
        let home = null, away = null, homeSdid = null, awaySdid = null;
        for (const p of participants) {
          const name = p.name || p.label || '';
          const sdid = p.metadata?.sdid ?? p.sdid ?? null;
          if (p.outcomeType === 'Home') {
            home = name; homeSdid = sdid;
          } else if (p.outcomeType === 'Away') {
            away = name; awaySdid = sdid;
          } else {
            if (!away) { away = name; awaySdid = sdid; }
            else if (!home) { home = name; homeSdid = sdid; }
          }
        }
        if (!home || !away) continue;

        const cm      = event.startDate || event.startTime || null;
        const gameKey = away + ' @ ' + home;
        const fight   = { id: eid, home, away, cm, ml: {}, totals: {}, home_sdid: homeSdid, away_sdid: awaySdid };

        for (const mkt of (mktsByEvent[eid] || [])) {
          const mktName = mkt.name || mkt.marketName || '';
          const sels    = selsByMkt[String(mkt.marketId)] || [];

          if (mktName === 'Moneyline' || mktName === 'Fight Winner') {
            for (const sel of sels) {
              const am = parseAmerican(sel?.displayOdds?.american) ?? decToAmerican(sel.trueOdds);
              if (am == null) continue;
              if (sel.outcomeType === 'Home')      fight.ml[home] = am;
              else if (sel.outcomeType === 'Away') fight.ml[away] = am;
            }
          } else if (mktName === 'Total Rounds') {
            for (const sel of sels) {
              const am = parseAmerican(sel?.displayOdds?.american) ?? decToAmerican(sel.trueOdds);
              const pt = sel.points != null ? parseFloat(sel.points) : null;
              if (am == null || pt == null || isNaN(pt)) continue;
              const ot = sel.outcomeType === 'Over' ? 'Over' : sel.outcomeType === 'Under' ? 'Under' : null;
              if (!ot) continue;
              if (!fight.totals[ot]) fight.totals[ot] = {};
              fight.totals[ot][pt] = am;
            }
          }
        }

        if (Object.keys(fight.ml).length >= 2) fights[gameKey] = fight;
      }
    }

    const body = JSON.stringify({ ok: true, fights });
    try {
      await env.DB.prepare(
        "INSERT INTO odds_cache(cache_key,data,fetched_at) VALUES('dk_ufc',?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at"
      ).bind(body, now).run();
    } catch (e) {}

    return new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch (e) {
    return fail(500, 'Internal error: ' + e.message);
  }
}
