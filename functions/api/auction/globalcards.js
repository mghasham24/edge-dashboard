// functions/api/auction/globalcards.js
// Proxies RS global card feed for the VPS pack-alert scanner.
// VPS cannot call RS API directly (IP blocked) — this CF Worker acts as relay.
// Protected by AUCTION_PUSH_SECRET env var (same key as vps-scanner).
// Usage: GET /api/auction/globalcards?key=<secret>&sport=soccer|ufc

export async function onRequestGet({ request, env }) {
  const params   = new URL(request.url).searchParams;
  const key      = params.get('key');
  const sport    = params.get('sport') === 'ufc' ? 'ufc' : 'soccer';
  const validKey = env.AUCTION_PUSH_SECRET || 'raxedge-vps-2026';

  if (!key || key !== validKey) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Get RS auth token — D1 first, env var fallback
  let authInfo = null;
  try {
    const row = await env.DB.prepare(
      "SELECT data FROM odds_cache WHERE cache_key='meta:rs_auth_token'"
    ).first();
    if (row?.data) {
      const parsed = JSON.parse(row.data);
      if (parsed.token) authInfo = parsed.token;
    }
  } catch (_) {}

  if (!authInfo) authInfo = env.RS_AUTH_TOKEN || '';

  if (!authInfo) {
    return new Response(JSON.stringify({ error: 'No RS auth token available' }), {
      status: 503, headers: { 'Content-Type': 'application/json' }
    });
  }

  const [, deviceId] = authInfo.split('!');

  const gcUrl = `https://web.realapp.com/globalcards/${sport}/?view=new&sort=new&pageSize=50&limit=50`;

  const headers = {
    'Accept':           'application/json',
    'Content-Type':     'application/json',
    'Origin':           'https://realsports.io',
    'Referer':          'https://realsports.io/',
    'User-Agent':       'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
    'real-auth-info':   authInfo,
    'real-device-uuid': deviceId || '2e0a38e2-0ee8-4f93-9a34-218ac1d10161',
    'real-device-type': 'desktop_web',
    'real-version':     '31',
  };

  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res   = await fetch(gcUrl, { headers, signal: ctrl.signal });
    clearTimeout(timer);

    if (!res.ok) {
      return new Response(JSON.stringify({ error: `RS API returned ${res.status}` }), {
        status: res.status, headers: { 'Content-Type': 'application/json' }
      });
    }

    const data = await res.json();
    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
