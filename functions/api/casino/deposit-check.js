// functions/api/casino/deposit-check.js
// GET /api/casino/deposit-check?_cron_key=CRON_SECRET
// Also callable by user: GET /api/casino/deposit-check (session auth — checks own pending deposit)
// Checks edgebot's RS incoming offers for accepted casino deposit transactions.
// On match: accepts open offers, credits casino_balance * 0.9, confirms deposit.
// Expires pending deposits older than 3 min.

import { getSession }    from '../../_lib/session.js';
import { ok, err }       from '../../_lib/response.js';
import { hashidsEncode } from '../../_lib/hashids.js';

const RS_DEVICE_UUID = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';
const DEPOSIT_TTL    = 3 * 60; // 3 minutes

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

function getCardId(offer) {
  return offer.cardId ?? offer.card?.id ?? offer.card_id ??
         offer.marketplaceCardId ?? offer.item?.id ?? offer.itemId ??
         (Array.isArray(offer.linkedCardIds) && offer.linkedCardIds[0]) ?? null;
}

async function fetchOffers(authInfo, sessionToken, view, status) {
  const all = [];
  for (let page = 0; page < 5; page++) {
    const offset = page * 10;
    let res;
    try {
      res = await fetch(
        `https://web.realapp.com/cardmarketplace/user/offers?offset=${offset}&status=${status}&view=${view}`,
        { headers: buildHeaders(authInfo, sessionToken), signal: AbortSignal.timeout(6000) }
      );
    } catch { break; }
    if (!res.ok) break;
    let data;
    try { data = await res.json(); } catch { break; }
    const offers = Array.isArray(data) ? data : (data.offers || []);
    if (!offers.length) break;
    all.push(...offers);
    if (offers.length < 10) break;
  }
  return all;
}

async function acceptOffer(offerId, authInfo, sessionToken) {
  try {
    const res = await fetch(`https://web.realapp.com/cardmarketplaceoffers/${offerId}/accept`, {
      method:  'PUT',
      headers: buildHeaders(authInfo, sessionToken),
      body:    JSON.stringify({}),
      signal:  AbortSignal.timeout(10000),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function counterOffer(offerId, amount, authInfo, sessionToken) {
  try {
    const res = await fetch(`https://web.realapp.com/cardmarketplaceoffers/${offerId}/counter`, {
      method:  'PUT',
      headers: buildHeaders(authInfo, sessionToken),
      body:    JSON.stringify({ counterAmount: amount }),
      signal:  AbortSignal.timeout(10000),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function handleRequest({ request, env, userId }) {
  const now        = Math.floor(Date.now() / 1000);
  const authInfo   = env.EDGEBOT_AUTH_INFO;
  const sessionTok = env.EDGEBOT_SESSION_TOKEN || '';
  if (!authInfo) return err('EDGEBOT_AUTH_INFO not configured', 500);

  // Load pending deposits — scoped to one user if called by user, all if called by cron
  const pendingQuery = userId
    ? "SELECT * FROM casino_deposits WHERE user_id=? AND status='pending'"
    : "SELECT * FROM casino_deposits WHERE status='pending'";
  const pendingRows = userId
    ? await env.DB.prepare(pendingQuery).bind(userId).all()
    : await env.DB.prepare(pendingQuery).all();
  const pending = pendingRows.results || [];
  if (!pending.length) return ok({ confirmed: false, checked: 0, credited: 0 });

  // Build card → deposit lookup
  const cardMap = {};
  for (const dep of pending) {
    if (dep.card_id) cardMap[dep.card_id] = dep;
  }

  // Fetch edgebot's incoming offers (open + accepted) in parallel
  const [incomingOpen, incomingAccepted] = await Promise.all([
    fetchOffers(authInfo, sessionTok, 'incoming', 'open'),
    fetchOffers(authInfo, sessionTok, 'incoming', 'accepted'),
  ]);

  let confirmed = 0;
  let credited  = 0;
  const errors  = [];

  // Phase 1: accepted offers — credit balance
  for (const offer of incomingAccepted) {
    const cardId = getCardId(offer);
    if (!cardId) continue;
    const dep = cardMap[Number(cardId)] ?? cardMap[cardId];
    if (!dep) continue;

    // Guard: ensure this RS offer ID was never credited to any deposit before.
    // Accepted offers persist in RS history, so the same offer can match a new
    // deposit on the same card if the card is recycled. This prevents that.
    const alreadyUsed = await env.DB.prepare(
      "SELECT id FROM casino_deposits WHERE rs_offer_id=? AND status='confirmed' LIMIT 1"
    ).bind(String(offer.id)).first();
    if (alreadyUsed) continue;

    const amount = Math.max(
      offer.counterAmount ?? 0,
      offer.amount        ?? 0,
      offer.offerAmount   ?? 0,
    );
    // Require a real non-zero offer amount — never fall back to dep.rax_requested
    if (!amount || amount <= 0) continue;
    const raxCredited = Math.floor(amount * 0.9);

    // Idempotency: only credit if still pending
    const updated = await env.DB.prepare(
      "UPDATE casino_deposits SET status='confirmed', rax_credited=?, rs_offer_id=? WHERE id=? AND status='pending'"
    ).bind(raxCredited, String(offer.id), dep.id).run();

    if (updated.meta.changes > 0) {
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET casino_balance = casino_balance + ? WHERE id = ?')
          .bind(raxCredited, dep.user_id),
        env.DB.prepare('DELETE FROM deposit_cards WHERE card_id=?')
          .bind(dep.card_id),
      ]);
      confirmed++;
      credited += raxCredited;
    }
  }

  // Phase 2: open offers — accept if exact/over, counter if under
  for (const offer of incomingOpen) {
    const cardId = getCardId(offer);
    if (!cardId) continue;
    const dep = cardMap[Number(cardId)] ?? cardMap[cardId];
    if (!dep) continue;

    // Guard: same offer-ID reuse protection as Phase 1
    const alreadyUsed = await env.DB.prepare(
      "SELECT id FROM casino_deposits WHERE rs_offer_id=? AND status='confirmed' LIMIT 1"
    ).bind(String(offer.id)).first();
    if (alreadyUsed) continue;

    const amount = offer.counterAmount ?? offer.amount ?? offer.offerAmount;
    if (!amount || amount <= 0) continue;

    if (amount >= dep.rax_requested) {
      const result = await acceptOffer(offer.id, authInfo, sessionTok);
      if (!result.ok) { errors.push({ offerId: offer.id, action: 'accept', status: result.status }); continue; }
      const raxCredited = Math.floor(amount * 0.9);
      const updated = await env.DB.prepare(
        "UPDATE casino_deposits SET status='confirmed', rax_credited=?, rs_offer_id=? WHERE id=? AND status='pending'"
      ).bind(raxCredited, String(offer.id), dep.id).run();
      if (updated.meta.changes > 0) {
        await env.DB.batch([
          env.DB.prepare('UPDATE users SET casino_balance = casino_balance + ? WHERE id = ?')
            .bind(raxCredited, dep.user_id),
          env.DB.prepare('DELETE FROM deposit_cards WHERE card_id=?')
            .bind(dep.card_id),
        ]);
        confirmed++;
        credited += raxCredited;
      }
    } else {
      // Under deposit amount — counter at exact amount
      const result = await counterOffer(offer.id, dep.rax_requested, authInfo, sessionTok);
      if (!result.ok) errors.push({ offerId: offer.id, action: 'counter', status: result.status });
    }
  }

  // Expire stale pending deposits (> 3 min old)
  const toExpire = pending
    .filter(dep => (now - dep.created_at) > DEPOSIT_TTL)
    .map(dep => dep.id);
  if (toExpire.length) {
    const ph = toExpire.map(() => '?').join(',');
    await env.DB.prepare(
      `UPDATE casino_deposits SET status='expired' WHERE id IN (${ph}) AND status='pending'`
    ).bind(...toExpire).run();
  }

  return ok({
    confirmed,
    credited,
    checked: incomingOpen.length + incomingAccepted.length,
    expired: toExpire.length,
    errors,
  });
}

export async function onRequestGet({ request, env }) {
  const url     = new URL(request.url);
  const cronKey = url.searchParams.get('_cron_key');

  // Cron call — processes all pending deposits
  if (cronKey && env.CRON_SECRET && cronKey === env.CRON_SECRET) {
    return handleRequest({ request, env, userId: null });
  }

  // User call — processes only their own pending deposit
  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);
  return handleRequest({ request, env, userId: session.user_id });
}
