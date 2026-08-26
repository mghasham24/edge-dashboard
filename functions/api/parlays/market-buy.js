// functions/api/parlays/market-buy.js
// POST /api/parlays/market-buy?_cron_key=CRON_SECRET
// Auto-buys RS deposit cards from marketplace when free pool < POOL_TARGET.
// Only buys listings where numBids === 0 AND buyNowPrice === 10.
// Paginates listings until enough eligible cards are found or all pages exhausted.
// Called every 5 min by alert-cron.
// GET ?peek=1 (admin session) — inspect raw marketplace listing structure without buying.
// GET ?debug_log=1 (cron key) — return last market_buy_debug from odds_cache.

import { getSessionOrCron } from '../../_lib/auth.js';
import { hashidsEncode }    from '../../_lib/hashids.js';
import { ok, err }          from '../../_lib/response.js';

const RS_DEVICE_UUID  = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';
const POOL_TARGET     = 50;
const BID_AMOUNT      = 10;
const MAX_BUY_PER_RUN = 50;
const PAGE_SIZE       = 20;
const MAX_PAGES       = 15; // scan up to 300 listings per run
const LISTING_BASE    = 'https://web.realapp.com/cardmarketplacelistings?cohort=all&listingType=all&prestige=all&rarity=all&season=2025&sport=mlb';

function buildHeaders(authInfo, sessionToken) {
  return {
    'Accept':             'application/json',
    'Accept-Language':    'en-US,en;q=0.9',
    'Content-Type':       'application/json',
    'Origin':             'https://www.realsports.io',
    'Referer':            'https://www.realsports.io/',
    'User-Agent':         'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
    'sec-fetch-dest':     'empty',
    'sec-fetch-mode':     'cors',
    'sec-fetch-site':     'cross-site',
    'real-auth-info':     authInfo,
    'real-session-token': sessionToken || '',
    'real-device-uuid':   RS_DEVICE_UUID,
    'real-device-type':   'desktop_web',
    'real-device-name':   'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
    'real-version':       '36',
    'real-request-token': hashidsEncode(Date.now()),
  };
}

async function handleRequest({ request, env }) {
  const url     = new URL(request.url);
  const cronOk  = env.CRON_SECRET && url.searchParams.get('_cron_key') === env.CRON_SECRET;
  const session = cronOk ? null : await getSessionOrCron(request, env);

  // GET ?debug_log=1 — return last run result (cron key only)
  if (request.method === 'GET' && url.searchParams.has('debug_log')) {
    if (!cronOk) return err('Unauthorized', 401);
    const row = await env.DB.prepare("SELECT data FROM odds_cache WHERE cache_key='market_buy_debug'").first();
    const freeRow = await env.DB.prepare('SELECT COUNT(*) as cnt FROM deposit_cards WHERE assigned_to_parlay_id IS NULL').first();
    return new Response(JSON.stringify({ freeCount: freeRow?.cnt ?? 0, lastRun: row ? JSON.parse(row.data) : null }, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // GET ?peek=1 — fetch raw listing structure without buying (admin session)
  if (request.method === 'GET' && url.searchParams.has('peek')) {
    if (!session?.is_admin) return err('Admin required', 403);
    const authInfo     = env.EDGEBOT_AUTH_INFO;
    const sessionToken = env.EDGEBOT_SESSION_TOKEN || '';
    if (!authInfo) return err('EDGEBOT_AUTH_INFO not configured', 500);
    const freeRow = await env.DB.prepare('SELECT COUNT(*) as cnt FROM deposit_cards WHERE assigned_to_parlay_id IS NULL').first();
    const res = await fetch(`${LISTING_BASE}&limit=5&offset=0`, {
      headers: buildHeaders(authInfo, sessionToken), signal: AbortSignal.timeout(10000),
    });
    const raw = await res.text();
    let data;
    try { data = JSON.parse(raw); } catch(_) { data = raw.slice(0, 500); }
    const listings = Array.isArray(data) ? data : (data.listings || data.data || []);
    return new Response(JSON.stringify({
      freeCount: freeRow?.cnt ?? 0,
      httpStatus: res.status,
      isArray: Array.isArray(data),
      topKeys: data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : null,
      listingCount: listings.length,
      firstListing: listings[0] || null,
      firstKeys: listings[0] ? Object.keys(listings[0]) : [],
    }, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }

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

  const needed = Math.min(POOL_TARGET - freeCount, MAX_BUY_PER_RUN);

  // Paginate marketplace listings until we have enough eligible cards or all pages exhausted
  const eligible = [];
  let pagesScanned = 0;
  let totalScanned = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    let res;
    try {
      res = await fetch(
        `${LISTING_BASE}&limit=${PAGE_SIZE}&offset=${offset}`,
        { headers: buildHeaders(authInfo, sessionToken), signal: AbortSignal.timeout(10000) }
      );
    } catch (e) {
      if (!page) return err('RS marketplace fetch error: ' + e.message, 502);
      break; // network blip mid-pagination — use what we have
    }
    if (res.status === 401 || res.status === 403) {
      return err('RS auth ' + res.status + ' — EDGEBOT_AUTH_INFO expired', 502);
    }
    if (!res.ok) { if (!page) return err('RS marketplace fetch failed: ' + res.status, 502); break; }
    const data = await res.json();
    const page_listings = Array.isArray(data) ? data : (data.listings || data.data || []);
    pagesScanned++;
    totalScanned += page_listings.length;
    for (const l of page_listings) {
      if (Number(l.numBids) === 0 && Number(l.buyNowPrice) === BID_AMOUNT) eligible.push(l);
    }
    if (eligible.length >= needed) break;  // enough found — stop paginating
    if (page_listings.length < PAGE_SIZE)  break;  // last page
  }

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

  const result = { ts: now, freeCount, needed, pagesScanned, totalScanned, eligible: eligible.length, bought: bought.length, boughtCards: bought, errors };

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
