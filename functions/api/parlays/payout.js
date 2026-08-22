// functions/api/parlays/payout.js
// Admin utility endpoints for payout queue management.
//
// Offer submission is handled exclusively by the Mac payout-bot (payout-bot/index.js)
// via Safari AppleScript automation — never via direct RS API calls from this CF Worker.
//
// ?unpause=1          — clear any active payout ban pause
// ?pause_hours=N      — manually pause payouts for N hours (default 24)
// ?debug_cards=RSUID  — raw card lookup for a given RS user ID (first 4 categories)

import { hashidsEncode } from '../../_lib/hashids.js';
import { ok, err }       from '../../_lib/response.js';

const RS_DEVICE_UUID = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';

const CARD_TARGETS_DEBUG = [
  ['mlb', '2025', 'play'],
  ['mlb', '2026', 'play'],
  ['nba', '2026', 'play'],
  ['nhl', '2026', 'play'],
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

export const onRequestGet = onRequestPost;
export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  if (!env.CRON_SECRET || url.searchParams.get('_cron_key') !== env.CRON_SECRET)
    return err('Unauthorized', 401);

  const now = Math.floor(Date.now() / 1000);

  // ?debug_cards=RSUID — raw card lookup for a given RS user ID
  const debugCardsUser = url.searchParams.get('debug_cards');
  if (debugCardsUser) {
    const authInfo     = env.EDGEBOT_AUTH_INFO;
    const sessionToken = env.EDGEBOT_SESSION_TOKEN;
    if (!authInfo || !sessionToken) return err('EDGEBOT credentials not configured', 500);
    const results = [];
    for (const [sport, season, entity] of CARD_TARGETS_DEBUG) {
      const cat = `${sport}/${season}`;
      try {
        const res = await fetch(
          `https://web.realapp.com/collectingcards/${sport}/season/${season}/entity/${entity}/user/${debugCardsUser}/cards?filterCustomType=unowned&includeRecommendations=false&rarity=all&view=rating`,
          { headers: buildHeaders(authInfo, sessionToken), signal: AbortSignal.timeout(8000) }
        );
        const text = await res.text();
        let data; try { data = JSON.parse(text); } catch { data = text; }
        const cards = Array.isArray(data) ? data : (data.cards || data.items || data.results || []);
        results.push({ cat, status: res.status, total: cards.length, topKeys: Object.keys(cards[0] || {}).slice(0, 12), top5: cards.slice(0, 5) });
      } catch(e) {
        results.push({ cat, error: e.message });
      }
    }
    return ok({ rsUserId: debugCardsUser, results });
  }

  // ?unpause=1 — clear any active payout ban pause
  if (url.searchParams.get('unpause') === '1') {
    await env.DB.prepare(
      "DELETE FROM odds_cache WHERE cache_key='payout:paused_until'"
    ).run().catch(() => {});
    return ok({ unpaused: true });
  }

  // ?pause_hours=N — manually pause payouts for N hours (default 24)
  const pauseHoursParam = url.searchParams.get('pause_hours');
  if (pauseHoursParam !== null) {
    const hours = Math.max(1, Math.min(72, parseInt(pauseHoursParam, 10) || 24));
    const resumesAt = now + hours * 3600;
    await env.DB.prepare(
      "INSERT OR REPLACE INTO odds_cache (cache_key, data, fetched_at) VALUES ('payout:paused_until', ?, ?)"
    ).bind(String(resumesAt), now).run();
    return ok({ paused: true, hours, resumesAt });
  }

  return ok({ ok: true, info: 'Offer submission handled by Mac payout-bot only' });
}
