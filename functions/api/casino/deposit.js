// functions/api/casino/deposit.js
// POST /api/casino/deposit
// Initiates a casino Rax deposit.
// Assigns an edgebot card from the shared deposit_cards pool, returns the card URL.
// User goes to RealSports and offers rax_requested Rax for that card.
// deposit-check.js confirms it and credits casino_balance * 0.9.

import { getSession }  from '../../_lib/session.js';
import { err }         from '../../_lib/response.js';
import { rsUrlEncode } from '../../_lib/hashids.js';

const MIN_DEPOSIT    = 1000;
const RS_DEVICE_UUID = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';
const EDGEBOT_USER   = 'V3yGgkkJ';

// Live-only check using edgebot's own auth token.
// Returns true (edgebot owns), false (someone else owns — remove from pool), null (fetch failed — skip).
// No snapshot fallback: we must confirm live ownership before showing a card to a user.
async function verifyEdgebotOwnsLive(cardId, authInfo) {
  if (!authInfo) return null;
  try {
    const res = await fetch(`https://web.realapp.com/collectingcards/${cardId}`, {
      headers: {
        'Accept':           'application/json',
        'real-auth-info':   authInfo,
        'real-device-uuid': RS_DEVICE_UUID,
        'real-device-type': 'desktop_web',
        'real-version':     '36',
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const uid  = data.card?.userId ?? data.userId ?? null;
    return uid === null ? null : uid === EDGEBOT_USER;
  } catch { return null; }
}

async function pickCard(env, now, db) {
  // Exclude cards already claimed by a pending casino deposit
  const pendingCards = await db.prepare(
    "SELECT card_id FROM casino_deposits WHERE status='pending' AND card_id IS NOT NULL"
  ).all();
  const claimedIds = (pendingCards.results || []).map(r => r.card_id);

  const authInfo = env.EDGEBOT_AUTH_INFO;
  const excluded = [...claimedIds];

  for (let i = 0; i < 5; i++) {
    const notIn = excluded.length
      ? ' AND card_id NOT IN (' + excluded.map(() => '?').join(',') + ')'
      : '';
    const row = await db.prepare(
      'SELECT card_id FROM deposit_cards WHERE assigned_to_parlay_id IS NULL AND freed_at IS NULL' +
      notIn + ' ORDER BY verified_at DESC LIMIT 1'
    ).bind(...excluded).first();
    if (!row) break;

    const owned = await verifyEdgebotOwnsLive(row.card_id, authInfo);
    if (owned === false) {
      // Edgebot no longer owns this card — remove from pool
      await db.prepare('DELETE FROM deposit_cards WHERE card_id=?').bind(row.card_id).run();
      excluded.push(row.card_id);
      continue;
    }
    if (owned === null) {
      // Live check failed (network/token) — skip this card for now, don't remove
      excluded.push(row.card_id);
      continue;
    }
    return row.card_id;
  }
  return null;
}

export async function onRequestPost({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);
  const userId = session.user_id;

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON', 400); }

  const amount = body.amount;
  if (!Number.isInteger(amount) || amount < MIN_DEPOSIT)
    return err(`Minimum deposit is ${MIN_DEPOSIT} Rax.`, 400);

  // Require RS verification before depositing (admins bypass this gate)
  const userRow = await env.DB.prepare('SELECT is_admin FROM users WHERE id=?').bind(userId).first();
  if (!userRow?.is_admin) {
    const authCheck = await env.DB.prepare(
      'SELECT rs_username FROM real_auth WHERE user_id = ? AND parlay_verified = 1'
    ).bind(userId).first();
    if (!authCheck) return err('Link your RealSports account before depositing. Verify in Parlays or Casino.', 400);
  }

  const now = Math.floor(Date.now() / 1000);

  // Auto-expire stale pending deposits (> 30 min old)
  await env.DB.prepare(
    "UPDATE casino_deposits SET status='expired' WHERE user_id=? AND status='pending' AND created_at < ?"
  ).bind(userId, now - 30 * 60).run();

  // Resume an existing live pending deposit (within 30 min) instead of blocking
  const existing = await env.DB.prepare(
    "SELECT * FROM casino_deposits WHERE user_id=? AND status='pending' LIMIT 1"
  ).bind(userId).first();
  if (existing && existing.card_id) {
    const cardUrl = 'https://www.realapp.com/' + rsUrlEncode(20, 0, 0, existing.card_id);
    return new Response(JSON.stringify({
      ok:            true,
      card_url:      cardUrl,
      card_id:       existing.card_id,
      rax_requested: existing.rax_requested,
      rax_credited:  Math.floor(existing.rax_requested * 0.9),
      expires_at:    existing.created_at + 30 * 60,
      resumed:       true,
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  const cardId = await pickCard(env, now, env.DB);
  if (!cardId) return err('No deposit cards available right now. Please try again in a few minutes.', 503);

  await env.DB.prepare(
    'INSERT INTO casino_deposits (user_id, rax_requested, card_id, status, created_at) VALUES (?,?,?,?,?)'
  ).bind(userId, amount, cardId, 'pending', now).run();

  const cardUrl = 'https://www.realapp.com/' + rsUrlEncode(20, 0, 0, cardId);

  return new Response(JSON.stringify({
    ok:            true,
    card_url:      cardUrl,
    card_id:       cardId,
    rax_requested: amount,
    rax_credited:  Math.floor(amount * 0.9),
    expires_at:    now + 30 * 60,
  }), { headers: { 'Content-Type': 'application/json' } });
}
