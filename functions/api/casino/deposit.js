// functions/api/casino/deposit.js
// POST /api/casino/deposit
// Initiates a casino Rax deposit.
// Assigns an edgebot card from the shared deposit_cards pool, returns the card URL.
// User goes to RealSports and offers rax_requested Rax for that card.
// deposit-check.js confirms it and credits casino_balance * 0.9.

import { getSession }  from '../../_lib/session.js';
import { err }         from '../../_lib/response.js';
import { rsUrlEncode } from '../../_lib/hashids.js';

const MIN_DEPOSIT     = 1000;
const MIN_DEPOSIT_TTL = 10 * 60; // matches deposit-check DEPOSIT_TTL
const VERIFY_MAX_AGE  = 15 * 60;
const INVENTORY_MAX_AGE = 10 * 60;
const RS_DEVICE_UUID = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';
const EDGEBOT_USER   = 'V3yGgkkJ';

// Use edgebot's own credentials for card ownership verification.
// The shared user token (meta:rs_auth_token) goes stale; edgebot creds are rotated regularly.
async function verifyLive(cardId, authInfo, sessionToken) {
  if (!authInfo) return null;
  try {
    const res = await fetch(`https://web.realapp.com/collectingcards/${cardId}`, {
      headers: {
        'Accept':             'application/json',
        'real-auth-info':     authInfo,
        'real-session-token': sessionToken || '',
        'real-device-uuid':   RS_DEVICE_UUID,
        'real-device-type':   'desktop_web',
        'real-version':       '36',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const uid  = data.card?.userId ?? data.userId ?? null;
    if (uid === null) return null;
    return uid === EDGEBOT_USER;
  } catch { return null; }
}

// Positive-only check: returns true if card is in snapshot, null otherwise.
// Returns null (not false) when card is absent — snapshot may be incomplete if RS
// rate-limited one sport during reconcile. Deletion is handled by verified_at staleness.
async function verifySnapshot(cardId, env, now) {
  try {
    const row = await env.DB.prepare(
      "SELECT data, fetched_at FROM odds_cache WHERE cache_key='card_inventory'"
    ).first();
    if (!row || (now - row.fetched_at) > INVENTORY_MAX_AGE) return null;
    const ids = JSON.parse(row.data);
    if (!Array.isArray(ids)) return null;
    return ids.includes(Number(cardId)) ? true : null;
  } catch { return null; }
}

async function verifyEdgebotOwns(cardId, env, now) {
  const live = await verifyLive(cardId, env.EDGEBOT_AUTH_INFO, env.EDGEBOT_SESSION_TOKEN || '');
  // If live check succeeds (true/false), trust it over snapshot.
  if (live !== null) return live;
  // Live returned null — RS unreachable or session expired.
  // Fall back to snapshot only if it is very fresh (< 2 min) to avoid serving stale cards.
  const row = await env.DB.prepare(
    "SELECT fetched_at FROM odds_cache WHERE cache_key='card_inventory'"
  ).first();
  const snapshotAge = row ? (now - row.fetched_at) : 9999;
  if (snapshotAge > INVENTORY_MAX_AGE) return null; // snapshot too stale — skip rather than risk a wrong card
  return verifySnapshot(cardId, env, now);
}

// Claim first, verify after — eliminates the multi-second race window that allowed
// two concurrent requests to both SELECT the same card before either claimed it.
async function pickCard(env, now, db) {
  const excluded = [];

  for (let i = 0; i < 5; i++) {
    const notIn = excluded.length
      ? ' AND card_id NOT IN (' + excluded.map(() => '?').join(',') + ')'
      : '';

    const row = await db.prepare(
      'SELECT card_id FROM deposit_cards' +
      ' WHERE assigned_to_parlay_id IS NULL AND freed_at IS NULL AND verified_at > ?' +
      " AND sport='nba' AND season='2026'" +
      ' AND (claimed_for_casino_at IS NULL OR claimed_for_casino_at < ?)' +
      " AND card_id NOT IN (SELECT card_id FROM casino_deposits WHERE status='confirmed' AND card_id IS NOT NULL AND created_at > " + (now - 30 * 24 * 3600) + ")" +
      notIn + ' ORDER BY verified_at DESC LIMIT 1'
    ).bind(now - VERIFY_MAX_AGE, now - MIN_DEPOSIT_TTL, ...excluded).first();
    if (!row) break;

    // Claim immediately — no async work before this UPDATE.
    // If another concurrent request already claimed it, changes === 0 → skip.
    const claim = await db.prepare(
      'UPDATE deposit_cards SET claimed_for_casino_at=?' +
      ' WHERE card_id=? AND (claimed_for_casino_at IS NULL OR claimed_for_casino_at < ?)'
    ).bind(now, row.card_id, now - MIN_DEPOSIT_TTL).run();

    if (claim.meta.changes === 0) {
      excluded.push(row.card_id);
      continue;
    }

    // Verify ownership after claiming (async RS call happens while we hold the claim).
    const owned = await verifyEdgebotOwns(row.card_id, env, now);
    if (owned === false) {
      await db.prepare('DELETE FROM deposit_cards WHERE card_id=?').bind(row.card_id).run();
      excluded.push(row.card_id);
      continue;
    }
    if (owned === null) {
      // Can't verify — release claim so it stays available for retry.
      await db.prepare('UPDATE deposit_cards SET claimed_for_casino_at=NULL WHERE card_id=?').bind(row.card_id).run();
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

  // Release claimed_for_casino_at on cards whose deposit TTL has passed —
  // makes them available again without waiting for reconcile.
  await env.DB.prepare(
    'UPDATE deposit_cards SET claimed_for_casino_at=NULL WHERE claimed_for_casino_at < ?'
  ).bind(now - MIN_DEPOSIT_TTL).run();

  // Auto-expire stale pending deposits (> 3 min old)
  await env.DB.prepare(
    "UPDATE casino_deposits SET status='expired' WHERE user_id=? AND status='pending' AND created_at < ?"
  ).bind(userId, now - MIN_DEPOSIT_TTL).run();

  // Resume an existing live pending deposit only if the amount matches.
  // If the user changed the amount, expire the old one and create a fresh deposit.
  const existing = await env.DB.prepare(
    "SELECT * FROM casino_deposits WHERE user_id=? AND status='pending' LIMIT 1"
  ).bind(userId).first();
  if (existing && existing.card_id) {
    if (existing.rax_requested === amount) {
      const cardUrl = 'https://www.realapp.com/' + rsUrlEncode(20, 0, 0, existing.card_id);
      return new Response(JSON.stringify({
        ok:            true,
        card_url:      cardUrl,
        card_id:       existing.card_id,
        rax_requested: existing.rax_requested,
        rax_credited:  Math.floor(existing.rax_requested * 0.9),
        expires_at:    existing.created_at + 10 * 60,
        resumed:       true,
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    // Amount changed — expire the old deposit so a fresh one can be created below.
    await env.DB.prepare(
      "UPDATE casino_deposits SET status='expired' WHERE id=? AND status='pending'"
    ).bind(existing.id).run();
  }

  const cardId = await pickCard(env, now, env.DB);
  if (!cardId) return err('No deposit cards available right now. DM @moe_ on Real to deposit.', 503);

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
    expires_at:    now + 10 * 60,
  }), { headers: { 'Content-Type': 'application/json' } });
}
