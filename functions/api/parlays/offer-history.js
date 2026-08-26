// GET /api/parlays/offer-history?_cron_key=CRON_SECRET&min_amount=1000&days=90&view=incoming&status=accepted
// Fetch edgebot's offer history from RS in parallel pages, filtered by amount and date range.

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
    'real-version':       '36',
    'real-request-token': hashidsEncode(Date.now()),
  };
}

async function fetchPage(offset, authInfo, sessionToken, view, status) {
  try {
    const res = await fetch(
      `https://web.realapp.com/cardmarketplace/user/offers?offset=${offset}&status=${status}&view=${view}`,
      { headers: buildHeaders(authInfo, sessionToken), signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    if (!data) return [];
    return Array.isArray(data) ? data : (data.offers || []);
  } catch { return []; }
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

  // Fetch first page to see if there's any data
  const first = await fetchPage(0, authInfo, sessionToken, view, status);
  if (!first.length) return ok({ count: 0, offers: [] });

  // Fetch up to 200 pages in parallel batches of 20 (2000 offers max)
  const BATCH = 20;
  const MAX_PAGES = 200;
  let allOffers = [...first];
  let page = 1;

  while (page < MAX_PAGES) {
    const offsets = [];
    for (let i = 0; i < BATCH && page + i < MAX_PAGES; i++) {
      offsets.push((page + i) * 10);
    }
    const pages = await Promise.all(
      offsets.map(o => fetchPage(o, authInfo, sessionToken, view, status))
    );

    let hitCutoff = false;
    let hitEmpty  = false;
    for (const pageOffers of pages) {
      if (!pageOffers.length) { hitEmpty = true; break; }
      allOffers.push(...pageOffers);
      const oldest = pageOffers[pageOffers.length - 1];
      const ts = oldest?.statusChangedAt || oldest?.createdAt || oldest?.updatedAt;
      if (ts && new Date(ts).getTime() < cutoff) { hitCutoff = true; break; }
    }
    if (hitEmpty || hitCutoff) break;
    page += BATCH;
  }

  // Filter by cutoff and amount
  const filtered = allOffers.filter(o => {
    const ts = o.statusChangedAt || o.createdAt || o.updatedAt;
    const t  = ts ? new Date(ts).getTime() : 0;
    if (t < cutoff) return false;
    const amt = o.counterAmount ?? o.amount ?? o.offerAmount ?? 0;
    return amt >= minAmount;
  });

  // Sort newest first
  filtered.sort((a, b) => {
    const ta = new Date(a.statusChangedAt || a.createdAt || 0).getTime();
    const tb = new Date(b.statusChangedAt || b.createdAt || 0).getTime();
    return tb - ta;
  });

  // Return slim summary rows
  const offers = filtered.map(o => ({
    id:        o.id,
    amount:    o.counterAmount ?? o.amount ?? o.offerAmount,
    cardId:    o.cardId ?? o.card?.id ?? o.card_id ?? o.linkedCardIds?.[0] ?? null,
    status:    o.status ?? o.offerStatus,
    from:      o.fromUserId ?? o.offerFromUserId ?? o.sellerId ?? null,
    fromName:  o.fromUsername ?? o.offerFromUsername ?? o.sellerUsername ?? null,
    date:      o.statusChangedAt ?? o.createdAt ?? o.updatedAt,
  }));

  return ok({ count: offers.length, raw_scanned: allOffers.length, offers });
}
