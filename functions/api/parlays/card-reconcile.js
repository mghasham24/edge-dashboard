// functions/api/parlays/card-reconcile.js
// POST /api/parlays/card-reconcile?_cron_key=CRON_SECRET
// GET  /api/parlays/card-reconcile?_cron_key=CRON_SECRET&debug
//
// Fetches edgebot's actual RS card inventory and removes any deposit_cards
// rows for cards edgebot no longer owns (sold outside the parlay system).
// Wired into alert-cron every 5 minutes.

import { hashidsEncode } from '../../_lib/hashids.js';
import { ok, err }       from '../../_lib/response.js';
import { getSession }    from '../../_lib/session.js';

const RS_DEVICE_UUID = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';

// All sport/season combos edgebot may hold cards in (mirrors sync-cards.js CARD_SOURCES).
// The RS collectingcards URL takes the auth TOKEN (first segment of auth-info) as the
// "user" path parameter — NOT the account user ID.
// Season format: sync-cards.js uses plain years (2025, 2024) — NOT '2025-26' style.
const CARD_SPORTS = [
  { sport: 'mlb', season: '2025' },
];

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

// RS collectingcards URL takes the RS user ID in the path, same as sync-cards.js.
const EDGEBOT_USER = 'V3yGgkkJ';
const PAGE_SIZE    = 10;
const MAX_PAGES    = 30; // 30 × 10 = 300 cards max — fetched in parallel so all fire at once

async function fetchCardPage(sport, season, offset, hdrs) {
  try {
    const url =
      `https://web.realapp.com/collectingcards/${sport}/season/${season}/entity/play` +
      `/user/${EDGEBOT_USER}/cards?includeRecommendations=true&rarity=all&view=rating&offset=${offset}`;
    const res = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ids: [], httpStatus: res.status };
    const data  = await res.json();
    const cards = data.cards || [];
    const ids   = cards.map(c => c.id || c.cardId || null).filter(id => id != null).map(Number);
    return { ids, httpStatus: 200 };
  } catch (e) { return { ids: [], httpStatus: 0, error: e.message }; }
}

// Fetch all cards for one sport/season in parallel to avoid CF's 30s wall clock.
// Sequential paging at 1-2s per page would timeout with large card pools (179+ cards = 18 pages).
// RS returns an empty array for out-of-range offsets so parallel over-fetch is safe.
async function fetchAllForSport(sport, season, hdrs) {
  const settled = await Promise.allSettled(
    Array.from({ length: MAX_PAGES }, (_, i) =>
      fetchCardPage(sport, season, i * PAGE_SIZE, hdrs)
    )
  );
  const allIds = [];
  let httpStatus = 0;
  for (let i = 0; i < settled.length; i++) {
    if (settled[i].status !== 'fulfilled') continue;
    const { ids, httpStatus: hs } = settled[i].value;
    if (i === 0) httpStatus = hs;
    allIds.push(...ids);
  }
  return { ids: allIds, httpStatus };
}

// Fetch all cards edgebot owns across all configured sports.
// Runs all sport/season combos in parallel; within each combo pages sequentially.
async function fetchEdgebotOwnedCardIds(authInfo, sessionToken) {
  const hdrs = buildHeaders(authInfo, sessionToken);

  const results = await Promise.all(
    CARD_SPORTS.map(async ({ sport, season }) => {
      const { ids, httpStatus } = await fetchAllForSport(sport, season, hdrs);
      return { sport, season, ids, httpStatus };
    })
  );

  const owned      = new Set();
  const sportStats = [];
  for (const { sport, season, ids, httpStatus } of results) {
    for (const id of ids) owned.add(id);
    sportStats.push({ sport, season, found: ids.length, httpStatus });
  }

  return { owned, sportStats };
}

async function handleRequest({ request, env }) {
  const url     = new URL(request.url);
  const cronKey = url.searchParams.get('_cron_key');
  const debug   = url.searchParams.has('debug');

  // Auth: cron key OR admin session
  if (!env.CRON_SECRET || cronKey !== env.CRON_SECRET) {
    const session = await getSession(request, env.DB);
    const userRow = session
      ? await env.DB.prepare('SELECT is_admin FROM users WHERE id=?').bind(session.user_id).first()
      : null;
    if (!userRow?.is_admin) return err('Unauthorized', 401);
  }

  const authInfo     = env.EDGEBOT_AUTH_INFO;
  const sessionToken = env.EDGEBOT_SESSION_TOKEN || '';
  try {
    const _dbgnow = Math.floor(Date.now()/1000);
    await env.DB.prepare(
      "INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES('card_reconcile_debug',?,?) " +
      "ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at"
    ).bind(JSON.stringify({ step:'auth_check', hasAuthInfo: !!authInfo, authInfoLen: authInfo?.length, hasSession: !!sessionToken, sessionLen: sessionToken?.length }), _dbgnow).run();
  } catch(_) {}
  if (!authInfo) return err('EDGEBOT_AUTH_INFO not configured', 500);

  // 0. Free cards assigned to parlays that have reached a terminal state.
  try {
    // 0a. Expire pending_deposit parlays — use same 90-min buffer as deposit-check so we
    // never expire a parlay before deposit-check has had time to detect an accepted offer.
    await env.DB.prepare(
      "UPDATE parlays SET status='expired' WHERE status='pending_deposit' AND expires_at < unixepoch() - 5400"
    ).run();

    // 0b. Free cards held by any terminal-state parlay.
    await env.DB.prepare(
      "UPDATE deposit_cards SET assigned_to_parlay_id = NULL, assigned_at = NULL " +
      "WHERE assigned_to_parlay_id IN (" +
      "  SELECT id FROM parlays WHERE status IN ('won','lost','void','voided','expired')" +
      ")"
    ).run();
  } catch (_) { /* non-fatal — continue to stamp verified_at */ }

  // 1. Load all pool cards (assigned AND unassigned — a sold card could be assigned to an
  //    active parlay that was already deposited, so only remove truly unassigned ghost cards)
  let poolRows;
  try {
    const res = await env.DB.prepare(
      'SELECT card_id, assigned_to_parlay_id, assigned_at FROM deposit_cards'
    ).all();
    poolRows = res.results || [];
  } catch (e) {
    try {
      await env.DB.prepare(
        "INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES('card_reconcile_owned',?,?) " +
        "ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at"
      ).bind(JSON.stringify({ crash: 'pool_query', error: e.message }), Math.floor(Date.now()/1000)).run();
    } catch(_) {}
    return err('pool query failed: ' + e.message, 500);
  }

  if (!poolRows.length) return ok({ poolSize: 0, removed: 0, reason: 'pool_empty' });

  // 2. Fetch edgebot's actual RS card inventory
  let owned, sportStats;
  try {
    ({ owned, sportStats } = await fetchEdgebotOwnedCardIds(authInfo, sessionToken));
  } catch (e) {
    try {
      await env.DB.prepare(
        "INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES('card_reconcile_owned',?,?) " +
        "ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at"
      ).bind(JSON.stringify({ crash: 'rs_fetch', error: e.message }), Math.floor(Date.now()/1000)).run();
    } catch(_) {}
    return err('RS fetch crashed: ' + e.message, 500);
  }

  if (debug) {
    return new Response(JSON.stringify({
      ownedCount: owned.size,
      sportStats,
      ownedIds:   [...owned].sort((a, b) => a - b),
      pool: poolRows.map(r => ({
        card_id:              r.card_id,
        assigned_to_parlay_id: r.assigned_to_parlay_id,
        stillOwned:           owned.has(r.card_id),
      })),
    }, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }

  if (!owned.size) {
    try {
      await env.DB.prepare(
        "INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES('card_reconcile_owned',?,?) " +
        "ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at"
      ).bind(JSON.stringify({ owned: 0, sportStats }), Math.floor(Date.now()/1000)).run();
    } catch(_) {}
    return ok({ poolSize: poolRows.length, removed: 0, reason: 'rs_returned_empty_may_be_auth_error', sportStats });
  }

  // 3a. Stamp verified_at on every card edgebot still owns (used by place.js to gate assignment).
  // Also clear freed_at — a card that was released by a user cancel but is confirmed still owned
  // by edgebot is safe to reassign. Without clearing freed_at the card is permanently blocked.
  const now = Math.floor(Date.now() / 1000);
  const poolCardIds   = new Set(poolRows.map(r => r.card_id));
  const ownedPoolIds  = poolRows.filter(r => owned.has(r.card_id)).map(r => r.card_id);
  try {
    await env.DB.prepare(
      "INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES('card_reconcile_debug',?,?) " +
      "ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at"
    ).bind(JSON.stringify({
      ownedSize: owned.size, ownedPoolIds: ownedPoolIds.length,
      poolSize: poolRows.length, sportStats,
      sampleOwned: [...owned].slice(0, 5),
      samplePool: poolRows.slice(0, 5).map(r => r.card_id),
    }), now).run();
  } catch(_) {}
  // D1 batch limit is 100 statements — chunk to 50 to stay safe with large card pools.
  async function batchChunked(stmts) {
    const CHUNK = 50;
    for (let i = 0; i < stmts.length; i += CHUNK) {
      await env.DB.batch(stmts.slice(i, i + CHUNK));
    }
  }

  if (ownedPoolIds.length) {
    await batchChunked(
      ownedPoolIds.map(id =>
        env.DB.prepare('UPDATE deposit_cards SET verified_at=?, freed_at=NULL WHERE card_id=?').bind(now, id)
      )
    );
  }

  // 3b-new. Insert cards edgebot owns that aren't in the pool yet (e.g. fresh auction wins).
  // Exclude cards recently used as deposit cards (within 2 hours) — card-reconcile running just
  // after deposit-check deletes a used card could re-insert it before RS reflects the transfer,
  // causing the same card to be assigned to a new parlay and matched to the stale accepted offer.
  const recentlyUsedRes = await env.DB.prepare(
    "SELECT deposit_card_id FROM parlays WHERE deposit_card_id IS NOT NULL AND deposited_at > ? AND status='active'"
  ).bind(now - 2 * 3600).all();
  const recentlyUsed = new Set((recentlyUsedRes.results || []).map(r => r.deposit_card_id));

  const newCardIds = [...owned].filter(id => !poolCardIds.has(id) && !recentlyUsed.has(id));
  if (newCardIds.length) {
    await batchChunked(
      newCardIds.map(id =>
        env.DB.prepare('INSERT OR IGNORE INTO deposit_cards (card_id, verified_at) VALUES (?,?)').bind(id, now)
      )
    );
  }

  // 3b. Find ghost cards: in pool but not in edgebot's RS inventory.
  //    Split into groups:
  //    a) Unassigned ghosts — safe to delete immediately.
  //    b) Assigned ghosts — card left edgebot's inventory while reserved for a parlay.
  //       If assigned within the last 90 min it's likely a legitimate deposit (user accepted
  //       counter-offer and the card transferred to them). Leave these alone — deposit-check
  //       will activate the parlay when it sees the accepted offer.
  //       Only void cards assigned more than 90 min ago (edgebot sold the card externally).
  const DEPOSIT_GRACE_SEC = 90 * 60;
  const unassignedGhosts = poolRows.filter(r => !owned.has(r.card_id) && r.assigned_to_parlay_id == null);
  const assignedGhosts   = poolRows.filter(r =>
    !owned.has(r.card_id) &&
    r.assigned_to_parlay_id != null &&
    // Fall back to `now` (not 0) when assigned_at is null — null means "just assigned"
    // and should get the full grace window rather than bypassing it.
    (now - (r.assigned_at ?? now)) > DEPOSIT_GRACE_SEC
  );

  const removed = unassignedGhosts.length + assignedGhosts.length;
  if (!removed) return ok({ poolSize: poolRows.length, added: newCardIds.length, removed: 0, owned: owned.size });

  // 4a. Delete unassigned ghost cards
  await Promise.all(unassignedGhosts.map(r =>
    env.DB.prepare('DELETE FROM deposit_cards WHERE card_id=?').bind(r.card_id).run()
  ));

  // 4b. Void parlays where edgebot no longer owns the assigned card, then delete the card.
  //     Only voids pending_deposit parlays — won/lost/active parlays already completed their deposit.
  if (assignedGhosts.length) {
    await Promise.all(assignedGhosts.map(r =>
      env.DB.batch([
        env.DB.prepare(
          "UPDATE parlays SET status='void', admin_notes='deposit_card_sold' WHERE id=? AND status='pending_deposit'"
        ).bind(r.assigned_to_parlay_id),
        env.DB.prepare('DELETE FROM deposit_cards WHERE card_id=?').bind(r.card_id),
      ])
    ));
  }

  return ok({
    poolSize:         poolRows.length,
    added:            newCardIds.length,
    removed,
    unassignedGhosts: unassignedGhosts.map(r => r.card_id),
    assignedGhosts:   assignedGhosts.map(r => ({ card_id: r.card_id, parlay_id: r.assigned_to_parlay_id })),
    owned:            owned.size,
  });
}

export const onRequestPost = handleRequest;
export const onRequestGet  = handleRequest;
