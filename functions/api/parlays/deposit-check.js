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

  // 1. Expire parlays whose 30-min deposit window has passed
  await env.DB.prepare(
    "UPDATE parlays SET status='expired' WHERE status='pending_deposit' AND expires_at < ?"
  ).bind(now).run();

  // 2. Release deposit cards from expired or voided parlays
  await env.DB.prepare(
    "UPDATE deposit_cards SET assigned_to_parlay_id=NULL, assigned_at=NULL, freed_at=? " +
    "WHERE assigned_to_parlay_id IN (" +
    "  SELECT id FROM parlays WHERE status IN ('expired','void')" +
    ")"
  ).bind(now).run();

  // 3. Load all currently pending parlays waiting for deposit
  const pendingRows = await env.DB.prepare(
    'SELECT id, stake_rax, deposit_card_id FROM parlays WHERE status=? AND expires_at > ?'
  ).bind('pending_deposit', now).all();

  const pending = pendingRows.results || [];
  if (!pending.length) {
    try { await env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at').bind('deposit_check_debug', JSON.stringify({ ts: now, checked: 0, accepted: 0, countered: 0, pending: 0, note: 'no_pending_parlays' }), now).run(); } catch(e) {}
    return ok({ checked: 0, accepted: 0, pending: 0 });
  }

  // Build lookup: cardId → { parlayId, stakeRax }
  const cardMap = {};
  for (const row of pending) {
    if (row.deposit_card_id) cardMap[row.deposit_card_id] = { parlayId: row.id, stakeRax: row.stake_rax };
  }

  // 4. Fetch offers from RS:
  //   - open incoming: normal underpaid/exact offers from users
  //   - accepted outgoing: edgebot's counter-offers that the user accepted
  const debug = url.searchParams.has('debug');
  let offers;
  try {
    const [incomingOpen, incomingAccepted] = await Promise.all([
      fetchOffers(authInfo, sessionToken, 'incoming', 'open'),
      fetchOffers(authInfo, sessionToken, 'incoming', 'accepted'),
    ]);
    // Dedupe by offer ID — an offer shouldn't appear in both, but guard anyway
    const seen = new Set();
    offers = [...incomingOpen, ...incomingAccepted].filter(o => {
      if (seen.has(o.id)) return false;
      seen.add(o.id);
      return true;
    });
  } catch (e) { return err('RS fetch error: ' + e.message, 502); }

  if (debug) {
    const scans = await Promise.all([
      ['incoming','open'],['incoming','accepted'],['incoming','countered'],['incoming','completed'],
      ['outgoing','open'],['outgoing','accepted'],['outgoing','countered'],['outgoing','completed'],
    ].map(async ([view, status]) => {
      const list = await fetchOffers(authInfo, sessionToken, view, status);
      const relevant = list.filter(o => cardMap[o.cardId]);
      return { view, status, count: list.length, relevant: relevant.map(o => ({ id: o.id, cardId: o.cardId, amount: o.amount, status: o.status })) };
    }));
    return new Response(JSON.stringify({ pending: pending.map(p => ({ id: p.id, stake_rax: p.stake_rax, deposit_card_id: p.deposit_card_id })), cardMap, scans }, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }

  let accepted = 0;
  let countered = 0;
  const errors = [];

  for (const offer of offers) {
    const cardId  = offer.cardId;
    // counterAmount is the final agreed amount when edgebot countered; fall back to original amount
    const amount  = offer.counterAmount ?? offer.amount ?? offer.offerAmount;
    const offerId = offer.id;

    if (!cardId || !amount || !offerId) continue;

    const match = cardMap[cardId];
    if (!match) continue; // not one of our assigned cards — ignore

    const alreadyAccepted = offer.status === 'accepted';

    if (amount < match.stakeRax) {
      // Already-accepted offers below stake are stale completed trades from a previous parlay on this card — skip
      if (alreadyAccepted) continue;
      // Open underpaid offer — counter with the exact stake so the user can accept or walk away
      let counterResult;
      try { counterResult = await counterOffer(offerId, match.stakeRax, authInfo, sessionToken); }
      catch (e) { errors.push({ offerId, action: 'counter', error: e.message }); continue; }
      if (counterResult.ok) countered++;
      else errors.push({ offerId, action: 'counter', error: `RS ${counterResult.status}: ${counterResult.body}` });
      continue; // parlay stays pending_deposit until they accept the counter
    }
    if (!alreadyAccepted) {
      // Exact match or overpaid incoming offer — accept it (sender takes the loss on any extra)
      let rsResult;
      try { rsResult = await acceptOffer(offerId, authInfo, sessionToken); }
      catch (e) { errors.push({ offerId, action: 'accept', error: e.message }); continue; }
      if (!rsResult.ok) { errors.push({ offerId, action: 'accept', error: `RS ${rsResult.status}: ${rsResult.body}` }); continue; }
    }

    // Mark parlay active — record the actual amount sent (receiver gets 90% after RS fee)
    const receivedRax = Math.floor(amount * 0.9);

    await env.DB.prepare(
      "UPDATE parlays SET status='active', rs_offer_id=?, received_rax=?, deposited_at=? WHERE id=?"
    ).bind(offerId, receivedRax, now, match.parlayId).run();

    // Card sold to user — permanently remove from pool (edgebot no longer owns it after the deposit)
    await env.DB.prepare('DELETE FROM deposit_cards WHERE card_id=?').bind(cardId).run();

    accepted++;
  }

  const result = { ts: now, checked: offers.length, accepted, countered, pending: pending.length, errors };
  try {
    await env.DB.prepare(
      'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
    ).bind('deposit_check_debug', JSON.stringify(result), now).run();
  } catch(e) {}
  return ok(result);
}
