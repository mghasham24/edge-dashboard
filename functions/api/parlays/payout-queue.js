// functions/api/parlays/payout-queue.js
// Admin-only payout queue management (manual payout flow).
// GET  ?action=list         — return all payout queue entries
// POST ?action=prepare&id=N — find a target card in the winner's RS inventory, return its URL
// POST ?action=mark_sent&id=N — mark an entry as manually sent

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
    'real-version':       '35',
    'real-request-token': hashidsEncode(Date.now()),
  };
}

// Same priority order as payout.js CARD_TARGETS
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
        if (id && !skipIds.has(id)) return id;
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
    const { results } = await env.DB.prepare(
      'SELECT q.id, q.parlay_id, q.rs_username, q.payout_rax, q.offer_amount, ' +
      'q.status, q.target_card_id, q.rs_offer_id, q.attempts, q.notes, ' +
      'q.created_at, q.sent_at, q.skipped_cards, ra.rs_user_id ' +
      'FROM payout_queue q LEFT JOIN real_auth ra ON ra.user_id = q.user_id ' +
      'ORDER BY q.created_at DESC LIMIT 100'
    ).all();

    const rows = results || [];
    const parlayIds = [...new Set(rows.map(r => r.parlay_id).filter(Boolean))];
    let legsByParlay = {};
    if (parlayIds.length > 0) {
      const ph = parlayIds.map(() => '?').join(',');
      const { results: legs } = await env.DB.prepare(
        `SELECT parlay_id, player_name, market_type, label, direction, threshold, american_odds, status, result_value, event_name, sport FROM parlay_legs WHERE parlay_id IN (${ph}) ORDER BY id`
      ).bind(...parlayIds).all();
      for (const leg of (legs || [])) {
        if (!legsByParlay[leg.parlay_id]) legsByParlay[leg.parlay_id] = [];
        legsByParlay[leg.parlay_id].push(leg);
      }
    }

    return ok({
      queue: rows.map(r => ({
        ...r,
        card_url: r.target_card_id
          ? 'https://www.realapp.com/' + rsUrlEncode(20, 0, 0, r.target_card_id)
          : null,
        legs: legsByParlay[r.parlay_id] || [],
      })),
    });
  }

  // ── Prepare: find a card in the winner's RS inventory ────────────────────
  if (action === 'prepare') {
    if (!id) return err('id required', 400);

    const entry = await env.DB.prepare(
      'SELECT q.id, q.offer_amount, q.skipped_cards, ra.rs_user_id ' +
      'FROM payout_queue q LEFT JOIN real_auth ra ON ra.user_id = q.user_id WHERE q.id=?'
    ).bind(id).first();
    if (!entry)            return err('Not found', 404);
    if (!entry.rs_user_id) return err('Winner has no RS account connected', 400);

    const authInfo     = env.EDGEBOT_AUTH_INFO;
    const sessionToken = env.EDGEBOT_SESSION_TOKEN || '';
    if (!authInfo) return err('EDGEBOT_AUTH_INFO not configured', 500);

    const skippedIds = new Set(entry.skipped_cards ? JSON.parse(entry.skipped_cards) : []);

    // Exclude cards in the deposit pool
    try {
      const { results: pool } = await env.DB.prepare('SELECT card_id FROM deposit_cards').all();
      for (const r of (pool || [])) skippedIds.add(r.card_id);
    } catch (_) {}

    const cardId = await findUnownedCard(entry.rs_user_id, authInfo, sessionToken, skippedIds);
    if (!cardId) return err('No eligible cards found for this winner', 404);

    const cardUrl = 'https://www.realapp.com/' + rsUrlEncode(20, 0, 0, cardId);

    await env.DB.prepare(
      'UPDATE payout_queue SET target_card_id=?, last_attempt_at=? WHERE id=?'
    ).bind(cardId, now, id).run();

    return ok({ cardId, cardUrl, offerAmount: entry.offer_amount });
  }

  // ── Mark sent ──────────────────────────────────────────────────────────────
  if (action === 'mark_sent') {
    if (!id) return err('id required', 400);
    const result = await env.DB.prepare(
      "UPDATE payout_queue SET status='sent', sent_at=? WHERE id=? AND status='pending'"
    ).bind(now, id).run();
    return ok({ marked: true, changed: result.meta?.changes ?? 1 });
  }

  // ── Skip card: mark the current target_card_id as skipped ─────────────────
  if (action === 'skip_card') {
    if (!id) return err('id required', 400);
    const entry = await env.DB.prepare(
      'SELECT id, target_card_id, skipped_cards FROM payout_queue WHERE id=?'
    ).bind(id).first();
    if (!entry) return err('Not found', 404);
    const skipped = new Set(entry.skipped_cards ? JSON.parse(entry.skipped_cards) : []);
    if (entry.target_card_id) skipped.add(entry.target_card_id);
    await env.DB.prepare(
      'UPDATE payout_queue SET target_card_id=NULL, skipped_cards=? WHERE id=?'
    ).bind(JSON.stringify([...skipped]), id).run();
    return ok({ skipped: [...skipped] });
  }

  return err('Unknown action', 400);
}

export const onRequestGet  = handleRequest;
export const onRequestPost = handleRequest;
