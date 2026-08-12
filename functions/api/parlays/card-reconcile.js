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
  { sport: 'mlb', season: '2026' },
  { sport: 'nba', season: '2026' },
  { sport: 'nhl', season: '2026' },
  { sport: 'mlb', season: '2025' },
  { sport: 'mlb', season: '2024' },
  { sport: 'nba', season: '2025' },
  { sport: 'nba', season: '2024' },
  { sport: 'nhl', season: '2025' },
  { sport: 'nhl', season: '2024' },
  { sport: 'nfl', season: '2024' },
  { sport: 'nfl', season: '2023' },
  { sport: 'ufc', season: '2023' },
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
const PAGE_SIZE = 10;

async function fetchCardPage(sport, season, offset, hdrs) {
  try {
    const url =
      `https://web.realapp.com/collectingcards/${sport}/season/${season}/entity/play` +
      `/user/${EDGEBOT_USER}/cards?includeRecommendations=true&rarity=all&view=rating&offset=${offset}`;
    const res = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return { ids: [], done: true, httpStatus: res.status };
    const data  = await res.json();
    const cards = data.cards || [];
    // Explicitly verify userId matches edgebot — defense against RS returning non-owned cards.
    const ids   = cards.filter(c => c.userId === EDGEBOT_USER).map(c => c.id).filter(id => id != null).map(Number);
    // RS returns cardCount:0 always — can't trust it. Done when we get a partial page.
    return { ids, done: ids.length < PAGE_SIZE, httpStatus: 200 };
  } catch (e) { return { ids: [], done: true, error: e.message }; }
}

// Fetch all cards edgebot owns across all configured sports.
// Returns { owned: Set<number>, sportStats: Array } for both normal and debug use.
// NOTE: RS returns cardCount:0 always, so we paginate until we get a partial page.
async function fetchEdgebotOwnedCardIds(authInfo, sessionToken) {
  const owned      = new Set();
  const sportStats = [];
  const hdrs       = buildHeaders(authInfo, sessionToken);

  for (const { sport, season } of CARD_SPORTS) {
    let offset    = 0;
    let totalFound = 0;
    let pages     = 0;
    let lastStatus;

    while (true) {
      const page = await fetchCardPage(sport, season, offset, hdrs);
      lastStatus = page.httpStatus;
      for (const id of page.ids) owned.add(id);
      totalFound += page.ids.length;
      pages++;
      if (page.done) break;
      offset += PAGE_SIZE;
    }

    sportStats.push({ sport, season, found: totalFound, pages, httpStatus: lastStatus });
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
  if (!authInfo) return err('EDGEBOT_AUTH_INFO not configured', 500);

  // 0. Free cards assigned to parlays that have reached a terminal state.
  try {
    // 0a. Expire pending_deposit parlays whose window has closed.
    await env.DB.prepare(
      "UPDATE parlays SET status='expired' WHERE status='pending_deposit' AND expires_at < unixepoch()"
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
  const { results: poolRows } = await env.DB.prepare(
    'SELECT card_id, assigned_to_parlay_id FROM deposit_cards'
  ).all();

  if (!poolRows.length) return ok({ poolSize: 0, removed: 0, reason: 'pool_empty' });

  // 2. Fetch edgebot's actual RS card inventory
  const { owned, sportStats } = await fetchEdgebotOwnedCardIds(authInfo, sessionToken);

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
    return ok({ poolSize: poolRows.length, removed: 0, reason: 'rs_returned_empty_may_be_auth_error', sportStats });
  }

  // 3a. Stamp verified_at on every card edgebot still owns (used by place.js to gate assignment).
  const now = Math.floor(Date.now() / 1000);
  const poolCardIds   = new Set(poolRows.map(r => r.card_id));
  const ownedPoolIds  = poolRows.filter(r => owned.has(r.card_id)).map(r => r.card_id);
  if (ownedPoolIds.length) {
    await env.DB.batch(
      ownedPoolIds.map(id =>
        env.DB.prepare('UPDATE deposit_cards SET verified_at=? WHERE card_id=?').bind(now, id)
      )
    );
  }

  // 3b-new. Insert cards edgebot owns that aren't in the pool yet (e.g. fresh auction wins).
  const newCardIds = [...owned].filter(id => !poolCardIds.has(id));
  if (newCardIds.length) {
    await env.DB.batch(
      newCardIds.map(id =>
        env.DB.prepare('INSERT OR IGNORE INTO deposit_cards (card_id, verified_at) VALUES (?,?)').bind(id, now)
      )
    );
  }

  // 3b. Find ghost cards: in pool but not in edgebot's RS inventory.
  //    Split into two groups:
  //    a) Unassigned ghosts — safe to delete immediately.
  //    b) Assigned ghosts — edgebot sold the card after it was reserved for a parlay.
  //       Void the parlay so the user can retry, then delete the card.
  const unassignedGhosts = poolRows.filter(r => !owned.has(r.card_id) && r.assigned_to_parlay_id == null);
  const assignedGhosts   = poolRows.filter(r => !owned.has(r.card_id) && r.assigned_to_parlay_id != null);

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
