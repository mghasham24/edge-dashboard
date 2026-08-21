// GET /api/parlays/offer-history?_cron_key=CRON_SECRET&min_amount=1000&days=90&view=incoming&status=accepted
// Fetch edgebot's offer history from RS, filtered by amount and date range.

import { hashidsEncode } from '../../_lib/hashids.js';
import { ok, err }       from '../../_lib/response.js';

const RS_DEVICE_UUID = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';

function buildHeaders(authInfo, sessionToken) {
  return {
    'Accept':             'application/json',
    'Content-Type':       'application/json',
    'Origin':             'https://www.realapp.com',
    'Referer':            'https://www.realapp.com/',
    'User-Agent':         'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
    'real-auth-info':     authInfo,
    'real-session-token': sessionToken || '',
    'real-device-uuid':   RS_DEVICE_UUID,
    'real-device-type':   'desktop_web',
    'real-device-name':   '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
    'real-version':       '35',
    'real-request-token': hashidsEncode(Date.now()),
  };
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (!env.CRON_SECRET || url.searchParams.get('_cron_key') !== env.CRON_SECRET)
    return err('Unauthorized', 401);

  const authInfo     = env.EDGEBOT_AUTH_INFO;
  const sessionToken = env.EDGEBOT_SESSION_TOKEN || '';
  if (!authInfo) return err('EDGEBOT_AUTH_INFO not set', 500);

  const minAmount = parseInt(url.searchParams.get('min_amount') || '1000', 10);
  const days      = parseInt(url.searchParams.get('days') || '90', 10);
  const view      = url.searchParams.get('view') || 'incoming';
  const status    = url.searchParams.get('status') || 'accepted';
  const cutoff    = Date.now() - days * 86400000;

  const offers = [];
  for (let page = 0; page < 100; page++) {
    const offset = page * 10;
    let res;
    try {
      res = await fetch(
        `https://web.realapp.com/cardmarketplace/user/offers?offset=${offset}&status=${status}&view=${view}`,
        { headers: buildHeaders(authInfo, sessionToken), signal: AbortSignal.timeout(8000) }
      );
    } catch { break; }

    if (!res.ok) break;
    const data = await res.json().catch(() => null);
    if (!data) break;
    const page_offers = Array.isArray(data) ? data : (data.offers || []);
    if (!page_offers.length) break;

    for (const o of page_offers) {
      const ts = o.statusChangedAt || o.createdAt || o.updatedAt;
      const t  = ts ? new Date(ts).getTime() : 0;
      if (t < cutoff) { page = 9999; break; } // past cutoff — stop all pages
      if ((o.amount || o.offerAmount || 0) >= minAmount) offers.push(o);
    }

    if (page_offers.length < 10) break;
  }

  // Sort newest first
  offers.sort((a, b) => {
    const ta = new Date(a.statusChangedAt || a.createdAt || 0).getTime();
    const tb = new Date(b.statusChangedAt || b.createdAt || 0).getTime();
    return tb - ta;
  });

  return ok({ count: offers.length, offers });
}
