// functions/api/odds.js
export async function onRequest(context) {
  const API_KEY = context.env.ODDS_API_KEY;
  if (!API_KEY) {
    return new Response(JSON.stringify({ error: 'Missing API key' }), { status: 500 });
  }

  const url        = new URL(context.request.url);
  const sport      = url.searchParams.get('sport')      || 'basketball_nba';
  const markets    = url.searchParams.get('markets')    || 'h2h';
  const bookmakers = url.searchParams.get('bookmakers') || 'fanduel,draftkings,betmgm,caesars';

  const hasSpread = markets.includes('spreads');
  const hasTotal  = markets.includes('totals');

  // Build alternate markets param if needed
  const altMkts = [
    hasSpread ? 'alternate_spreads' : null,
    hasTotal  ? 'alternate_totals'  : null
  ].filter(Boolean).join(',');

  const baseUrl = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${API_KEY}&regions=us&bookmakers=${bookmakers}&oddsFormat=american`;

  try {
    // Always fetch main odds; fetch alternates in parallel if spreads/totals requested
    const fetches = [
      fetch(`${baseUrl}&markets=${markets}`)
    ];
    if (altMkts) {
      fetches.push(fetch(`${baseUrl}&markets=${altMkts}`));
    }

    const responses = await Promise.all(fetches);
    const [mainRes, altRes] = responses;

    const mainData = await mainRes.json();
    const altData  = altRes ? await altRes.json() : null;

    // Build alternate odds map: gameId -> { 'spreads': { teamName -> { point -> price } }, 'totals': { 'Over'/'Under' -> { point -> price } } }
    const alternateOdds = {};
    if (Array.isArray(altData)) {
      altData.forEach(function(g) {
        const fd = (g.bookmakers || []).find(b => b.key === 'fanduel');
        if (!fd) return;
        if (!alternateOdds[g.id]) alternateOdds[g.id] = { spreads: {}, totals: {} };
        (fd.markets || []).forEach(function(mkt) {
          (mkt.outcomes || []).forEach(function(o) {
            if (mkt.key === 'alternate_spreads') {
              if (!alternateOdds[g.id].spreads[o.name]) alternateOdds[g.id].spreads[o.name] = {};
              alternateOdds[g.id].spreads[o.name][o.point] = o.price;
            } else if (mkt.key === 'alternate_totals') {
              // o.name is "Over" or "Under", o.description is the total point
              const side = o.name; // "Over" or "Under"
              const pt   = o.point;
              if (!alternateOdds[g.id].totals[side]) alternateOdds[g.id].totals[side] = {};
              alternateOdds[g.id].totals[side][pt] = o.price;
            }
          });
        });
      });
    }

    const responseBody = JSON.stringify({ games: mainData, alternateOdds });

    return new Response(responseBody, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'x-requests-remaining': mainRes.headers.get('x-requests-remaining') || '',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 502 });
  }
}
