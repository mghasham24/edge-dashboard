// functions/api/parlays/deposit-check.js
// POST /api/parlays/deposit-check?_cron_key=CRON_SECRET
// Polls @edgebot's incoming RS card offers, accepts ones matching pending parlays.
// Called every 60s by alert-cron.
//
// Flow:
//   1. Expire parlays whose 30-min window elapsed (sets status='expired')
//   2. Release deposit cards from expired/voided parlays
//   3. Fetch edgebot's open incoming offers from RS
//   4. Match each offer: offer.cardId → assigned parlay, offer.offerAmount === stake_rax
//   5. Accept matching offer via RS PUT endpoint
//   6. Mark parlay status='active', store offer ID + received_rax

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

async function fetchOffers(authInfo, sessionToken, view, status) {
  const res = await fetch(
    `https://web.realapp.com/cardmarketplace/user/offers?offset=0&status=${status}&view=${view}`,
    { headers: buildHeaders(authInfo, sessionToken), signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : (data.offers || []);
}

async function acceptOffer(offerId, authInfo, sessionToken) {
  const res = await fetch(
    `https://web.realapp.com/cardmarketplaceoffers/${offerId}/accept`,
    {
      method:  'PUT',
      headers: buildHeaders(authInfo, sessionToken),
      body:    JSON.stringify({}),
      signal:  AbortSignal.timeout(10000),
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
      signal:  AbortSignal.timeout(10000),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, body: body.slice(0, 300) };
  }
  return { ok: true };
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  if (!env.CRON_SECRET || url.searchParams.get('_cron_key') !== env.CRON_SECRET) {
    return err('Unauthorized', 401);
  }

  const authInfo     = env.EDGEBOT_AUTH_INFO;
  const sessionToken = env.EDGEBOT_SESSION_TOKEN || '';
  if (!authInfo) return err('EDGEBOT_AUTH_INFO not configured', 500);

  const now = Math.floor(Date.now() / 1000);

  // Load pending parlays first — include a 5-min grace window past expires_at so that
  // counter-offers accepted right at the deadline are still caught before the parlay expires.
  // (Expiry happens AFTER we process offers, not before.)
  const GRACE = 5 * 60;
  const pendingRows = await env.DB.prepare(
    'SELECT id, stake_rax, deposit_card_id FROM parlays WHERE status=? AND expires_at > ?'
  ).bind('pending_deposit', now - GRACE).all();

  const pending = pendingRows.results || [];

  // Build lookup: cardId → { parlayId, stakeRax, expired }
  const cardMap = {};
  for (const row of pending) {
    if (row.deposit_card_id) {
      cardMap[row.deposit_card_id] = {
        parlayId: row.id,
        stakeRax: row.stake_rax,
        expired:  row.expires_at < now, // true if past window but within grace
      };
    }
  }

  // Fetch ALL pending_deposit parlays (no expiry filter) for the completed-offer backfill.
  // This catches parlays where a counter-offer completed after the 30-min window elapsed.
  const allPendingRows = await env.DB.prepare(
    "SELECT id, stake_rax, deposit_card_id, expires_at FROM parlays WHERE status='pending_deposit'"
  ).all();
  const allPending = allPendingRows.results || [];

  // Full map (all pending, regardless of expiry) — used only for outgoing/accepted matching
  const fullMap = {};
  for (const row of allPending) {
    if (row.deposit_card_id) fullMap[row.deposit_card_id] = { parlayId: row.id, stakeRax: row.stake_rax };
  }

  // Expired map: parlays that expired within the last 24 hours.
  // If Rax was sent but the cron missed the accepted offer window, we reactivate them here.
  const recentExpiredRows = await env.DB.prepare(
    "SELECT id, stake_rax, deposit_card_id FROM parlays WHERE status='expired' AND expires_at > ?"
  ).bind(now - 24 * 3600).all();
  const expiredMap = {};
  for (const row of (recentExpiredRows.results || [])) {
    if (row.deposit_card_id) expiredMap[row.deposit_card_id] = { parlayId: row.id, stakeRax: row.stake_rax };
  }

  const debug = url.searchParams.has('debug');
  let incomingOpen, incomingAccepted, outgoingAccepted, outgoingRejected, outgoingOpen;
  try {
    [incomingOpen, incomingAccepted, outgoingAccepted, outgoingRejected, outgoingOpen] = await Promise.all([
      fetchOffers(authInfo, sessionToken, 'incoming', 'open'),
      fetchOffers(authInfo, sessionToken, 'incoming', 'accepted'),
      fetchOffers(authInfo, sessionToken, 'outgoing', 'accepted'),
      fetchOffers(authInfo, sessionToken, 'outgoing', 'rejected'),
      fetchOffers(authInfo, sessionToken, 'outgoing', 'open'),
    ]);
  } catch (e) { return err('RS fetch error: ' + e.message, 502); }

  if (debug) {
    const scans = await Promise.all([
      ['incoming','open'],['incoming','accepted'],['incoming','rejected'],['incoming','expired'],
      ['outgoing','open'],['outgoing','accepted'],['outgoing','rejected'],['outgoing','expired'],
    ].map(async ([view, status]) => {
      const list = await fetchOffers(authInfo, sessionToken, view, status);
      const relevant = list.filter(o => fullMap[o.cardId]);
      return { view, status, count: list.length, relevant: relevant.map(o => ({ id: o.id, cardId: o.cardId, amount: o.amount, status: o.status })) };
    }));
    return new Response(JSON.stringify({ pending: allPending.map(p => ({ id: p.id, stake_rax: p.stake_rax, deposit_card_id: p.deposit_card_id, expires_at: p.expires_at })), cardMap, fullMap, scans }, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }

  // Build deduplicated offer list: incoming open/accepted + outgoing accepted
  const seen = new Set();
  const offers = [...incomingOpen, ...incomingAccepted, ...outgoingAccepted].filter(o => {
    if (seen.has(o.id)) return false;
    seen.add(o.id);
    return true;
  });

  let accepted = 0;
  let countered = 0;
  const errors = [];

  async function activateParlay(parlayId, cardId, offerId, amount) {
    const receivedRax = Math.floor(amount * 0.9);
    await env.DB.prepare(
      "UPDATE parlays SET status='active', rs_offer_id=?, received_rax=?, deposited_at=? WHERE id=? AND status IN ('pending_deposit','expired')"
    ).bind(offerId, receivedRax, now, parlayId).run();
    await env.DB.prepare('DELETE FROM deposit_cards WHERE card_id=?').bind(cardId).run();
  }

  for (const offer of offers) {
    const cardId  = offer.cardId;
    const offerId = offer.id;

    if (!cardId || !offerId) continue;

    const alreadyAccepted = offer.status === 'accepted' || offer.status === 'completed';

    // Check active pending first; fall back to recently expired if the offer is accepted
    const match = cardMap[cardId] || (alreadyAccepted ? expiredMap[cardId] : null);
    if (!match) continue;

    // RS clears counterAmount after acceptance, leaving only the original offer amount.
    // Don't gate on stakeRax here — if RS says accepted, the deal is settled on their side.
    if (alreadyAccepted) {
      // RS clears counterAmount after acceptance — use stakeRax as floor since edgebot
      // always counter-offers to exactly stakeRax before the user can accept.
      const effectiveAmount = Math.max(
        offer.counterAmount ?? 0,
        offer.amount       ?? 0,
        offer.offerAmount  ?? 0,
        match.stakeRax,
      );
      await activateParlay(match.parlayId, cardId, offerId, effectiveAmount);
      accepted++;
      continue;
    }

    const fromExpired = !cardMap[cardId] && !!expiredMap[cardId];
    const amount = offer.counterAmount ?? offer.amount ?? offer.offerAmount;
    if (!amount) continue;

    if (amount < match.stakeRax) {
      if (fromExpired) continue;
      let counterResult;
      try { counterResult = await counterOffer(offerId, match.stakeRax, authInfo, sessionToken); }
      catch (e) { errors.push({ offerId, action: 'counter', error: e.message }); continue; }
      if (counterResult.ok) countered++;
      else errors.push({ offerId, action: 'counter', error: `RS ${counterResult.status}: ${counterResult.body}` });
      continue;
    }

    let rsResult;
    try { rsResult = await acceptOffer(offerId, authInfo, sessionToken); }
    catch (e) { errors.push({ offerId, action: 'accept', error: e.message }); continue; }
    if (!rsResult.ok) { errors.push({ offerId, action: 'accept', error: `RS ${rsResult.status}: ${rsResult.body}` }); continue; }

    await activateParlay(match.parlayId, cardId, offerId, amount);
    accepted++;
  }

  // Backfill: scan outgoing/accepted against ALL pending_deposit AND recently expired parlays.
  // Catches counter-offers the user accepted after the 30-min window elapsed,
  // including parlays that were already expired in D1 when the offer was detected.
  for (const offer of outgoingAccepted) {
    const cardId = offer.cardId;
    const amount = offer.counterAmount ?? offer.amount ?? offer.offerAmount;
    if (!cardId || !amount) continue;
    const match = fullMap[cardId] || expiredMap[cardId];
    if (!match) continue;
    if (seen.has(offer.id)) continue; // already processed above
    if (amount < match.stakeRax) continue;
    await activateParlay(match.parlayId, cardId, offer.id, amount);
    accepted++;
  }

  // If user rejected edgebot's counter-offer, void the parlay and free the card immediately
  // so they can place again rather than waiting 30 min for expiry.
  for (const offer of outgoingRejected) {
    const cardId = offer.cardId;
    if (!cardId) continue;
    const match = fullMap[cardId];
    if (!match) continue;
    await env.DB.batch([
      env.DB.prepare("UPDATE parlays SET status='void', admin_notes='counter_rejected' WHERE id=? AND status='pending_deposit'").bind(match.parlayId),
      env.DB.prepare("DELETE FROM deposit_cards WHERE card_id=?").bind(cardId),
    ]);
  }

  // Expiry: skip any parlay whose deposit card has an active RS offer (open counter or accepted).
  // This prevents expiring a parlay when the user accepted edgebot's counter but the
  // offer hasn't been processed yet. Also add a 90-min buffer so we have plenty of
  // time to detect late RS state transitions before permanently expiring.
  const protectedCards = new Set([
    ...outgoingOpen.map(o => o.cardId),
    ...outgoingAccepted.map(o => o.cardId),
    ...incomingAccepted.map(o => o.cardId),
  ].filter(Boolean));

  const EXPIRE_BUFFER = 90 * 60; // only expire 90 min after the 30-min window closes
  const toExpireIds = allPending
    .filter(p => p.expires_at < (now - EXPIRE_BUFFER) && !protectedCards.has(p.deposit_card_id))
    .map(p => p.id);

  if (toExpireIds.length) {
    const ph = toExpireIds.map(() => '?').join(',');
    await env.DB.prepare(
      `UPDATE parlays SET status='expired' WHERE id IN (${ph}) AND status='pending_deposit'`
    ).bind(...toExpireIds).run();
  }
  await env.DB.prepare(
    "DELETE FROM deposit_cards WHERE assigned_to_parlay_id IN (SELECT id FROM parlays WHERE status IN ('expired','void'))"
  ).run();

  const result = { ts: now, checked: offers.length, accepted, countered, pending: pending.length, errors };
  try {
    await env.DB.prepare(
      'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
    ).bind('deposit_check_debug', JSON.stringify(result), now).run();
  } catch(e) {}
  return ok(result);
}
