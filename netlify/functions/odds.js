exports.handler = async function(event) {
  const API_KEY = process.env.ODDS_API_KEY;
  if (!API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing API key' }) };
  }

  const params = event.queryStringParameters || {};
  const sport      = params.sport      || 'basketball_nba';
  const markets    = params.markets    || 'h2h';
  const bookmakers = params.bookmakers || 'fanduel,draftkings,betmgm,caesars';

  const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${API_KEY}&regions=us&markets=${markets}&bookmakers=${bookmakers}&oddsFormat=american`;

  try {
    const res  = await fetch(url);
    const data = await res.json();
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'x-requests-remaining': res.headers.get('x-requests-remaining') || '',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(data)
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
