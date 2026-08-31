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
import { getSession }   from '../../_lib/session.js';
import { ok, err }       from '../../_lib/response.js';

const RS_DEVICE_UUID    = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';

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

// Paginate RS offers. For accepted views the offer can be many pages back (offset=30+ has happened).
// We paginate up to 200 offers (20 pages) and stop when all offers on a page are older than 24h.
async function fetchOffers(authInfo, sessionToken, view, status) {
  const maxPages = status === 'accepted' ? 10 : 1;
  const cutoff   = Date.now() - 86400000; // 24h ago — don't look further back
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
    if (offers.length < 10) break; // partial page = last page
    // Stop when the oldest offer on this page is beyond our 24h window
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

// Fetch the current owner of a single card via its detail endpoint.
// Returns the RS userId string of whoever owns the card, or null on failure.
const EDGEBOT_USER = 'V3yGgkkJ';
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

async function handleRequest({ request, env }) {
  const url = new URL(request.url);
  const cronOk = env.CRON_SECRET && url.searchParams.get('_cron_key') === env.CRON_SECRET;
  const debug  = url.searchParams.has('debug');

  if (!cronOk) {
    if (debug) {
      // Allow admin session for read-only debug scan
      const session = await getSession(request, env.DB);
      const user = session
        ? await env.DB.prepare('SELECT is_admin FROM users WHERE id=?').bind(session.user_id).first()
        : null;
      if (!user?.is_admin) return err('Unauthorized', 401);
    } else {
      return err('Unauthorized', 401);
    }
  }

  const now = Math.floor(Date.now() / 1000);

  const authInfo = env.EDGEBOT_AUTH_INFO;
  const sessionToken = env.EDGEBOT_SESSION_TOKEN || '';
  if (!authInfo) return err('EDGEBOT_AUTH_INFO not configured', 500);

  // GRACE must match EXPIRE_BUFFER: parlays stay in cardMap until the cron actually expires
  // them in D1, so there's no window where an accepted offer is invisible to the matcher.
  const GRACE = 90 * 60;
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
    "SELECT id, stake_rax, deposit_card_id, expires_at, rs_offer_id FROM parlays WHERE status='pending_deposit'"
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
    "SELECT id, stake_rax, deposit_card_id, rs_offer_id FROM parlays WHERE status='expired' AND expires_at > ?"
  ).bind(now - 24 * 3600).all();
  const expiredMap = {};
  for (const row of (recentExpiredRows.results || [])) {
    if (row.deposit_card_id) expiredMap[row.deposit_card_id] = { parlayId: row.id, stakeRax: row.stake_rax };
  }

  // Voided-by-card-sold map: parlays voided by card-reconcile because the deposit card left
  // edgebot's inventory (i.e. the user accepted a counter-offer and the card transferred to them).
  // card-reconcile now skips recently-assigned cards, but if it ran fast enough to void the
  // parlay we still need to reactivate it when we see the accepted offer.
  const voidedDepositRows = await env.DB.prepare(
    "SELECT id, stake_rax, deposit_card_id, rs_offer_id FROM parlays WHERE status='void' AND admin_notes='deposit_card_sold' AND created_at > ?"
  ).bind(now - 24 * 3600).all();
  const voidedMap = {};
  for (const row of (voidedDepositRows.results || [])) {
    if (row.deposit_card_id) voidedMap[row.deposit_card_id] = { parlayId: row.id, stakeRax: row.stake_rax };
  }

  // Phase 0: Direct offer lookup for parlays where edgebot already counter-offered.
  // When edgebot counters, the original offer ID is stored in rs_offer_id. We fetch that
  // specific offer directly from RS rather than relying on pagination order in incomingAccepted
  // — a late acceptance gets buried lower in the list as new offers arrive, and pagination
  // scanning misses it. Direct lookup is O(1) per parlay and immune to list ordering.
  const directCheckRows = [
    ...allPending,
    ...(recentExpiredRows.results || []),
    ...(voidedDepositRows.results || []),
  ].filter(r => r.rs_offer_id != null);

  async function fetchOffer(offerId) {
    try {
      const res = await fetch(
        `https://web.realapp.com/cardmarketplaceoffers/${offerId}`,
        { headers: buildHeaders(authInfo, sessionToken), signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })() }
      );
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  const directActivated = new Set();
  const errors = [];
  for (const row of directCheckRows) {
    const offer = await fetchOffer(row.rs_offer_id);
    if (!offer) continue;
    const status = (offer.status || offer.offerStatus || '').toLowerCase();
    if (status !== 'accepted') continue;
    const cardId = getCardId(offer) ?? row.deposit_card_id;
    const amount = Math.max(
      offer.counterAmount ?? 0,
      offer.amount       ?? 0,
      offer.offerAmount  ?? 0,
      row.stake_rax,
    );
    await activateParlay(row.id, cardId, row.rs_offer_id, amount);
    directActivated.add(row.rs_offer_id);
  }

  // Phase 0b: Card ownership check.
  // Fetch the current owner of each pending deposit card directly from the RS card endpoint.
  // When a user accepts edgebot's counter-offer the card transfers immediately — card.userId
  // reflects the new owner before the offer status reliably appears as "accepted" via pagination.
  // Build a full set of all rows to ownership-check: includes parlays with no rs_offer_id
  // (those never got a counter-offer recorded), so cards that transferred without deposit-check
  // seeing the offer in the inbox (e.g. session-expired window) are still caught here.
  const allOwnershipRows = [
    ...allPending,
    ...(recentExpiredRows.results || []),
    ...(voidedDepositRows.results || []),
  ];
  let ownershipActivated = 0;
  // Cap at 15 rows — each fetchCardOwner takes up to 8s; CF wall-clock limit is 30s.
  // Pending rows first (most likely to have a real transfer), then expired/voided.
  const ownershipCheckRows = allOwnershipRows
    .filter(r => r.deposit_card_id != null && !directActivated.has(r.rs_offer_id))
    .sort((a, b) => (a.status === 'pending_deposit' ? 0 : 1) - (b.status === 'pending_deposit' ? 0 : 1))
    .slice(0, 15);
  for (const row of ownershipCheckRows) {
    const ownerId = await fetchCardOwner(row.deposit_card_id, authInfo, sessionToken);
    if (ownerId !== null && ownerId !== EDGEBOT_USER) {
      // Guard: if another parlay already consumed this card (e.g. the card was sold via a
      // non-Real-Pro auction to a different user), void this parlay instead of activating it.
      // The card left edgebot because that user paid — not because this parlay's user did.
      // Only look at parlays created in the last 48h — cards reused from old settled parlays
      // should not trigger a false void (the card was recycled into the pool legitimately).
      const cardConsumedBy = await env.DB.prepare(
        "SELECT id FROM parlays WHERE deposit_card_id=? AND id != ? AND status NOT IN ('pending_deposit','expired','void','voided','cancelled') AND created_at > ? LIMIT 1"
      ).bind(row.deposit_card_id, row.id, now - 48 * 3600).first();
      if (cardConsumedBy) {
        await env.DB.prepare(
          "UPDATE parlays SET status='void', admin_notes='deposit_card_consumed_by_parlay_' || ? WHERE id=? AND status='pending_deposit'"
        ).bind(String(cardConsumedBy.id), row.id).run();
        errors.push({ parlayId: row.id, action: 'void_card_stolen', consumedByParlay: cardConsumedBy.id });
        continue;
      }
      await activateParlay(row.id, row.deposit_card_id, row.rs_offer_id ?? null, row.stake_rax);
      ownershipActivated++;
      directActivated.add(row.rs_offer_id);
    }
  }

  let incomingOpen, incomingAccepted, outgoingAccepted, outgoingRejected, outgoingOpen;
  // Use allSettled so that if one fetchOffers rejects (e.g. auth 401), the other four
  // don't become unhandled rejections — CF Workers turn unhandled rejections into 1101s.
  const hardTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('RS fetch hard timeout 25s')), 25000));
  try {
    const settled = await Promise.race([
      Promise.allSettled([
        fetchOffers(authInfo, sessionToken, 'incoming', 'open'),
        fetchOffers(authInfo, sessionToken, 'incoming', 'accepted'),
        fetchOffers(authInfo, sessionToken, 'outgoing', 'accepted'),
        fetchOffers(authInfo, sessionToken, 'outgoing', 'rejected'),
        fetchOffers(authInfo, sessionToken, 'outgoing', 'open'),
      ]),
      hardTimeout,
    ]);
    // Surface auth errors so the catch block can log them and alert.
    const authFail = settled.find(r => r.status === 'rejected' && r.reason?.message?.startsWith('RS auth'));
    if (authFail) throw authFail.reason;
    [incomingOpen, incomingAccepted, outgoingAccepted, outgoingRejected, outgoingOpen] =
      settled.map(r => r.status === 'fulfilled' ? r.value : []);
  } catch (e) {
    const failResult = { ts: now, error: 'RS fetch error: ' + e.message, checked: 0, accepted: 0, countered: 0, pending: pending.length };
    try { await env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at').bind('deposit_check_debug', JSON.stringify(failResult), now).run(); } catch(_) {}
    if (e.message?.startsWith('RS auth') && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ALERT_CHAT_ID) {
      await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_ALERT_CHAT_ID, text: '⚠️ deposit-check: RS auth expired — ' + pending.length + ' parlays stuck.\n\nUpdate EDGEBOT_AUTH_INFO + EDGEBOT_SESSION_TOKEN via wrangler.', parse_mode: 'HTML' }),
      }).catch(() => {});
    }
    return err('RS fetch error: ' + e.message, 502);
  }

  // RS may return the card under different field names depending on offer type.
  function getCardId(offer) {
    return offer.cardId ?? offer.card?.id ?? offer.card_id ??
           offer.marketplaceCardId ?? offer.marketplace_card_id ??
           offer.item?.id ?? offer.itemId ?? offer.listingCardId ??
           offer.cardMarketplaceId ??
           (Array.isArray(offer.linkedCardIds) && offer.linkedCardIds.length > 0 ? offer.linkedCardIds[0] : null) ??
           null;
  }

  if (debug) {
    const allKnownCards = new Set([
      ...Object.keys(fullMap), ...Object.keys(expiredMap), ...Object.keys(voidedMap)
    ].map(Number));
    const scans = await Promise.all([
      ['incoming','open'],['incoming','accepted'],['incoming','rejected'],['incoming','expired'],['incoming','completed'],
      ['outgoing','open'],['outgoing','accepted'],['outgoing','rejected'],['outgoing','expired'],['outgoing','completed'],
    ].map(async ([view, status]) => {
      const list = await fetchOffers(authInfo, sessionToken, view, status);
      const relevant = list.filter(o => { const c = getCardId(o); return fullMap[c] || expiredMap[c] || voidedMap[c]; });
      // For outgoing/accepted: show full raw offer (stripped of card detail) to diagnose counter-offer structure
      const isOutAccepted = view === 'outgoing' && status === 'accepted';
      const rawSample = list.slice(0, isOutAccepted ? 5 : 2).map(o => {
        const cardId = getCardId(o);
        const slim = { id: o.id, amount: o.amount, counterAmount: o.counterAmount, status: o.status,
          cardId: o.cardId, linkedCardIds: o.linkedCardIds, card_id: o.card_id,
          resolvedCardId: cardId, isKnown: allKnownCards.has(Number(cardId)) };
        if (isOutAccepted) {
          // Include all top-level scalar fields for counter-offer diagnosis
          Object.keys(o).forEach(k => { if (typeof o[k] !== 'object') slim[k] = o[k]; });
        }
        return slim;
      });
      return { view, status, count: list.length,
        relevant: relevant.map(o => ({ id: o.id, cardId: getCardId(o), amount: o.amount, counterAmount: o.counterAmount, status: o.status })),
        rawSample };
    }));
    return new Response(JSON.stringify({
      pending: allPending.map(p => ({ id: p.id, stake_rax: p.stake_rax, deposit_card_id: p.deposit_card_id, expires_at: p.expires_at })),
      expiredMapKeys: Object.keys(expiredMap),
      voidedMapKeys: Object.keys(voidedMap),
      cardMap, fullMap, scans
    }, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }

  let accepted = 0;
  let countered = 0;

  // Called after a parlay is activated. Checks if the referred user (parlay owner) has
  // crossed 2k cumulative stake and credits the referrer with one free play + RS DM.
  async function checkReferralMilestone(parlayId) {
    const parlay = await env.DB.prepare(
      'SELECT user_id FROM parlays WHERE id=?'
    ).bind(parlayId).first();
    if (!parlay) return;

    const referred = await env.DB.prepare(
      'SELECT parlay_referred_by_id, parlay_referral_rewarded FROM users WHERE id=?'
    ).bind(parlay.user_id).first();
    if (!referred || !referred.parlay_referred_by_id || referred.parlay_referral_rewarded) return;

    // Sum all non-cancelled stake for this user
    const totalRow = await env.DB.prepare(
      "SELECT SUM(stake_rax) AS total FROM parlays WHERE user_id=? AND (is_free_play IS NULL OR is_free_play=0) AND status NOT IN ('pending_deposit','expired','void','cancelled')"
    ).bind(parlay.user_id).first();
    const total = totalRow?.total || 0;
    if (total < 2000) return;

    // Atomically mark rewarded + credit referrer — both in one batch
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET parlay_referral_rewarded=1 WHERE id=? AND parlay_referral_rewarded=0')
        .bind(parlay.user_id),
      env.DB.prepare('UPDATE users SET free_play_credits=free_play_credits+1 WHERE id=?')
        .bind(referred.parlay_referred_by_id),
    ]);

    // Queue milestone DM — rs-verify-poll picks it up next cron run with Turnstile+send
    const referrerAuth = await env.DB.prepare(
      'SELECT dm_channel_id FROM real_auth WHERE user_id=?'
    ).bind(referred.parlay_referred_by_id).first();
    if (!referrerAuth?.dm_channel_id) return;

    const referredAuth = await env.DB.prepare(
      'SELECT rs_username FROM real_auth WHERE user_id=?'
    ).bind(parlay.user_id).first();
    const referredName = referredAuth?.rs_username ? `@${referredAuth.rs_username}` : 'someone you referred';

    const msg = `🎉 You just earned a FREE PLAY!\n\n${referredName} has placed over 2,000 Rax in parlays through your referral.\n\nHead to RaxEdge Parlays to use your free 100 Rax play. Good luck! 🔥`;

    await env.DB.prepare(
      'INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at'
    ).bind(
      'milestone_dm_pending_' + referred.parlay_referred_by_id,
      JSON.stringify({ channelId: referrerAuth.dm_channel_id, msg }),
      now
    ).run().catch(() => {});
  }

  async function activateParlay(parlayId, cardId, offerId, amount) {
    const alreadyUsed = await env.DB.prepare(
      "SELECT id FROM parlays WHERE rs_offer_id=? AND id != ? AND status NOT IN ('pending_deposit','expired','void') LIMIT 1"
    ).bind(offerId, parlayId).first();
    if (alreadyUsed) {
      errors.push({ parlayId, offerId, action: 'activate_skip', reason: 'offer_already_used_by_parlay_' + alreadyUsed.id });
      return;
    }

    const receivedRax = Math.floor(amount * 0.9);
    const result = await env.DB.prepare(
      "UPDATE parlays SET status='active', rs_offer_id=COALESCE(?, rs_offer_id), received_rax=?, deposited_at=? " +
      "WHERE id=? AND deposit_card_id=? AND status IN ('pending_deposit','expired','void')"
    ).bind(offerId, receivedRax, now, parlayId, cardId).run();
    if (result.meta.changes > 0) {
      await env.DB.prepare('DELETE FROM deposit_cards WHERE card_id=?').bind(cardId).run();
      // Fire-and-forget — never block the main deposit flow.
      checkReferralMilestone(parlayId).catch(() => {});
    } else {
      // UPDATE matched 0 rows — log current parlay state so we can diagnose the mismatch
      const row = await env.DB.prepare(
        'SELECT id, status, deposit_card_id, rs_offer_id FROM parlays WHERE id=?'
      ).bind(parlayId).first().catch(() => null);
      errors.push({ parlayId, cardId, offerId, action: 'activate_no_change', parlayRow: row });
    }
  }

  // Phase 1: Process accepted incoming offers + any outgoing offers whose card matches a
  // known deposit card. outgoingAccepted normally contains payout offers sent to winners,
  // but when edgebot counters an incoming deposit offer and the user accepts that counter,
  // RS may resolve it in outgoingAccepted rather than incomingAccepted.
  //
  // IMPORTANT: only match outgoing offers whose ID was previously tracked as a counter-offer
  // (rs_offer_id in parlays). Without this, a payout offer edgebot sent on a card that was
  // later added to the deposit pool would falsely activate a new parlay (parlay 1952 incident).
  const trackedOfferIds = new Set([
    ...allPending,
    ...(recentExpiredRows.results || []),
    ...(voidedDepositRows.results || []),
  ].filter(r => r.rs_offer_id != null).map(r => r.rs_offer_id));

  const processedIds = new Set();
  const seenSettled = new Set();
  const depositCardOutgoing = outgoingAccepted.filter(o => {
    const cid = getCardId(o);
    if (!cid || !o.id) return false;
    if (!(fullMap[cid] || expiredMap[cid] || voidedMap[cid])) return false;
    return trackedOfferIds.has(o.id); // only counter-offers edgebot made for a parlay
  });
  const allSettled = [...incomingAccepted, ...depositCardOutgoing].filter(o => {
    if (!o.id || seenSettled.has(o.id)) return false;
    seenSettled.add(o.id);
    return true;
  });

  for (const offer of allSettled) {
    processedIds.add(offer.id);
    const cardId  = getCardId(offer);
    const offerId = offer.id;
    if (!cardId || !offerId) continue;

    const match = cardMap[cardId] || expiredMap[cardId] || fullMap[cardId] || voidedMap[cardId];
    if (!match) continue;

    // stakeRax is the floor — edgebot always counter-offers to exactly stakeRax,
    // so even if RS clears counterAmount after settlement we still know the agreed price.
    const effectiveAmount = Math.max(
      offer.counterAmount ?? 0,
      offer.amount       ?? 0,
      offer.offerAmount  ?? 0,
      match.stakeRax,
    );

    const beforeAccepted = accepted;
    await activateParlay(match.parlayId, cardId, offerId, effectiveAmount);
    if (accepted === beforeAccepted) accepted++; // activateParlay doesn't return a value; count Phase 1 attempts
  }

  // Phase 2: Process open offers — counter if under stake, accept if exact or over.
  for (const offer of incomingOpen) {
    if (processedIds.has(offer.id)) continue;
    const cardId  = getCardId(offer);
    const offerId = offer.id;
    if (!cardId || !offerId) continue;

    const match = cardMap[cardId];
    if (!match) continue;

    const fromExpired = !cardMap[cardId] && !!expiredMap[cardId];
    const amount = offer.counterAmount ?? offer.amount ?? offer.offerAmount;
    if (!amount) continue;

    if (amount < match.stakeRax) {
      if (fromExpired) continue;
      let counterResult;
      try { counterResult = await counterOffer(offerId, match.stakeRax, authInfo, sessionToken); }
      catch (e) { errors.push({ offerId, action: 'counter', error: e.message }); continue; }
      if (counterResult.ok) {
        countered++;
        // Store the offer ID so Phase 0 can directly look up its acceptance status next run,
        // bypassing pagination entirely for late-accepted counter-offers.
        await env.DB.prepare('UPDATE parlays SET rs_offer_id=? WHERE id=? AND rs_offer_id IS NULL')
          .bind(offerId, match.parlayId).run();
      } else {
        errors.push({ offerId, action: 'counter', error: `RS ${counterResult.status}: ${counterResult.body}` });
      }
      continue;
    }

    let rsResult;
    try { rsResult = await acceptOffer(offerId, authInfo, sessionToken); }
    catch (e) { errors.push({ offerId, action: 'accept', error: e.message }); continue; }
    if (!rsResult.ok) { errors.push({ offerId, action: 'accept', error: `RS ${rsResult.status}: ${rsResult.body}` }); continue; }

    await activateParlay(match.parlayId, cardId, offerId, amount);
    accepted++;
  }

  // If user rejected edgebot's counter-offer, void the parlay and free the card immediately
  // so they can place again rather than waiting 30 min for expiry.
  for (const offer of outgoingRejected) {
    const cardId = getCardId(offer);
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
    ...outgoingOpen.map(o => getCardId(o)),
    ...outgoingAccepted.map(o => getCardId(o)),
    ...incomingAccepted.map(o => getCardId(o)),
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

  const result = { ts: now, checked: allSettled.length + incomingOpen.length, accepted, countered, ownershipActivated, pending: pending.length, errors };
  try {
    await env.DB.prepare(
      'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
    ).bind('deposit_check_debug', JSON.stringify(result), now).run();
  } catch(e) {}

  // Low-card admin alert — fires once per hour when free cards drop to 10 or fewer
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ALERT_CHAT_ID) {
    try {
      const LOW_CARD_THRESHOLD = 10;
      const ALERT_THROTTLE     = 3600; // 1 hour
      const testAlert          = url.searchParams.has('test_alert');
      const freeRow = await env.DB.prepare(
        'SELECT COUNT(*) AS cnt FROM deposit_cards WHERE assigned_to_parlay_id IS NULL'
      ).first();
      const freeCards = freeRow?.cnt ?? 0;
      if (testAlert || freeCards <= LOW_CARD_THRESHOLD) {
        const lastAlert = await env.DB.prepare(
          "SELECT fetched_at FROM odds_cache WHERE cache_key='low_card_alert_sent'"
        ).first();
        if (testAlert || !lastAlert || (now - lastAlert.fetched_at) >= ALERT_THROTTLE) {
          const text = testAlert
            ? `🧪 Test alert — deposit card monitor is working.\n\nCurrent free cards: ${freeCards}`
            : `⚠️ Low deposit cards: ${freeCards} free card${freeCards === 1 ? '' : 's'} remaining.\n\nAdd more via D1:\nINSERT OR IGNORE INTO deposit_cards (card_id) VALUES (...);`;
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ chat_id: env.TELEGRAM_ALERT_CHAT_ID, text }),
            signal:  AbortSignal.timeout(6000),
          });
          if (!testAlert) {
            await env.DB.prepare(
              "INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES('low_card_alert_sent','1',?) ON CONFLICT(cache_key) DO UPDATE SET data='1',fetched_at=excluded.fetched_at"
            ).bind(now).run();
          }
        }
      }
    } catch {}
  }

  return ok(result);
}

export const onRequestPost = handleRequest;
export const onRequestGet  = handleRequest;
