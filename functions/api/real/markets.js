import { getSession } from '../../_lib/session.js';
import { hashidsEncode } from '../../_lib/hashids.js';
// functions/api/real/markets.js
// Proxies Real Sports market data with proper auth headers

// ── Handler ───────────────────────────────────────────
export async function onRequestGet({ request, env }) {
  // Auth check
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Not authenticated');

  const url    = new URL(request.url);
  const sport  = url.searchParams.get('sport');
  const gameId = url.searchParams.get('gameId');

  if (!sport || !gameId) return fail(400, 'Missing sport or gameId');
  if (!env.REAL_AUTH_TOKEN) return fail(500, 'Real Sports integration not configured');

  const realUrl = `https://web.realapp.com/predictions/game/${sport}/${gameId}/markets`;

  try {
    const res = await fetch(realUrl, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': 'https://realsports.io',
        'Referer': 'https://realsports.io/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'real-auth-info': env.REAL_AUTH_TOKEN,
        'real-device-name': 'Chrome on Windows',
        'real-device-type': 'desktop_web',
        'real-device-uuid': '2e0a38e2-0ee8-4f93-9a34-218ac1d10161',
        'real-request-token': hashidsEncode(Date.now()),
        'real-version': '28'
      }
    });

    if (!res.ok) return fail(res.status, 'Real Sports API error');
    const data = await res.json();

    // Extract just what we need: market label + probabilities per outcome
    const markets = (data.markets || []).map(m => ({
      label: m.label,
      outcomes: (m.outcomes || []).map(o => ({
        key: o.key,
        label: o.label,
        probability: o.probability,
        priceLabel: o.priceLabel
      }))
    }));

    return new Response(JSON.stringify({ ok: true, markets }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch(e) {
    return fail(500, 'Failed to fetch Real Sports data');
  }
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
