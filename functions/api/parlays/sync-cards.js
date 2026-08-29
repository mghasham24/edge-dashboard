// functions/api/parlays/sync-cards.js
// GET /api/parlays/sync-cards?_cron_key=CRON_SECRET
// Fetches all of @edgebot's cards from RS API across sports/seasons.
// Upserts new card IDs into deposit_cards; deletes sold cards (unassigned only).
// Safe to run daily or manually.

import { hashidsEncode } from '../../_lib/hashids.js';
import { ok, err }       from '../../_lib/response.js';

const RS_DEVICE_UUID = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';
const EDGEBOT_USER   = 'V3yGgkkJ';

// All sport/season combos to scan for deposit account's cards.
// Parlays use mlb/2025; casino uses nba/2026 — kept separate to prevent pool exhaustion.
const CARD_SOURCES = [
  { sport: 'mlb', season: 2025 },
  { sport: 'nba', season: 2026 },
];

function buildHeaders(authInfo, sessionToken) {
  const h = {
    'Accept':           'application/json',
    'Content-Type':     'application/json',
    'Origin':           'https://www.realapp.com',
    'Referer':          'https://www.realapp.com/',
    'User-Agent':       'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
    'real-auth-info':   authInfo,
    'real-device-uuid': RS_DEVICE_UUID,
    'real-device-type': 'desktop_web',
    'real-device-name': '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
    'real-version':     '36',
    'real-request-token': hashidsEncode(Date.now()),
  };
  if (sessionToken) {
    h['real-session-token'] = sessionToken;
    h['Cookie'] = `real-session-token=${sessionToken}`;
  }
  return h;
}

async function fetchCardPage(sport, season, offset, authInfo, sessionToken) {
  const url = `https://web.realapp.com/collectingcards/${sport}/season/${season}/entity/play/user/${EDGEBOT_USER}/cards` +
    `?includeRecommendations=true&rarity=all&view=rating&offset=${offset}`;
  const res = await fetch(url, {
    headers: buildHeaders(authInfo, sessionToken),
    signal:  AbortSignal.timeout(12000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { cards: [], total: 0, status: res.status, errorBody: body.slice(0, 200) };
  }
  const data = await res.json();
  return {
    cards: data.cards || [],
    status: res.status,
  };
}

async function fetchAllCards(sport, season, authInfo, sessionToken) {
  const ids = [];
  const PAGE_SIZE = 10;
  const MAX_PAGES = 50; // safety cap: 500 cards max
  const pageLog = [];
  let offset = 0;

  for (let p = 0; p < MAX_PAGES; p++) {
    if (p > 0) await new Promise(r => setTimeout(r, 300));
    const page = await fetchCardPage(sport, season, offset, authInfo, sessionToken);
    pageLog.push({ offset, count: page.cards.length, status: page.status });
    for (const c of page.cards) if (c.id) ids.push(c.id);
    if (page.cards.length < PAGE_SIZE) break; // last page
    offset += PAGE_SIZE;
  }

  return { ids, pageLog };
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (!env.CRON_SECRET || url.searchParams.get('_cron_key') !== env.CRON_SECRET) {
    return err('Unauthorized', 401);
  }

  const authInfo     = env.EDGEBOT_AUTH_INFO;
  const sessionToken = env.EDGEBOT_SESSION_TOKEN;
  if (!authInfo) return err('EDGEBOT_AUTH_INFO not configured', 500);

  // Cards already consumed by any live/active parlay — never re-pool these.
  const usedRows = await env.DB.prepare(
    "SELECT DISTINCT deposit_card_id FROM parlays WHERE deposit_card_id IS NOT NULL AND status NOT IN ('expired','void','cancelled')"
  ).all();
  const usedCardIds = new Set((usedRows.results || []).map(r => r.deposit_card_id));

  const syncNow   = Math.floor(Date.now() / 1000);
  const allPageLogs = [];
  let totalInserted = 0, totalDeleted = 0, totalCards = 0;

  // Fetch all card sources in parallel, then process each sport/season independently
  // so each card is stored with its sport+season tag for pool isolation.
  const fetched = await Promise.allSettled(
    CARD_SOURCES.map(({ sport, season }) =>
      fetchAllCards(sport, season, authInfo, sessionToken).then(r => ({ sport, season: String(season), ...r }))
    )
  );

  let anyFetched = false;
  for (const result of fetched) {
    if (result.status !== 'fulfilled') continue;
    const { sport, season, ids, pageLog } = result.value;
    allPageLogs.push(...pageLog);
    if (!ids.length) continue;
    anyFetched = true;
    totalCards += ids.length;

    const allIds = new Set(ids);

    // Existing cards for this sport/season only
    const existing = await env.DB.prepare(
      'SELECT card_id FROM deposit_cards WHERE sport=? AND season=?'
    ).bind(sport, season).all();
    const existingSet = new Set((existing.results || []).map(r => r.card_id));

    const toInsert = [...allIds].filter(id => !existingSet.has(id) && !usedCardIds.has(id));
    if (toInsert.length) {
      await env.DB.batch(
        toInsert.map(id =>
          env.DB.prepare(
            'INSERT OR IGNORE INTO deposit_cards (card_id, verified_at, sport, season) VALUES (?,?,?,?)'
          ).bind(id, syncNow, sport, season)
        )
      );
      totalInserted += toInsert.length;
    }

    const toVerify = [...allIds].filter(id => existingSet.has(id));
    if (toVerify.length) {
      await env.DB.batch(
        toVerify.map(id =>
          env.DB.prepare('UPDATE deposit_cards SET verified_at=? WHERE card_id=?').bind(syncNow, id)
        )
      );
    }

    const toDelete = [...existingSet].filter(id => !allIds.has(id));
    if (toDelete.length) {
      await env.DB.batch(
        toDelete.map(id =>
          env.DB.prepare(
            'DELETE FROM deposit_cards WHERE card_id=? AND assigned_to_parlay_id IS NULL'
          ).bind(id)
        )
      );
      totalDeleted += toDelete.length;
    }
  }

  if (!anyFetched) return err('No cards fetched from RS — check EDGEBOT_AUTH_INFO', 502);

  return ok({
    total:    totalCards,
    inserted: totalInserted,
    deleted:  totalDeleted,
    sources:  CARD_SOURCES.length,
    pages:    allPageLogs,
  });
}
