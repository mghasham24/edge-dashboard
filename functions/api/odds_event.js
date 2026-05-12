import { getSession } from '../_lib/session.js';
// functions/api/odds_event.js
// Fetches alternate lines for a single event from The Odds API
// Used when Real Sports line differs from FanDuel main line

export async function onRequest(context) {
  const API_KEY = context.env.ODDS_API_KEY;
  if (!API_KEY) {
    return new Response(JSON.stringify({ error: 'Missing API key' }), { status: 500 });
  }

  // Auth check
  const session = await getSession(context.request, context.env.DB);
  if (!session) return fail(401, 'Not authenticated');

  const url     = new URL(context.request.url);
  const sport   = url.searchParams.get('sport');
  const eventId = url.searchParams.get('eventId');

  if (!sport || !eventId) return fail(400, 'Missing sport or eventId');

  const apiUrl = `https://api.the-odds-api.com/v4/sports/${sport}/events/${eventId}/odds?apiKey=${API_KEY}&regions=us&bookmakers=fanduel&markets=alternate_spreads,alternate_totals&oddsFormat=american`;

  try {
    const res  = await fetch(apiUrl);
    const data = await res.json();

    if (!res.ok) return fail(res.status, data.message || 'Odds API error');

    // Extract FanDuel alternate lines
    const fd = ((data.bookmakers || []).find(b => b.key === 'fanduel'));
    const altOdds = { spreads: {}, totals: {} };

    if (fd) {
      (fd.markets || []).forEach(function(mkt) {
        (mkt.outcomes || []).forEach(function(o) {
          if (mkt.key === 'alternate_spreads') {
            if (!altOdds.spreads[o.name]) altOdds.spreads[o.name] = {};
            altOdds.spreads[o.name][o.point] = o.price;
          } else if (mkt.key === 'alternate_totals') {
            if (!altOdds.totals[o.name]) altOdds.totals[o.name] = {};
            altOdds.totals[o.name][o.point] = o.price;
          }
        });
      });
    }

    return new Response(JSON.stringify({ ok: true, eventId, altOdds }), {
      headers: {
        'Content-Type': 'application/json',
        'x-requests-remaining': res.headers.get('x-requests-remaining') || ''
      }
    });
  } catch(e) {
    return fail(500, e.message);
  }
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
