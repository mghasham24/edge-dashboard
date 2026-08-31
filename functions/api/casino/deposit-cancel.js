// functions/api/casino/deposit-cancel.js
// POST /api/casino/deposit-cancel
// Before cancelling, checks RS card auction history to detect if the user already
// sent Rax for the pending deposit. If they did, auto-credits instead of cancelling.

import { getSession }  from '../../_lib/session.js';
import { ok, err }     from '../../_lib/response.js';
import { hashidsEncode } from '../../_lib/hashids.js';

const RS_DEVICE_UUID = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';
const EDGEBOT_USER   = 'V3yGgkkJ';

function buildHeaders(authInfo, sessionToken) {
  return {
    'Accept':             'application/json',
    'Origin':             'https://www.realapp.com',
    'Referer':            'https://www.realapp.com/',
    'real-auth-info':     authInfo,
    'real-session-token': sessionToken || '',
    'real-device-uuid':   RS_DEVICE_UUID,
    'real-device-type':   'desktop_web',
    'real-version':       '36',
    'real-request-token': hashidsEncode(Date.now()),
  };
}

// Returns the amount the rsUsername paid edgebot for this card if within 10% of raxRequested, or 0.
// Amount validation guards against stale recycled-card trades for the same user on the same card.
async function checkAuctionHistory(cardId, rsUsername, raxRequested, authInfo, sessionToken) {
  try {
    const res = await fetch(
      `https://web.realapp.com/cardauctionhistory/${cardId}`,
      {
        headers: buildHeaders(authInfo, sessionToken),
        signal: AbortSignal.timeout(6000),
      }
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
        if (amount > 0 && amount >= raxRequested * 0.9 && amount <= raxRequested * 1.1) return amount;
      }
    }
  } catch (_) {}
  return 0;
}

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);

  const userId = session.user_id;

  // Load the pending deposit so we can check its card
  const deposit = await env.DB.prepare(
    "SELECT * FROM casino_deposits WHERE user_id=? AND status='pending' LIMIT 1"
  ).bind(userId).first();

  if (!deposit) return ok({ cancelled: false });

  // Try to detect if the user already paid via auction history before cancelling
  const authInfo   = env.EDGEBOT_AUTH_INFO;
  const sessionTok = env.EDGEBOT_SESSION_TOKEN || '';

  if (authInfo && deposit.card_id) {
    const authRow = await env.DB.prepare(
      'SELECT rs_username FROM real_auth WHERE user_id=? AND parlay_verified=1 LIMIT 1'
    ).bind(userId).first();

    if (authRow?.rs_username) {
      const paidAmount = await checkAuctionHistory(deposit.card_id, authRow.rs_username, deposit.rax_requested, authInfo, sessionTok);
      if (paidAmount > 0) {
        // User already sent Rax — credit them instead of cancelling
        const raxCredited = Math.floor(paidAmount * 0.9);
        const updated = await env.DB.prepare(
          "UPDATE casino_deposits SET status='confirmed', rax_credited=? WHERE id=? AND status='pending'"
        ).bind(raxCredited, deposit.id).run();

        if (updated.meta.changes > 0) {
          await env.DB.batch([
            env.DB.prepare('UPDATE users SET casino_balance = casino_balance + ? WHERE id = ?')
              .bind(raxCredited, userId),
            env.DB.prepare('DELETE FROM deposit_cards WHERE card_id=?')
              .bind(deposit.card_id),
          ]);
          return ok({ cancelled: false, credited: raxCredited });
        }
      }
    }
  }

  // No payment detected — cancel and immediately return card to pool
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE casino_deposits SET status='cancelled' WHERE id=? AND status='pending'"
    ).bind(deposit.id),
    env.DB.prepare(
      'UPDATE deposit_cards SET claimed_for_casino_at=NULL WHERE card_id=?'
    ).bind(deposit.card_id),
  ]);

  return ok({ cancelled: true });
}
