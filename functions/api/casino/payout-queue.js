// functions/api/casino/payout-queue.js
// Bot + admin queue management for casino withdrawals.
// GET/POST ?action=list          — list withdrawals
// POST     ?action=prepare&id=N  — find card in user's RS inventory, set status=processing
// POST     ?action=mark_sent&id=N[&phase=1] — mark phase done or fully complete
// POST     ?action=skip_card&id=N — skip current card
// POST     ?action=mark_attempt&id=N — increment attempt counter
// POST     ?action=update_notes — save notes

import { rsUrlEncode, hashidsEncode } from '../../_lib/hashids.js';
import { ok, err }                    from '../../_lib/response.js';
import { getSession }                 from '../../_lib/session.js';

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

// Same priority order as parlay payout-queue CARD_TARGETS
const CARD_TARGETS = [
  ['mlb', '2025', 'play'],
  ['mlb', '2026', 'play'],
  ['nba', '2026', 'play'],
  ['nhl', '2026', 'play'],
  ['nba', '2025', 'play'],
  ['nhl', '2025', 'play'],
  ['mlb', '2024', 'play'],
  ['nba', '2024', 'play'],
  ['nhl', '2024', 'play'],
  ['nfl', '2024', 'play'],
];

async function findUnownedCard(rsUserId, authInfo, sessionToken, skipIds) {
  const hdrs = buildHeaders(authInfo, sessionToken);
  for (const [sport, season, entity] of CARD_TARGETS) {
    try {
      const url =
        `https://web.realapp.com/collectingcards/${sport}/season/${season}/entity/${entity}` +
        `/user/${rsUserId}/cards?filterCustomType=unowned&includeRecommendations=false&rarity=all&view=rating`;
      const res = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const data = await res.json();
      const cards = Array.isArray(data) ? data : (data.cards || data.items || []);
      for (const card of cards.slice(0, 30)) {
        const id = card.id ?? card.cardId ?? null;
        if (!id || skipIds.has(id)) continue;
        if (card.untouchable === true) continue;
        if (card.prestige != null && card.prestige >= 1) continue;
        const rarity = (card.rarityLabel || card.rarity || '').toLowerCase();
        if (rarity === 'mystic' || rarity === 'legendary' || rarity === 'iconic') continue;
        return id;
      }
    } catch { continue; }
  }
  return null;
}

// Find the first unowned card of a specific rarity (e.g. 'epic', 'legendary').
// Used for single-card payouts above 10k when a higher-cap card is available.
async function findUnownedCardOfRarity(rsUserId, authInfo, sessionToken, skipIds, targetRarity) {
  const hdrs   = buildHeaders(authInfo, sessionToken);
  const target = targetRarity.toLowerCase();
  for (const [sport, season, entity] of CARD_TARGETS) {
    try {
      const url =
        `https://web.realapp.com/collectingcards/${sport}/season/${season}/entity/${entity}` +
        `/user/${rsUserId}/cards?filterCustomType=unowned&includeRecommendations=false&rarity=all&view=rating`;
      const res = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const data = await res.json();
      const cards = Array.isArray(data) ? data : (data.cards || data.items || []);
      for (const card of cards.slice(0, 30)) {
        const id = card.id ?? card.cardId ?? null;
        if (!id || skipIds.has(id)) continue;
        if (card.untouchable === true) continue;
        if (card.prestige != null && card.prestige >= 1) continue;
        const rarity = (card.rarityLabel || '').toLowerCase();
        if (rarity !== target) continue;
        return id;
      }
    } catch { continue; }
  }
  return null;
}

async function isAuthorized(request, env) {
  const url = new URL(request.url);
  if (env.CRON_SECRET && url.searchParams.get('_cron_key') === env.CRON_SECRET) return true;
  const session = await getSession(request, env.DB);
  if (!session) return false;
  const user = await env.DB.prepare('SELECT is_admin FROM users WHERE id=?').bind(session.user_id).first();
  return !!user?.is_admin;
}

async function handleRequest({ request, env }) {
  if (!(await isAuthorized(request, env))) return err('Unauthorized', 401);

  const url    = new URL(request.url);
  const action = url.searchParams.get('action') || 'list';
  const id     = url.searchParams.get('id');
  const now    = Math.floor(Date.now() / 1000);

  // ── List ──────────────────────────────────────────────────────────────────
  if (action === 'list') {
    const statusFilter = url.searchParams.get('status') || '';
    const whereExtra   = statusFilter ? ` AND cw.status = '${statusFilter.replace(/'/g, '')}'` : '';

    const { results } = await env.DB.prepare(
      `SELECT cw.id, cw.user_id, cw.amount, cw.rs_username, cw.status, cw.notes,
              cw.created_at, cw.target_card_id, cw.skipped_cards,
              cw.attempts, cw.last_attempt_at, cw.card1_id, cw.card1_sent_at,
              u.email, u.casino_balance,
              ra.rs_user_id
       FROM casino_withdrawals cw
       JOIN users u ON u.id = cw.user_id
       LEFT JOIN real_auth ra ON ra.user_id = cw.user_id
       WHERE cw.status IN ('pending','processing','complete','failed') ${whereExtra}
       ORDER BY CASE cw.status WHEN 'pending' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END,
                cw.created_at DESC
       LIMIT 100`
    ).all();

    const [wdStats, handStats, liability] = await Promise.all([
      env.DB.prepare(
        `SELECT
           SUM(CASE WHEN status='pending'    THEN amount ELSE 0 END) AS pending_rax,
           COUNT(CASE WHEN status='pending'    THEN 1 END) AS pending_count,
           SUM(CASE WHEN status='processing' THEN amount ELSE 0 END) AS processing_rax,
           COUNT(CASE WHEN status='processing' THEN 1 END) AS processing_count,
           SUM(CASE WHEN status='complete'   THEN amount ELSE 0 END) AS paid_rax
         FROM casino_withdrawals`
      ).first(),
      env.DB.prepare(
        `SELECT
           COUNT(*)          AS total_hands,
           SUM(bet_total)    AS total_wagered,
           SUM(profit)       AS house_profit
         FROM casino_hands`
      ).first(),
      env.DB.prepare(
        'SELECT SUM(casino_balance) AS total FROM users WHERE casino_balance > 0'
      ).first(),
    ]);

    const totalWagered  = handStats?.total_wagered  ?? 0;
    const houseProfit   = handStats?.house_profit   ?? 0;
    const houseEdgePct  = totalWagered > 0
      ? Math.round(houseProfit / totalWagered * 10000) / 100
      : 0;

    return ok({
      queue: (results || []).map(r => ({
        ...r,
        card_url: r.target_card_id
          ? 'https://www.realapp.com/' + rsUrlEncode(20, 0, 0, r.target_card_id)
          : null,
      })),
      stats: {
        ...wdStats,
        total_liability: liability?.total ?? 0,
        total_hands:     handStats?.total_hands ?? 0,
        total_wagered:   totalWagered,
        house_profit:    houseProfit,
        house_edge_pct:  houseEdgePct,
      },
    });
  }

  // ── Prepare: find a card in the user's RS inventory ──────────────────────
  // For withdrawals > 10K: two-card split (RS cap is 10K per card).
  //   Phase 1 (card1_sent_at IS NULL): find card1, offer 10K.
  //   Phase 2 (card1_sent_at IS NOT NULL): find card2, offer remainder.
  // Exception: 10K–15K → try Epic card first (15K cap); 15K–20K → try Legendary (20K cap).
  if (action === 'prepare') {
    if (!id) return err('id required', 400);

    const entry = await env.DB.prepare(
      `SELECT cw.id, cw.user_id, cw.amount, cw.skipped_cards, cw.target_card_id,
              cw.card1_id, cw.card1_sent_at, cw.card1_amount, cw.status,
              ra.rs_user_id
       FROM casino_withdrawals cw
       LEFT JOIN real_auth ra ON ra.user_id = cw.user_id
       WHERE cw.id = ?`
    ).bind(id).first();
    if (!entry)            return err('Not found', 404);
    if (!entry.rs_user_id) return err('User has no RS account connected', 400);

    const authInfo     = env.EDGEBOT_AUTH_INFO;
    const sessionToken = env.EDGEBOT_SESSION_TOKEN || '';
    if (!authInfo) return err('EDGEBOT_AUTH_INFO not configured', 500);

    const skippedIds = new Set(entry.skipped_cards ? JSON.parse(entry.skipped_cards) : []);

    // Exclude cards already targeted for other withdrawals of the same user,
    // AND card1_id from phase-1 offers sent within the last 48h (offer still open on RS)
    try {
      const { results: others } = await env.DB.prepare(
        'SELECT target_card_id, card1_id FROM casino_withdrawals WHERE user_id=? AND id!=?'
      ).bind(entry.user_id, id).all();
      for (const r of (others || [])) {
        if (r.target_card_id) skippedIds.add(r.target_card_id);
        if (r.card1_id)       skippedIds.add(r.card1_id);
      }
    } catch (_) {}

    // Exclude cards in the deposit pool
    try {
      const { results: pool } = await env.DB.prepare('SELECT card_id FROM deposit_cards').all();
      for (const r of (pool || [])) skippedIds.add(r.card_id);
    } catch (_) {}

    const withdrawalAmount = entry.amount;
    const isMultiCard      = withdrawalAmount > 10000;

    if (!isMultiCard || !entry.card1_sent_at) {
      // Phase 1 (or single-card ≤ 10k): find the first card.
      // ≤ 15k: try Epic first (15k cap) → single offer.
      // 15k–20k: try Legendary first (20k cap) → single offer.
      // >20k: always multi-card — try Legendary for 20k card1, fallback Epic for 15k card1.
      // Standard card fallback: 10k card1.
      let cardId = null;
      let singleHighRarity = false;
      let card1Offer = 0;

      if (isMultiCard) {
        if (withdrawalAmount <= 15000) {
          cardId = await findUnownedCardOfRarity(entry.rs_user_id, authInfo, sessionToken, skippedIds, 'epic');
          if (cardId) singleHighRarity = true;
        } else if (withdrawalAmount <= 20000) {
          cardId = await findUnownedCardOfRarity(entry.rs_user_id, authInfo, sessionToken, skippedIds, 'legendary');
          if (cardId) singleHighRarity = true;
        } else {
          // >20k: split required — try legendary (20k) then epic (15k) for card1
          cardId = await findUnownedCardOfRarity(entry.rs_user_id, authInfo, sessionToken, skippedIds, 'legendary');
          if (cardId) {
            card1Offer = 20000;
          } else {
            cardId = await findUnownedCardOfRarity(entry.rs_user_id, authInfo, sessionToken, skippedIds, 'epic');
            if (cardId) card1Offer = 15000;
          }
        }
      }

      if (!cardId) {
        // Reuse already-assigned card if present and not skipped (retry case)
        if (entry.target_card_id && !skippedIds.has(entry.target_card_id)) {
          cardId = entry.target_card_id;
        } else {
          cardId = await findUnownedCard(entry.rs_user_id, authInfo, sessionToken, skippedIds);
        }
      }
      if (!cardId) return err('No eligible cards found for this user', 404);

      const cardUrl   = 'https://www.realapp.com/' + rsUrlEncode(20, 0, 0, cardId);
      const multiCard = isMultiCard && !singleHighRarity;
      const offerAmount = singleHighRarity ? withdrawalAmount : (multiCard ? (card1Offer || 10000) : withdrawalAmount);

      await env.DB.prepare(
        "UPDATE casino_withdrawals SET target_card_id=?, card1_amount=?, status='processing', last_attempt_at=? WHERE id=?"
      ).bind(cardId, multiCard ? offerAmount : null, now, id).run();

      return ok({ cardId, cardUrl, offerAmount, isMultiCard: multiCard, phase: 1 });
    }

    // Phase 2: card1 already sent — find a second card for the remaining amount.
    // card1_amount tells us what was already sent; remainder drives card type selection.
    if (entry.card1_id) skippedIds.add(entry.card1_id);

    const remainder = withdrawalAmount - (entry.card1_amount || 10000);

    // Reuse already-assigned card2 (target_card_id) if present (retry case)
    let cardId = entry.target_card_id;
    if (!cardId) {
      if (remainder > 15000) {
        cardId = await findUnownedCardOfRarity(entry.rs_user_id, authInfo, sessionToken, skippedIds, 'legendary');
        if (!cardId) cardId = await findUnownedCardOfRarity(entry.rs_user_id, authInfo, sessionToken, skippedIds, 'epic');
      } else if (remainder > 10000) {
        cardId = await findUnownedCardOfRarity(entry.rs_user_id, authInfo, sessionToken, skippedIds, 'epic');
      }
      if (!cardId) cardId = await findUnownedCard(entry.rs_user_id, authInfo, sessionToken, skippedIds);
      if (!cardId) return err('No eligible card found for second payout', 404);
    }

    await env.DB.prepare(
      'UPDATE casino_withdrawals SET target_card_id=?, last_attempt_at=? WHERE id=?'
    ).bind(cardId, now, id).run();

    const cardUrl = 'https://www.realapp.com/' + rsUrlEncode(20, 0, 0, cardId);
    return ok({ cardId, cardUrl, offerAmount: remainder, isMultiCard: true, phase: 2 });
  }

  // ── Mark sent ──────────────────────────────────────────────────────────────
  // ?phase=1 — card1 sent: save card1_id from target, reset target for phase 2, stay processing
  // ?phase=2 or absent — fully done: mark status='complete'
  if (action === 'mark_sent') {
    if (!id) return err('id required', 400);
    const phase = url.searchParams.get('phase');
    if (phase === '1') {
      await env.DB.prepare(
        'UPDATE casino_withdrawals SET card1_id=target_card_id, card1_sent_at=?, target_card_id=NULL WHERE id=?'
      ).bind(now, id).run();
      return ok({ marked: true, phase: 1 });
    }
    await env.DB.prepare(
      "UPDATE casino_withdrawals SET status='complete', notes='Paid via bot', target_card_id=NULL WHERE id=?"
    ).bind(id).run();
    return ok({ marked: true });
  }

  // ── Mark attempt: increment attempt counter ───────────────────────────────
  if (action === 'mark_attempt') {
    if (!id) return err('id required', 400);
    await env.DB.prepare(
      'UPDATE casino_withdrawals SET attempts = COALESCE(attempts, 0) + 1, last_attempt_at = ? WHERE id = ?'
    ).bind(now, id).run();
    return ok({ marked: true });
  }

  // ── Skip card ─────────────────────────────────────────────────────────────
  if (action === 'skip_card') {
    if (!id) return err('id required', 400);
    const entry = await env.DB.prepare(
      'SELECT id, target_card_id, skipped_cards FROM casino_withdrawals WHERE id=?'
    ).bind(id).first();
    if (!entry) return err('Not found', 404);
    const skipped = new Set(entry.skipped_cards ? JSON.parse(entry.skipped_cards) : []);
    if (entry.target_card_id) skipped.add(entry.target_card_id);
    await env.DB.prepare(
      "UPDATE casino_withdrawals SET target_card_id=NULL, skipped_cards=?, status='pending' WHERE id=?"
    ).bind(JSON.stringify([...skipped]), id).run();
    return ok({ skipped: [...skipped] });
  }

  // ── Update notes ──────────────────────────────────────────────────────────
  if (action === 'update_notes') {
    if (!id) return err('id required', 400);
    const notes = url.searchParams.get('notes') || '';
    await env.DB.prepare(
      'UPDATE casino_withdrawals SET notes=? WHERE id=?'
    ).bind(notes.slice(0, 500), id).run();
    return ok({ updated: true });
  }

  return err('Unknown action', 400);
}

export const onRequestGet  = handleRequest;
export const onRequestPost = handleRequest;
