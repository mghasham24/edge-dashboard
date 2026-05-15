// functions/api/auction/listings.js
// Proxies RS FC auction listings for the VPS scanner.
// VPS cannot call RS API directly (IP blocked) — this CF Worker acts as relay.
// Protected by PUSH_SECRET env var (same key as vps-scanner).

const RS_LISTINGS_URL = 'https://web.realapp.com/cardmarketplacelistings?sport=soccer&sort=new&offset=0';

export async function onRequestGet({ request, env }) {
  const key = new URL(request.url).searchParams.get('key');
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

  const [userId, deviceId, token] = authInfo.split('!');

  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': 'https://realsports.io',
    'Referer': 'https://realsports.io/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
    'real-auth-info': authInfo,
    'real-device-uuid': deviceId || '2e0a38e2-0ee8-4f93-9a34-218ac1d10161',
    'real-device-type': 'desktop_web',
    'real-version': '30',
  };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(RS_LISTINGS_URL, { headers, signal: ctrl.signal });
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
