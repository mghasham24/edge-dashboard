// functions/api/parlays/market-buy.js
// POST /api/parlays/market-buy?_cron_key=CRON_SECRET
// Auto-buys RS deposit cards from marketplace when free pool < 10.
// Only buys listings where numBids === 0 AND buyNowPrice === 10.
// Called every 5 min by alert-cron.

import { hashidsEncode } from '../../_lib/hashids.js';
import { ok, err }       from '../../_lib/response.js';

const RS_DEVICE_UUID = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';
const POOL_TARGET    = 10;
const BID_AMOUNT     = 10;
const LISTING_URL    = 'https://web.realapp.com/cardmarketplacelistings?cohort=all&listingType=all&prestige=all&rarity=all&season=2025&sport=mlb';

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

async function handleRequest({ request, env }) {
  const url   = new URL(request.url);
  const cronOk = env.CRON_SECRET && url.searchParams.get('_cron_key') === env.CRON_SECRET;
  if (!cronOk) return err('Unauthorized', 401);

  const authInfo     = env.EDGEBOT_AUTH_INFO;
  const sessionToken = env.EDGEBOT_SESSION_TOKEN || '';
  if (!authInfo) return err('EDGEBOT_AUTH_INFO not configured', 500);

  const now = Math.floor(Date.now() / 1000);

  // Count free (unassigned) deposit cards
  const freeRow  = await env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM deposit_cards WHERE assigned_to_parlay_id IS NULL'
  ).first();
  const freeCount = freeRow?.cnt ?? 0;

  if (freeCount >= POOL_TARGET) {
    return ok({ skipped: true, freeCount, reason: 'pool_full' });
  }

  const needed = POOL_TARGET - freeCount;

  // Fetch marketplace listings
  let listings;
  try {
    const res = await fetch(LISTING_URL, {
      headers: buildHeaders(authInfo, sessionToken),
      signal:  AbortSignal.timeout(10000),
    });
    if (res.status === 401 || res.status === 403) {
      return err('RS auth ' + res.status + ' — EDGEBOT_AUTH_INFO expired', 502);
    }
    if (!res.ok) return err('RS marketplace fetch failed: ' + res.status, 502);
    const data = await res.json();
    listings = Array.isArray(data) ? data : (data.listings || data.data || []);
  } catch (e) {
    return err('RS marketplace fetch error: ' + e.message, 502);
  }

  // Filter: no bids, exact buyNow price of 10
  const eligible = listings.filter(
    l => l.numBids === 0 && Number(l.buyNowPrice) === BID_AMOUNT
  );

  const bought = [];
  const errors = [];

  for (const listing of eligible.slice(0, needed)) {
    const listingId = listing.listingId ?? listing.id;
    const cardId    = listing.cardId    ?? listing.card_id;
    if (!listingId || !cardId) continue;

    let bidRes, bidData;
    try {
      bidRes  = await fetch(
        `https://web.realapp.com/cardmarketplacelistings/${listingId}/bid`,
        {
          method:  'POST',
          headers: buildHeaders(authInfo, sessionToken),
          body:    JSON.stringify({ bidAmount: BID_AMOUNT }),
          signal:  AbortSignal.timeout(10000),
        }
      );
      bidData = await bidRes.json().catch(() => ({}));
    } catch (e) {
      errors.push({ listingId, cardId, error: e.message });
      continue;
    }

    if (!bidRes.ok || !bidData.success) {
      errors.push({ listingId, cardId, status: bidRes.status, data: bidData });
      continue;
    }

    // Add to pool — INSERT OR IGNORE so a re-run can't duplicate
    try {
      await env.DB.prepare(
        'INSERT OR IGNORE INTO deposit_cards (card_id) VALUES (?)'
      ).bind(cardId).run();
      bought.push({ listingId, cardId });
    } catch (e) {
      errors.push({ listingId, cardId, error: 'db_insert: ' + e.message });
    }
  }

  const result = { ts: now, freeCount, needed, eligible: eligible.length, bought: bought.length, boughtCards: bought, errors };

  try {
    await env.DB.prepare(
      'INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ' +
      'ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at'
    ).bind('market_buy_debug', JSON.stringify(result), now).run();
  } catch (_) {}

  return ok(result);
}

export const onRequestPost = handleRequest;
export const onRequestGet  = handleRequest;
