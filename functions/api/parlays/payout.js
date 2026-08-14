// functions/api/parlays/payout.js
// POST /api/parlays/payout?_cron_key=CRON_SECRET
// Processes pending payout_queue entries — called every 60s by alert-cron.
//
// Flow per entry:
//   1. Find winner's cheapest unowned RS card (MLB 2026 → NBA 2026 → NHL 2026 → NBA 2025 → NHL 2025)
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
// Matches the full CARD_SPORTS list in card-reconcile.js so no category is missed.
const CARD_TARGETS = [
  ['mlb', '2026', 'play'],
  ['nba', '2026', 'play'],
  ['nhl', '2026', 'play'],
  ['mlb', '2025', 'play'],
  ['nba', '2025', 'play'],
  ['nhl', '2025', 'play'],
  ['mlb', '2024', 'play'],
  ['nba', '2024', 'play'],
  ['nhl', '2024', 'play'],
  ['nfl', '2024', 'play'],
  ['nfl', '2023', 'play'],
  ['ufc', '2023', 'play'],
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

// Returns { candidates, debugLog }.
// candidates: up to `limit` unowned card IDs, cheapest first.
// debugLog: per-category result for debugging.
async function findUnownedCards(rsUserId, authInfo, sessionToken, limit = 5) {
  const candidates = [];
  const debugLog   = [];
  for (const [sport, season, entity] of CARD_TARGETS) {
    if (candidates.length >= limit) break;
    const cat = `${sport}/${season}`;
    try {
      const url =
        `https://web.realapp.com/collectingcards/${sport}/season/${season}/entity/${entity}` +
        `/user/${rsUserId}/cards?filterCustomType=unowned&includeRecommendations=false&rarity=all&view=rating`;
      const res = await fetch(url, {
        headers: buildHeaders(authInfo, sessionToken),
        signal:  AbortSignal.timeout(5000),
      });
      const rawText = await res.text();
      if (!res.ok) {
        debugLog.push({ cat, status: res.status, body: rawText.slice(0, 200) });
        continue;
      }
      let data;
      try { data = JSON.parse(rawText); } catch { debugLog.push({ cat, status: res.status, parseErr: true, body: rawText.slice(0, 200) }); continue; }
      const cards = Array.isArray(data) ? data : (data.cards || data.items || []);
      const before = candidates.length;
      for (const card of cards) {
        const id = card.id ?? card.cardId ?? null;
        if (id) candidates.push(id);
        if (candidates.length >= limit) break;
      }
      debugLog.push({ cat, status: res.status, total: cards.length, added: candidates.length - before, topKeys: Object.keys(Array.isArray(data) ? (data[0] || {}) : data).slice(0, 8) });
    } catch (e) {
      debugLog.push({ cat, err: e.message });
      continue;
    }
  }
  return { candidates, debugLog };
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

  // Pull up to 2 pending entries — enforce 5-min minimum between retries so we don't
  // hammer RS's 500 offers/day limit. On 429, last_attempt_at is set 1h into the future
  // (now + 3600) so the entry is skipped for ~65 min before the next pickup.
  const { results: queue } = await env.DB.prepare(
    'SELECT q.id, q.parlay_id, q.user_id, q.offer_amount, q.attempts, ' +
    'ra.rs_user_id ' +
    'FROM payout_queue q ' +
    'LEFT JOIN real_auth ra ON ra.user_id = q.user_id ' +
    'WHERE q.status = ? AND (q.last_attempt_at IS NULL OR q.last_attempt_at < ?) ' +
    'ORDER BY q.created_at ASC LIMIT 2'
  ).bind('pending', now - 300).all();

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

    // Step 1 — find up to 5 cheapest unowned cards in winner's RS portfolio,
    // then exclude any cards currently in the deposit pool. A deposit pool card appearing
    // in outgoingAccepted (payout accepted) shares a card ID with an active deposit card,
    // which causes deposit-check to false-activate a parlay from the payout offer.
    let candidates = [], cardDebugLog = [];
    try {
      const found = await findUnownedCards(entry.rs_user_id, authInfo, sessionToken, 5);
      candidates    = found.candidates;
      cardDebugLog  = found.debugLog;
    }
    catch (e) { cardDebugLog = [{ err: e.message }]; }

    if (candidates.length) {
      try {
        const { results: poolRows } = await env.DB.prepare('SELECT card_id FROM deposit_cards').all();
        const depositPoolIds = new Set((poolRows || []).map(r => r.card_id));
        candidates = candidates.filter(id => !depositPoolIds.has(id));
      } catch (_) { /* non-fatal — proceed with unfiltered candidates */ }
    }

    if (!candidates.length) {
      const debugNote = JSON.stringify({ ts: Math.floor(Date.now()/1000), log: cardDebugLog }).slice(0, 500);
      await env.DB.prepare(
        'UPDATE payout_queue SET notes=? WHERE id=?'
      ).bind('No unowned cards — debug: ' + debugNote, entry.id).run();
      results.push({ parlayId: entry.parlay_id, result: 'no_card' });
      continue; // stays pending; retried next cron run
    }

    // Step 2+3 — try each candidate card until one goes through.
    // Each attempt needs a fresh Turnstile token since they are single-use.
    // "Listed in marketplace" → skip to next card. Any other error → stop and mark failed.
    let entrySent = false;
    let lastError = null;

    for (const cardId of candidates) {
      let turnstileToken;
      try { turnstileToken = await solveTurnstile(capsolverKey); }
      catch (e) {
        // Turnstile failure is global — no point trying more cards this run
        await env.DB.prepare(
          'UPDATE payout_queue SET notes=? WHERE id=?'
        ).bind('Turnstile solve failed: ' + e.message, entry.id).run();
        results.push({ parlayId: entry.parlay_id, result: 'turnstile_failed', error: e.message });
        lastError = null; // signal: already handled
        break;
      }

      let rsOfferId;
      try {
        rsOfferId = await postOffer(cardId, entry.offer_amount, turnstileToken, authInfo, sessionToken);
      } catch (e) {
        lastError = e.message;
        const note = 'Card ' + cardId + ' skipped: ' + e.message.slice(0, 200);
        // 429 = RS daily offer limit hit — push last_attempt_at 1h into the future so
        // this entry is skipped for ~65 min (query requires last_attempt_at < now-300).
        if (e.message.includes('429')) {
          await env.DB.prepare(
            'UPDATE payout_queue SET notes=?, last_attempt_at=? WHERE id=?'
          ).bind(note, now + 3600, entry.id).run();
          lastError = null; // signal: already handled, stop trying other cards too
          break;
        }
        await env.DB.prepare(
          'UPDATE payout_queue SET notes=? WHERE id=?'
        ).bind(note, entry.id).run();
        continue;
      }

      // Success
      await env.DB.prepare(
        "UPDATE payout_queue SET status='sent', rs_offer_id=?, target_card_id=?, sent_at=? WHERE id=?"
      ).bind(rsOfferId, cardId, now, entry.id).run();
      results.push({ parlayId: entry.parlay_id, result: 'sent', offerId: rsOfferId, cardId });
      entrySent = true;
      break;
    }

    if (!entrySent && lastError !== null) {
      // All candidate cards failed (listed, restricted, etc.) — stay pending, retry next run
      results.push({ parlayId: entry.parlay_id, result: 'all_skipped' });
    }
  }

  const sent       = results.filter(r => r.result === 'sent').length;
  const noCard     = results.filter(r => r.result === 'no_card').length;
  const allSkipped = results.filter(r => r.result === 'all_skipped').length;
  const failed     = results.filter(r => !['sent', 'no_card', 'all_skipped'].includes(r.result)).length;

  return ok({ processed: queue.length, sent, noCard, allSkipped, failed, results });
}
