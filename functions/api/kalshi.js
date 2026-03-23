// v1.1 - Kalshi market data proxy (no auth needed for market data)
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const ticker = url.searchParams.get('ticker');
  const event_ticker = url.searchParams.get('event_ticker');

  try {
    let apiUrl;
    if (event_ticker) {
      apiUrl = `https://api.elections.kalshi.com/trade-api/v2/events/${event_ticker}?with_nested_markets=true`;
    } else if (ticker) {
      apiUrl = `https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}`;
    } else {
      return new Response(JSON.stringify({ error: 'Missing ticker or event_ticker' }), { status: 400 });
    }

    const res = await fetch(apiUrl, {
      headers: { 'Accept': 'application/json' }
    });
    const data = await res.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 502 });
  }
}
