// functions/api/parlays/payout.js
// POST /api/parlays/payout?_cron_key=CRON_SECRET
// Processes pending payout_queue entries — called every 60s by alert-cron.
//
// Flow per entry:
//   1. Find winner's cheapest unowned RS card (MLB 2026 → NBA 2025-26 → NHL 2025-26)
//   2. Solve Cloudflare Turnstile via CapSolver (~3-7s)
//   3. POST /cardmarketplaceoffers — @edgebot offers payout_rax on the winner's card
//   4. Winner receives offer_amount × 0.9 in their RS balance when they accept
//
// Processes max 2 entries per run to stay within CF's 30s wall-clock limit.

import { hashidsEncode } from '../../_lib/hashids.js';
import { ok, err }       from '../../_lib/response.js';

const RS_DEVICE_UUID = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';
const CAPSOLVER_SITEKEY = '0x4AAAAAADHHMQ4l_2uyXqiu';

// Sports/seasons tried in order when searching for a winner's unowned card.
// Ratingasc = cheapest (lowest FMV) card first — safest to buy as a payout vehicle.
const CARD_TARGETS = [
  ['mlb', '2026',    'play'],
  ['nba', '2025-26', 'play'],
  ['nhl', '2025-26', 'play'],
];

function buildHeaders(authInfo, sessionToken) {
  return {
    'Accept':             'application/json',
    'Content-Type':       'application/json',
    'Origin':             'https://www.realapp.com',
    'Referer':            'https://www.realapp.com/',
    'User-Agent':         'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
    'real-auth-info':     authInfo,
    'real-session-token': sessionToken,
    'real-device-uuid':   RS_DEVICE_UUID,
    'real-device-type':   'desktop_web',
    'real-device-name':   '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
    'real-version':       '35',
    'real-request-token': hashidsEncode(Date.now()),
  };
}

async function solveTurnstile(capsolverKey) {
  const createRes = await fetch('https://api.capsolver.com/createTask', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: capsolverKey,
      task: {
        type:       'AntiTurnstileTaskProxyLess',
        websiteURL: 'https://www.realapp.com/',
        websiteKey: CAPSOLVER_SITEKEY,
      },
    }),
    signal: AbortSignal.timeout(10000),
  });
  const created = await createRes.json();
  if (created.errorId !== 0 || !created.taskId)
    throw new Error('CapSolver create task failed: ' + (created.errorCode || 'unknown'));

  // Poll up to 15 times at 1s intervals (~15s max; Turnstile usually solves in 3-7s)
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const pollRes = await fetch('https://api.capsolver.com/getTaskResult', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ clientKey: capsolverKey, taskId: created.taskId }),
      signal:  AbortSignal.timeout(8000),
    });
    const poll = await pollRes.json();
    if (poll.status === 'ready')  return poll.solution.token;
    if (poll.status === 'failed') throw new Error('CapSolver solve failed');
  }
  throw new Error('CapSolver timeout — no result after 15s');
}

async function findUnownedCard(rsUserId, authInfo, sessionToken) {
  for (const [sport, season, entity] of CARD_TARGETS) {
    try {
      const url =
        `https://web.realapp.com/collectingcards/${sport}/season/${season}/entity/${entity}` +
        `/user/${rsUserId}/cards?filterCustomType=unowned&includeRecommendations=false&rarity=all&view=ratingasc`;
      const res = await fetch(url, {
        headers: buildHeaders(authInfo, sessionToken),
        signal:  AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const data  = await res.json();
      const cards = Array.isArray(data) ? data : (data.cards || data.items || []);
      if (cards.length > 0) {
        const card = cards[0];
        return card.id ?? card.cardId ?? null;
      }
    } catch { continue; }
  }
  return null;
}

async function postOffer(cardId, offerAmount, turnstileToken, authInfo, sessionToken) {
  const res = await fetch('https://web.realapp.com/cardmarketplaceoffers', {
    method:  'POST',
    headers: {
      ...buildHeaders(authInfo, sessionToken),
      'real-turnstile-token': turnstileToken,
    },
    body: JSON.stringify({
      listingType:          'card',
      cardId:               cardId,
      offerAmount:          offerAmount,
      durationInHours:      48,
      notificationSettings: {},
    }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`RS ${res.status}: ${text.slice(0, 200)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('RS offer response not JSON: ' + text.slice(0, 200)); }
  // RS may return the offer ID under various field names or nested
  const offerId = data.id ?? data.offerId ?? data.offer?.id ?? data.cardOffer?.id
    ?? data.cardmarketplaceoffer?.id ?? data.result?.id ?? null;
  if (!offerId) throw new Error('RS offer posted but no offer ID in response: ' + JSON.stringify(data).slice(0, 300));
  return offerId;
}

export const onRequestGet = onRequestPost;
export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  if (!env.CRON_SECRET || url.searchParams.get('_cron_key') !== env.CRON_SECRET)
    return err('Unauthorized', 401);

  const authInfo     = env.EDGEBOT_AUTH_INFO;
  const sessionToken = env.EDGEBOT_SESSION_TOKEN;
  const capsolverKey = env.CAPSOLVER_API_KEY;

  if (!authInfo || !sessionToken) return err('EDGEBOT_AUTH_INFO / EDGEBOT_SESSION_TOKEN not configured', 500);
  if (!capsolverKey)              return err('CAPSOLVER_API_KEY not configured', 500);

  const now = Math.floor(Date.now() / 1000);

  // Pull up to 2 pending entries — sequential processing keeps us within CF 30s wall clock
  const { results: queue } = await env.DB.prepare(
    'SELECT q.id, q.parlay_id, q.user_id, q.offer_amount, q.attempts, ' +
    'ra.rs_user_id ' +
    'FROM payout_queue q ' +
    'LEFT JOIN real_auth ra ON ra.user_id = q.user_id ' +
    'WHERE q.status = ? ' +
    'ORDER BY q.created_at ASC LIMIT 2'
  ).bind('pending').all();

  if (!queue.length) return ok({ processed: 0 });

  const results = [];

  for (const entry of queue) {
    // Increment attempt counter before doing any work
    await env.DB.prepare(
      'UPDATE payout_queue SET attempts=attempts+1, last_attempt_at=? WHERE id=?'
    ).bind(now, entry.id).run();

    if (!entry.rs_user_id) {
      await env.DB.prepare(
        "UPDATE payout_queue SET status='failed', notes=? WHERE id=?"
      ).bind('Winner has no rs_user_id in real_auth — connect RS account required', entry.id).run();
      results.push({ parlayId: entry.parlay_id, result: 'failed', reason: 'no_rs_user_id' });
      continue;
    }

    // Step 1 — find cheapest unowned card in winner's RS portfolio
    let cardId = null;
    try { cardId = await findUnownedCard(entry.rs_user_id, authInfo, sessionToken); }
    catch (e) { cardId = null; }

    if (!cardId) {
      await env.DB.prepare(
        'UPDATE payout_queue SET notes=? WHERE id=?'
      ).bind('No unowned cards found across MLB/NBA/NHL — will retry or needs manual payout', entry.id).run();
      results.push({ parlayId: entry.parlay_id, result: 'no_card' });
      continue; // stays pending; retried next cron run
    }

    // Step 2 — solve Turnstile
    let turnstileToken;
    try { turnstileToken = await solveTurnstile(capsolverKey); }
    catch (e) {
      await env.DB.prepare(
        'UPDATE payout_queue SET notes=? WHERE id=?'
      ).bind('Turnstile solve failed: ' + e.message, entry.id).run();
      results.push({ parlayId: entry.parlay_id, result: 'turnstile_failed', error: e.message });
      continue;
    }

    // Step 3 — post offer on the winner's card
    let rsOfferId;
    try { rsOfferId = await postOffer(cardId, entry.offer_amount, turnstileToken, authInfo, sessionToken); }
    catch (e) {
      await env.DB.prepare(
        "UPDATE payout_queue SET status='failed', target_card_id=?, notes=? WHERE id=?"
      ).bind(cardId, 'RS offer failed: ' + e.message, entry.id).run();
      results.push({ parlayId: entry.parlay_id, result: 'offer_failed', error: e.message });
      continue;
    }

    // Mark sent
    await env.DB.prepare(
      "UPDATE payout_queue SET status='sent', rs_offer_id=?, target_card_id=?, sent_at=? WHERE id=?"
    ).bind(rsOfferId, cardId, now, entry.id).run();

    results.push({ parlayId: entry.parlay_id, result: 'sent', offerId: rsOfferId, cardId });
  }

  const sent   = results.filter(r => r.result === 'sent').length;
  const noCard = results.filter(r => r.result === 'no_card').length;
  const failed = results.filter(r => !['sent', 'no_card'].includes(r.result)).length;

  return ok({ processed: queue.length, sent, noCard, failed, results });
}
