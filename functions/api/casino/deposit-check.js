// functions/api/casino/deposit-check.js
// GET /api/casino/deposit-check?_cron_key=CRON_SECRET  — cron: process all pending deposits
// GET /api/casino/deposit-check                         — user session: check own pending deposit
//
// Mirrors parlays/deposit-check.js structure exactly:
//   Phase 0b: card ownership check (most reliable signal — fires when card transfers)
//   Phase 1:  incoming/accepted + outgoing/accepted (counter-offer completions)
//   Phase 2:  incoming/open — counter if under, accept if ≥ rax_requested
//   Expiry:   deposits > DEPOSIT_TTL with no active outgoing offers

import { getSession }    from '../../_lib/session.js';
import { ok, err }       from '../../_lib/response.js';
import { hashidsEncode } from '../../_lib/hashids.js';

const RS_DEVICE_UUID = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';
const EDGEBOT_USER   = 'V3yGgkkJ';
const DEPOSIT_TTL    = 3 * 60; // 3 minutes — matches deposit.js

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

// RS may return the card ID under different field names.
function getCardId(offer) {
  return offer.cardId ?? offer.card?.id ?? offer.card_id ??
         offer.marketplaceCardId ?? offer.marketplace_card_id ??
         offer.item?.id ?? offer.itemId ?? offer.listingCardId ??
         offer.cardMarketplaceId ??
         (Array.isArray(offer.linkedCardIds) && offer.linkedCardIds.length > 0 ? offer.linkedCardIds[0] : null) ??
         null;
}

// Paginate RS offers. Mirrors parlays/deposit-check.js.
async function fetchOffers(authInfo, sessionToken, view, status) {
  const maxPages = status === 'accepted' ? 10 : 1;
  const cutoff   = Date.now() - 86400000; // 24h ago
  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const offset = page * 10;
    let res;
    const ac = new AbortController();
    const abortTimer = setTimeout(() => ac.abort(), 6000);
    try {
      res = await fetch(
        `https://web.realapp.com/cardmarketplace/user/offers?offset=${offset}&status=${status}&view=${view}`,
        { headers: buildHeaders(authInfo, sessionToken), signal: ac.signal }
      );
      clearTimeout(abortTimer);
    } catch { clearTimeout(abortTimer); break; }
    if (res.status === 401 || res.status === 403) throw new Error('RS auth ' + res.status + ' — session token expired');
    if (!res.ok) break;
    let data;
    try {
      const text = await Promise.race([
        res.text(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('body timeout')), 5000)),
      ]);
      data = JSON.parse(text);
    } catch { break; }
    const offers = Array.isArray(data) ? data : (data.offers || []);
    if (!offers.length) break;
    all.push(...offers);
    if (offers.length < 10) break;
    const oldest = offers[offers.length - 1];
    const ts = oldest?.statusChangedAt || oldest?.createdAt || oldest?.updatedAt;
    if (ts && new Date(ts).getTime() < cutoff) break;
  }
  return all;
}

async function acceptOffer(offerId, authInfo, sessionToken) {
  const res = await fetch(
    `https://web.realapp.com/cardmarketplaceoffers/${offerId}/accept`,
    {
      method:  'PUT',
      headers: buildHeaders(authInfo, sessionToken),
      body:    JSON.stringify({}),
      signal:  (() => { const c = new AbortController(); setTimeout(() => c.abort(), 10000); return c.signal; })(),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, body: body.slice(0, 300) };
  }
  return { ok: true };
}

async function counterOffer(offerId, counterAmount, authInfo, sessionToken) {
  const res = await fetch(
    `https://web.realapp.com/cardmarketplaceoffers/${offerId}/counter`,
    {
      method:  'PUT',
      headers: buildHeaders(authInfo, sessionToken),
      body:    JSON.stringify({ counterAmount }),
      signal:  (() => { const c = new AbortController(); setTimeout(() => c.abort(), 10000); return c.signal; })(),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, body: body.slice(0, 300) };
  }
  return { ok: true };
}

// Fetch the current owner of a single card. Returns RS userId string or null.
async function fetchCardOwner(cardId, authInfo, sessionToken) {
  try {
    const res = await fetch(
      `https://web.realapp.com/collectingcards/${cardId}`,
      { headers: buildHeaders(authInfo, sessionToken), signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })() }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.card?.userId ?? data?.card?.user?.id ?? null;
  } catch { return null; }
}

async function handleRequest({ request, env, userId }) {
  const now        = Math.floor(Date.now() / 1000);
  const authInfo   = env.EDGEBOT_AUTH_INFO;
  const sessionTok = env.EDGEBOT_SESSION_TOKEN || '';
  if (!authInfo) return err('EDGEBOT_AUTH_INFO not configured', 500);

  // Load all pending deposits — scoped to one user if called by user, all if called by cron
  const pendingQuery = userId
    ? "SELECT * FROM casino_deposits WHERE user_id=? AND status='pending'"
    : "SELECT * FROM casino_deposits WHERE status='pending'";
  const pendingRows = userId
    ? await env.DB.prepare(pendingQuery).bind(userId).all()
    : await env.DB.prepare(pendingQuery).all();
  const pending = pendingRows.results || [];

  // Also load recently-expired deposits (within 24h) — reactivate if offer arrives late.
  const expiredRows = userId ? { results: [] } : await env.DB.prepare(
    "SELECT * FROM casino_deposits WHERE status='expired' AND created_at > ?"
  ).bind(now - 24 * 3600).all();
  const recentExpired = expiredRows.results || [];

  if (!pending.length && !recentExpired.length) {
    return ok({ confirmed: false, checked: 0, credited: 0 });
  }

  // Build card → deposit lookup maps
  const cardMap    = {}; // pending deposits
  const expiredMap = {}; // recently-expired deposits (for late-offer resurrection)
  for (const dep of pending)       if (dep.card_id) cardMap[dep.card_id]    = dep;
  for (const dep of recentExpired) if (dep.card_id) expiredMap[dep.card_id] = dep;

  const errors  = [];
  let confirmed = 0;
  let credited  = 0;

  // ── activateDeposit ──────────────────────────────────────────────────────────
  // Credits the user and marks deposit confirmed. Mirrors parlays activateParlay.
  async function activateDeposit(dep, cardId, offerId, amount) {
    if (!amount || amount <= 0) return;

    // Guard: same offer ID must never credit two deposits
    if (offerId) {
      const alreadyUsed = await env.DB.prepare(
        "SELECT id FROM casino_deposits WHERE rs_offer_id=? AND status='confirmed' LIMIT 1"
      ).bind(String(offerId)).first();
      if (alreadyUsed) return;
    }

    const raxCredited = Math.floor(amount * 0.9);
    const updated = await env.DB.prepare(
      "UPDATE casino_deposits SET status='confirmed', rax_credited=?, rs_offer_id=? WHERE id=? AND status IN ('pending','expired')"
    ).bind(raxCredited, offerId ? String(offerId) : null, dep.id).run();

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

  // ── Phase 0b: Card ownership check ──────────────────────────────────────────
  // Most reliable signal — card transfers to user the moment they accept any offer.
  // Cap at 15 cards to stay within CF 30s wall-clock.
  const ownershipRows = [...pending, ...recentExpired]
    .filter(dep => dep.card_id != null)
    .slice(0, 15);

  for (const dep of ownershipRows) {
    const ownerId = await fetchCardOwner(dep.card_id, authInfo, sessionTok);
    if (ownerId !== null && ownerId !== EDGEBOT_USER) {
      // Card left edgebot — use rax_requested as the amount (offer amount may not be known yet)
      await activateDeposit(dep, dep.card_id, null, dep.rax_requested);
    }
  }

  // ── Fetch all RS offer views ─────────────────────────────────────────────────
  let incomingOpen, incomingAccepted, outgoingAccepted, outgoingRejected, outgoingOpen;
  const hardTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('RS fetch hard timeout 25s')), 25000));
  try {
    const settled = await Promise.race([
      Promise.allSettled([
        fetchOffers(authInfo, sessionTok, 'incoming', 'open'),
        fetchOffers(authInfo, sessionTok, 'incoming', 'accepted'),
        fetchOffers(authInfo, sessionTok, 'outgoing', 'accepted'),
        fetchOffers(authInfo, sessionTok, 'outgoing', 'rejected'),
        fetchOffers(authInfo, sessionTok, 'outgoing', 'open'),
      ]),
      hardTimeout,
    ]);
    const authFail = settled.find(r => r.status === 'rejected' && r.reason?.message?.startsWith('RS auth'));
    if (authFail) throw authFail.reason;
    [incomingOpen, incomingAccepted, outgoingAccepted, outgoingRejected, outgoingOpen] =
      settled.map(r => r.status === 'fulfilled' ? r.value : []);
  } catch (e) {
    return err('RS fetch error: ' + e.message, 502);
  }

  // ── Phase 1: Settled offers (incoming/accepted + outgoing/accepted for counters) ──
  // Only process outgoing/accepted for cards that match a known deposit
  // (avoids treating payout offers as deposits).
  const trackedOfferIds = new Set(
    [...pending, ...recentExpired].filter(d => d.rs_offer_id != null).map(d => d.rs_offer_id)
  );
  const allCardIds = new Set([...Object.keys(cardMap), ...Object.keys(expiredMap)].map(Number));
  const depositCardOutgoing = (outgoingAccepted || []).filter(o => {
    const cid = getCardId(o);
    if (!cid || !o.id) return false;
    if (!allCardIds.has(Number(cid))) return false;
    return trackedOfferIds.has(o.id);
  });

  const seenSettled = new Set();
  const allSettled  = [...(incomingAccepted || []), ...depositCardOutgoing].filter(o => {
    if (!o.id || seenSettled.has(o.id)) return false;
    seenSettled.add(o.id);
    return true;
  });

  for (const offer of allSettled) {
    const cardId = getCardId(offer);
    if (!cardId) continue;
    const dep = cardMap[Number(cardId)] ?? cardMap[cardId] ?? expiredMap[Number(cardId)] ?? expiredMap[cardId];
    if (!dep) continue;

    const amount = Math.max(
      offer.counterAmount ?? 0,
      offer.amount        ?? 0,
      offer.offerAmount   ?? 0,
      dep.rax_requested,
    );
    await activateDeposit(dep, cardId, offer.id, amount);
  }

  // ── Phase 2: Open offers — counter if under, accept if ≥ rax_requested ──────
  for (const offer of (incomingOpen || [])) {
    if (seenSettled.has(offer.id)) continue;
    const cardId = getCardId(offer);
    if (!cardId) continue;
    const dep = cardMap[Number(cardId)] ?? cardMap[cardId];
    if (!dep) continue;

    const amount = offer.counterAmount ?? offer.amount ?? offer.offerAmount;
    if (!amount || amount <= 0) continue;

    if (amount < dep.rax_requested) {
      const result = await counterOffer(offer.id, dep.rax_requested, authInfo, sessionTok);
      if (result.ok) {
        // Store offer ID so Phase 1 can find it by direct card match next run
        await env.DB.prepare(
          "UPDATE casino_deposits SET rs_offer_id=? WHERE id=? AND rs_offer_id IS NULL"
        ).bind(String(offer.id), dep.id).run();
      } else {
        errors.push({ offerId: offer.id, action: 'counter', error: `RS ${result.status}: ${result.body}` });
      }
    } else {
      const result = await acceptOffer(offer.id, authInfo, sessionTok);
      if (!result.ok) { errors.push({ offerId: offer.id, action: 'accept', error: `RS ${result.status}: ${result.body}` }); continue; }
      await activateDeposit(dep, cardId, offer.id, amount);
    }
  }

  // ── Handle rejected counter-offers: void deposit, free card immediately ──────
  for (const offer of (outgoingRejected || [])) {
    const cardId = getCardId(offer);
    if (!cardId) continue;
    const dep = cardMap[Number(cardId)] ?? cardMap[cardId];
    if (!dep) continue;
    await env.DB.batch([
      env.DB.prepare("UPDATE casino_deposits SET status='expired' WHERE id=? AND status='pending'").bind(dep.id),
      env.DB.prepare('DELETE FROM deposit_cards WHERE card_id=?').bind(dep.card_id),
    ]);
  }

  // ── Expire stale pending deposits — skip if outgoing offer is still active ───
  const protectedCards = new Set([
    ...(outgoingOpen     || []).map(o => getCardId(o)),
    ...(outgoingAccepted || []).map(o => getCardId(o)),
    ...(incomingAccepted || []).map(o => getCardId(o)),
  ].filter(Boolean).map(Number));

  const toExpire = pending.filter(dep =>
    (now - dep.created_at) > DEPOSIT_TTL &&
    !protectedCards.has(Number(dep.card_id))
  );
  if (toExpire.length) {
    const ph = toExpire.map(() => '?').join(',');
    await env.DB.prepare(
      `UPDATE casino_deposits SET status='expired' WHERE id IN (${ph}) AND status='pending'`
    ).bind(...toExpire.map(d => d.id)).run();
  }

  return ok({
    confirmed,
    credited,
    checked: allSettled.length + (incomingOpen || []).length,
    expired: toExpire.length,
    errors,
  });
}

export async function onRequestGet({ request, env }) {
  const url     = new URL(request.url);
  const cronKey = url.searchParams.get('_cron_key');

  if (cronKey && env.CRON_SECRET && cronKey === env.CRON_SECRET) {
    return handleRequest({ request, env, userId: null });
  }

  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);
  return handleRequest({ request, env, userId: session.user_id });
}
