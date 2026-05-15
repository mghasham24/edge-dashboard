// functions/api/auction/globalcards.js
// Proxies RS global card feed for the VPS pack-alert scanner.
// NOTE: RS /collection/ endpoints require browser session cookies — this endpoint
// returns 401 from RS when called server-side. Pack alerts use the TM script instead.
// VPS cannot call RS API directly (IP blocked) — this CF Worker acts as relay.
// Protected by AUCTION_PUSH_SECRET env var.
// Usage: GET /api/auction/globalcards?key=<secret>

// Entity IDs captured from live RS traffic by old auction-scanner (May 2026)
const ENTITY_MAP = {
  dimarco:   { entityId: '733389', sport: 'soccer', apiUrl: 'https://web.realapp.com/collection/soccer/season/2025/entity/play/globalcards' },
  mckennie:  { entityId: '734301', sport: 'soccer', apiUrl: 'https://web.realapp.com/collection/soccer/season/2025/entity/play/globalcards' },
  grimaldo:  { entityId: '732879', sport: 'soccer', apiUrl: 'https://web.realapp.com/collection/soccer/season/2025/entity/play/globalcards' },
  locatelli: { entityId: '734326', sport: 'soccer', apiUrl: 'https://web.realapp.com/collection/soccer/season/2025/entity/play/globalcards' },
  maia:      { entityId: '326',    sport: 'ufc',    apiUrl: 'https://web.realapp.com/collection/ufc/season/2023/entity/play/globalcards' },
};

export async function onRequestGet({ request, env }) {
  const params   = new URL(request.url).searchParams;
  const key      = params.get('key');
  const validKey = env.AUCTION_PUSH_SECRET || 'raxedge-vps-2026';

  if (!key || key !== validKey) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Get RS auth token — D1 first (freshest from TM bridge), env var fallback
  let authInfo   = null;
  let deviceUuid = env.REAL_DEVICE_UUID || '2e0a38e2-0ee8-4f93-9a34-218ac1d10161';
  try {
    const row = await env.DB.prepare(
      "SELECT data FROM odds_cache WHERE cache_key='meta:rs_auth_token'"
    ).first();
    if (row?.data) {
      const parsed = JSON.parse(row.data);
      if (parsed.token) authInfo = parsed.token;
      if (parsed.deviceUuid) deviceUuid = parsed.deviceUuid;
    }
  } catch (_) {}

  if (!authInfo) authInfo = env.REAL_AUTH_TOKEN || '';

  if (!authInfo) {
    return new Response(JSON.stringify({ error: 'No RS auth token available' }), {
      status: 503, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Generate random request token (required by RS — unique per request)
  const requestToken = Math.random().toString(36).slice(2, 18).padEnd(16, '0');

  const rsHeaders = {
    'Accept':              'application/json',
    'Content-Type':        'application/json',
    'Origin':              'https://realsports.io',
    'Referer':             'https://realsports.io/',
    'User-Agent':          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
    'real-auth-info':      authInfo,
    'real-device-uuid':    deviceUuid,
    'real-device-type':    'desktop_web',
    'real-device-name':    '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
    'real-version':        '31',
    'real-request-token':  requestToken,
  };

  // Fetch all targets in parallel with individual 8s timeouts
  const results = await Promise.all(
    Object.entries(ENTITY_MAP).map(async ([name, { entityId, sport, apiUrl }]) => {
      const url = `${apiUrl}?filterEntityId=${entityId}&filterEntityType=player&rarity=all&sort=new&pageSize=50`;
      try {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const res   = await fetch(url, { headers: rsHeaders, signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) {
          console.log(`globalcards: ${name} RS returned ${res.status}`);
          return [];
        }
        const data  = await res.json();
        const cards = data.cards || data.items || data.data || data.plays || [];
        return cards.map(c => ({ ...c, _sport: sport }));
      } catch (e) {
        console.log(`globalcards: ${name} error: ${e.message}`);
        return [];
      }
    })
  );

  const cards = results.flat();
  return new Response(JSON.stringify({ ok: true, cards }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
