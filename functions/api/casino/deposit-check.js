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
const DEPOSIT_TTL    = 15 * 60; // 15 minutes — matches deposit.js

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

// Check card auction history for a specific buyer (rs_username) buying from edgebot.
// Returns the amount paid if it's within 10% of raxRequested, or 0 if not found / amount mismatch.
// History may contain multiple trades (card recycled); amount validation ensures we match
// the current deposit, not a previous one for the same card.
async function checkAuctionHistory(cardId, rsUsername, raxRequested, authInfo, sessionToken) {
  try {
    const res = await fetch(
      `https://web.realapp.com/cardauctionhistory/${cardId}`,
      { headers: buildHeaders(authInfo, sessionToken), signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return 0;
    const data = await res.json();
    const history = Array.isArray(data?.auctionHistory) ? data.auctionHistory : [];
    for (const entry of history) {
      const buyer  = entry.user?.userName?.toLowerCase();
      const seller = entry.from?.user?.id;
      if (buyer === rsUsername.toLowerCase() && seller === EDGEBOT_USER) {
        const raw = String(entry.amountDisplay || '').replace(/,/g, '');
        const amount = parseInt(raw, 10);
        // Validate amount is within 10% of rax_requested — guards against stale recycled-card trades
        if (amount > 0 && amount >= raxRequested * 0.9) return amount;
      }
    }
  } catch (_) {}
  return 0;
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

async function handleRequest({ request, env, userId, cronOk }) {
  const url2       = new URL(request.url);
  const debug      = url2.searchParams.has('debug');
  const now        = Math.floor(Date.now() / 1000);
  const authInfo   = env.EDGEBOT_AUTH_INFO;
  const sessionTok = env.EDGEBOT_SESSION_TOKEN || '';

  if (debug && !cronOk) {
    const session = await getSession(request, env.DB);
    const user = session
      ? await env.DB.prepare('SELECT is_admin FROM users WHERE id=?').bind(session.user_id).first()
      : null;
    if (!user?.is_admin) return err('Unauthorized', 401);
  }

  if (!authInfo) return err('EDGEBOT_AUTH_INFO not configured', 500);

  // Load all pending deposits — scoped to one user if called by user, all if called by cron
  const pendingQuery = userId
    ? "SELECT * FROM casino_deposits WHERE user_id=? AND status='pending'"
    : "SELECT * FROM casino_deposits WHERE status='pending'";
  const pendingRows = userId
    ? await env.DB.prepare(pendingQuery).bind(userId).all()
    : await env.DB.prepare(pendingQuery).all();
  const pending = pendingRows.results || [];

  // Also load recently-expired deposits (within 2h) — reactivate if offer arrives late.
  // ORDER BY created_at DESC so the most recently expired (highest chance of valid card transfer) are checked first.
  const expiredRows = userId ? { results: [] } : await env.DB.prepare(
    "SELECT * FROM casino_deposits WHERE status='expired' AND created_at > ? ORDER BY created_at DESC LIMIT 10"
  ).bind(now - 2 * 3600).all();
  const recentExpired = expiredRows.results || [];

  if (!pending.length && !recentExpired.length) {
    return ok({ confirmed: false, checked: 0, credited: 0, pending: 0 });
  }

  // Build card → deposit lookup maps
  const cardMap    = {}; // pending deposits
  const expiredMap = {}; // recently-expired deposits (for late-offer resurrection)
  for (const dep of pending)       if (dep.card_id) cardMap[dep.card_id]    = dep;
  for (const dep of recentExpired) if (dep.card_id) expiredMap[dep.card_id] = dep;

  const errors  = [];
  let confirmed = 0;
  let credited  = 0;

  // ── Debug mode: full 10-view scan, mirrors parlays/deposit-check.js debug block ──
  if (debug) {
    const allKnownCards = new Set([
      ...Object.keys(cardMap), ...Object.keys(expiredMap),
    ].map(Number));
    const scans = await Promise.all([
      ['incoming','open'],['incoming','accepted'],['incoming','rejected'],['incoming','expired'],['incoming','completed'],
      ['outgoing','open'],['outgoing','accepted'],['outgoing','rejected'],['outgoing','expired'],['outgoing','completed'],
    ].map(async ([view, status]) => {
      try {
        const list = await fetchOffers(authInfo, sessionTok, view, status);
        const isOutAccepted = view === 'outgoing' && status === 'accepted';
        const relevant = list.filter(o => { const c = getCardId(o); return allKnownCards.has(Number(c)); });
        const rawSample = list.slice(0, isOutAccepted ? 5 : 2).map(o => {
          const cardId = getCardId(o);
          const slim = { id: o.id, amount: o.amount, counterAmount: o.counterAmount, status: o.status,
            cardId: o.cardId, linkedCardIds: o.linkedCardIds, card_id: o.card_id,
            resolvedCardId: cardId, isKnown: allKnownCards.has(Number(cardId)) };
          if (isOutAccepted) Object.keys(o).forEach(k => { if (typeof o[k] !== 'object') slim[k] = o[k]; });
          return slim;
        });
        return { view, status, count: list.length,
          relevant: relevant.map(o => ({ id: o.id, cardId: getCardId(o), amount: o.amount, counterAmount: o.counterAmount, status: o.status })),
          rawSample };
      } catch (e) { return { view, status, error: e.message }; }
    }));
    return new Response(JSON.stringify({
      pending: pending.map(d => ({ id: d.id, user_id: d.user_id, rax_requested: d.rax_requested, card_id: d.card_id, status: d.status, created_at: d.created_at, rs_offer_id: d.rs_offer_id })),
      recentExpired: recentExpired.map(d => ({ id: d.id, user_id: d.user_id, rax_requested: d.rax_requested, card_id: d.card_id, created_at: d.created_at })),
      cardMap, expiredMap, scans,
    }, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }

  // ── Audit mode: verify auction history for every confirmed deposit ────────────
  // GET ?audit_users=email1,email2&_cron_key=... (admin/cron only)
  // Returns per-deposit verdict: paid / no_history / error
  if (url2.searchParams.has('audit_users') && cronOk) {
    const emails = url2.searchParams.get('audit_users').split(',').map(e => e.trim()).filter(Boolean);
    if (!emails.length) return err('audit_users param required', 400);

    const ph = emails.map(() => '?').join(',');
    const confirmedRows = await env.DB.prepare(
      `SELECT cd.id, cd.user_id, cd.card_id, cd.rax_requested, cd.rax_credited, cd.created_at,
              u.email, ra.rs_username
       FROM casino_deposits cd
       JOIN users u ON u.id = cd.user_id
       LEFT JOIN real_auth ra ON ra.user_id = cd.user_id AND ra.parlay_verified = 1
       WHERE cd.status = 'confirmed' AND u.email IN (${ph})
       ORDER BY cd.created_at DESC`
    ).bind(...emails).all();

    const rows = confirmedRows.results || [];

    // Detect duplicate card_ids across deposits
    const cardUsage = {};
    for (const r of rows) {
      if (!cardUsage[r.card_id]) cardUsage[r.card_id] = [];
      cardUsage[r.card_id].push(r.id);
    }

    const results = [];
    for (const row of rows) {
      if (!row.rs_username || !row.card_id) {
        results.push({ ...row, verdict: 'skip', reason: !row.rs_username ? 'no_rs_username' : 'no_card_id' });
        continue;
      }
      const paidAmount = await checkAuctionHistory(row.card_id, row.rs_username, row.rax_requested, authInfo, sessionTok);
      const dupeOf = (cardUsage[row.card_id] || []).filter(id => id !== row.id);
      results.push({
        dep_id: row.id,
        email: row.email,
        rs_username: row.rs_username,
        card_id: row.card_id,
        rax_requested: row.rax_requested,
        rax_credited: row.rax_credited,
        created: new Date(row.created_at * 1000).toISOString(),
        verdict: paidAmount > 0 ? 'paid' : 'no_history',
        paid_amount: paidAmount || null,
        dupe_card_in_deps: dupeOf.length ? dupeOf : undefined,
      });
      await new Promise(r => setTimeout(r, 200));
    }

    const paid       = results.filter(r => r.verdict === 'paid');
    const noHistory  = results.filter(r => r.verdict === 'no_history');
    const skipped    = results.filter(r => r.verdict === 'skip');
    const dupes      = Object.entries(cardUsage).filter(([, ids]) => ids.length > 1);
    const overCredited = noHistory.reduce((s, r) => s + (r.rax_credited || 0), 0);

    return new Response(JSON.stringify({
      total: rows.length,
      paid: paid.length,
      no_history: noHistory.length,
      skipped: skipped.length,
      over_credited_rax: overCredited,
      dupe_cards: dupes.map(([cardId, ids]) => ({ card_id: Number(cardId), dep_ids: ids })),
      results,
    }, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }

  // ── activateDeposit ──────────────────────────────────────────────────────────
  // Credits the user and marks deposit confirmed. Mirrors parlays activateParlay.
  async function activateDeposit(dep, cardId, offerId, amount) {
    if (!amount || amount <= 0) return;

    // FINAL GUARD: verify card left edgebot before crediting.
    // If edgebot still owns it, the offer wasn't truly accepted — do not credit.
    // null = network timeout — allow through to avoid blocking real deposits.
    const finalCardId = cardId || dep.card_id;
    if (finalCardId) {
      const ownerNow = await fetchCardOwner(finalCardId, authInfo, sessionTok);
      if (ownerNow === EDGEBOT_USER) {
        errors.push({ depositId: dep.id, cardId: finalCardId, note: 'final_guard: edgebot still owns card — not crediting' });
        return;
      }
    }

    // Guard: same card must never credit two deposits.
    // A card represents one RS payment — if any other deposit row for this card is
    // already confirmed, this deposit is a duplicate (race condition or recycled card
    // picked up by multiple pending rows). Blocks all multi-phase double-credit paths.
    if (finalCardId) {
      const cardAlreadyConfirmed = await env.DB.prepare(
        "SELECT id FROM casino_deposits WHERE card_id=? AND id != ? AND status='confirmed' LIMIT 1"
      ).bind(finalCardId, dep.id).first();
      if (cardAlreadyConfirmed) {
        errors.push({ depositId: dep.id, cardId: finalCardId, note: 'card_already_confirmed_by_' + cardAlreadyConfirmed.id });
        return;
      }
    }

    // Guard: same offer ID must never credit two deposits
    if (offerId) {
      const alreadyUsed = await env.DB.prepare(
        "SELECT id FROM casino_deposits WHERE rs_offer_id=? AND status='confirmed' LIMIT 1"
      ).bind(String(offerId)).first();
      if (alreadyUsed) return;
    }

    const raxCredited = Math.floor(amount * 0.9);
    const updated = await env.DB.prepare(
      "UPDATE casino_deposits SET status='confirmed', rax_credited=?, rs_offer_id=? WHERE id=? AND status IN ('pending','expired','cancelled')"
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

  // ── Phase 0: Direct offer-by-ID lookup — mirrors parlays deposit-check Phase 0 ──
  // When edgebot counters, rs_offer_id is stored. Fetch that offer directly next run —
  // O(1) per deposit, immune to pagination ordering, catches counter-offer acceptance fast.
  async function fetchOffer(offerId) {
    try {
      const res = await fetch(
        `https://web.realapp.com/cardmarketplaceoffers/${offerId}`,
        { headers: buildHeaders(authInfo, sessionTok), signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })() }
      );
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  // ── Phase 0b: Card ownership + auction history check ─────────────────────────
  // Ownership check detects the card transfer instantly. Auction history then verifies
  // that THIS user actually bought the card from edgebot for the requested amount.
  // This is the ONLY path that credits a deposit — no offer-state-based crediting.
  // Cap at 20 cards to stay within CF 30s wall-clock (each dep = 2 RS API calls).
  const ownershipRows = [...pending, ...recentExpired]
    .filter(dep => dep.card_id != null)
    .slice(0, 20);

  // Load RS user IDs for all ownership rows in one batch
  const activatedCardIds = new Set();
  if (ownershipRows.length && !userId) {
    const ownerUserIds = [...new Set(ownershipRows.map(d => d.user_id))];
    const ownerPh = ownerUserIds.map(() => '?').join(',');
    const ownerAuthRows = await env.DB.prepare(
      `SELECT user_id, rs_user_id FROM real_auth WHERE user_id IN (${ownerPh}) AND parlay_verified=1`
    ).bind(...ownerUserIds).all();
    const ownerUserIdMap = {};
    for (const r of (ownerAuthRows.results || [])) ownerUserIdMap[r.user_id] = r.rs_user_id;

    for (const dep of ownershipRows) {
      if (activatedCardIds.has(dep.card_id)) continue;
      const ownerId = await fetchCardOwner(dep.card_id, authInfo, sessionTok);
      if (ownerId === null || ownerId === EDGEBOT_USER) continue; // card still with edgebot

      // Card left edgebot — verify the depositing user is the new owner by RS user ID
      const rsUserId = ownerUserIdMap[dep.user_id];
      if (!rsUserId) continue; // no RS user ID on record — skip, offer polling will catch it

      if (ownerId === rsUserId) {
        await activateDeposit(dep, dep.card_id, null, dep.rax_requested);
        activatedCardIds.add(dep.card_id);
      }
      // ownerId mismatch: card sold to someone else or timing lag. Leave pending.
    }
  }

  // ── Phase 0c: Ownership fallback ─────────────────────────────────────────────
  // Catches deposits where Phase 0b was skipped (per-user calls) or timed out.
  // Re-checks card ownership and compares against depositing user's RS user ID.
  // Runs cron-wide only.
  if (!userId) {
    const historyRows = [...pending, ...recentExpired]
      .filter(dep => dep.card_id && (now - dep.created_at) > 90)
      .slice(0, 20);

    if (historyRows.length) {
      const userIds = [...new Set(historyRows.map(d => d.user_id))];
      const ph = userIds.map(() => '?').join(',');
      const authRows = await env.DB.prepare(
        `SELECT user_id, rs_user_id FROM real_auth WHERE user_id IN (${ph}) AND parlay_verified=1`
      ).bind(...userIds).all();
      const userIdMap = {};
      for (const r of (authRows.results || [])) userIdMap[r.user_id] = r.rs_user_id;

      for (const dep of historyRows) {
        if (activatedCardIds.has(dep.card_id)) continue;
        const rsUserId = userIdMap[dep.user_id];
        if (!rsUserId) continue;
        const ownerId = await fetchCardOwner(dep.card_id, authInfo, sessionTok);
        if (ownerId === null || ownerId === EDGEBOT_USER) continue;
        if (ownerId === rsUserId) {
          await activateDeposit(dep, dep.card_id, null, dep.rax_requested);
          activatedCardIds.add(dep.card_id);
        }
      }
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

  // Phase 1 removed: incomingAccepted / outgoingAccepted no longer credit directly.
  // Phase 0b (auction history) is the sole credit path — it catches these on the
  // same or next cron run once the card has transferred and history is populated.

  // ── Phase 2: Open offers — counter if under, accept if ≥ rax_requested ──────
  const justAcceptedCards = new Set(); // cards accepted this run — must not expire same run
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
      // Offer meets the deposit amount — accept it. Phase 0b will credit on the
      // next cron run once auction history confirms this user paid edgebot.
      const result = await acceptOffer(offer.id, authInfo, sessionTok);
      if (!result.ok) { errors.push({ offerId: offer.id, action: 'accept', error: `RS ${result.status}: ${result.body}` }); continue; }
      justAcceptedCards.add(Number(cardId)); // protect from TTL expiry this same run
      await env.DB.prepare(
        "UPDATE casino_deposits SET rs_offer_id=? WHERE id=? AND rs_offer_id IS NULL"
      ).bind(String(offer.id), dep.id).run();
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
    ...justAcceptedCards,
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

  const result = {
    ts: now, confirmed, credited,
    checked: (incomingOpen || []).length,
    expired: toExpire.length,
    pending: pending.length,
    errors,
  };

  // Write cron result to odds_cache for admin inspection
  try {
    await env.DB.prepare(
      'INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at'
    ).bind('casino_deposit_check_debug', JSON.stringify(result), now).run();
  } catch (_) {}

  return ok(result);
}

export async function onRequestGet({ request, env }) {
  const url     = new URL(request.url);
  const cronKey = url.searchParams.get('_cron_key');
  const cronOk  = !!(cronKey && env.CRON_SECRET && cronKey === env.CRON_SECRET);

  if (cronOk) {
    return handleRequest({ request, env, userId: null, cronOk: true });
  }

  // debug param handled inside handleRequest (admin-only auth check)
  if (url.searchParams.has('debug')) {
    return handleRequest({ request, env, userId: null, cronOk: false });
  }

  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);
  return handleRequest({ request, env, userId: session.user_id, cronOk: false });
}
