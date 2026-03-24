// v1.3 - Live scores proxy
export async function onRequest(context) {
  const API_KEY = context.env.ODDS_API_KEY;
  if (!API_KEY) {
    return new Response(JSON.stringify({ error: 'Missing API key' }), { status: 500 });
  }

  const url = new URL(context.request.url);
  const sport = url.searchParams.get('sport') || 'basketball_nba';

  const apiUrl = `https://api.the-odds-api.com/v4/sports/${sport}/scores/?apiKey=${API_KEY}&daysFrom=1`;

  try {
    const res = await fetch(apiUrl);
    const data = await res.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'x-requests-remaining': res.headers.get('x-requests-remaining') || '',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 502 });
  }
}
