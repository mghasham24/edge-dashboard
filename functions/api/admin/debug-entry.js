// GET /api/admin/debug-entry?id=N
// Returns everything known about a payout queue entry in one call.
// Auth: admin session or _cron_key.

import { rsUrlEncode } from '../../_lib/hashids.js';
import { ok, err }     from '../../_lib/response.js';
import { getSession }  from '../../_lib/session.js';

async function isAuthorized(request, env) {
  const url = new URL(request.url);
  if (env.CRON_SECRET && url.searchParams.get('_cron_key') === env.CRON_SECRET) return true;
  const session = await getSession(request, env.DB);
  if (!session) return false;
  const user = await env.DB.prepare('SELECT is_admin FROM users WHERE id=?').bind(session.user_id).first();
  return !!user?.is_admin;
}

export async function onRequestGet({ request, env }) {
  if (!(await isAuthorized(request, env))) return err('Unauthorized', 401);

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return err('id required', 400);

  // Queue entry + winner's real_auth
  const entry = await env.DB.prepare(`
    SELECT q.id, q.parlay_id, q.user_id, q.rs_username, q.payout_rax, q.offer_amount,
           q.status, q.target_card_id, q.rs_offer_id, q.attempts, q.notes,
           q.created_at, q.sent_at, q.last_attempt_at, q.skipped_cards,
           ra.rs_user_id, ra.rs_username AS ra_username, ra.parlay_verified,
           p.status AS parlay_status, p.stake_rax, p.legs_count,
           p.deposited_at, p.is_free_play
    FROM payout_queue q
    LEFT JOIN real_auth ra ON ra.user_id = q.user_id
    LEFT JOIN parlays p ON p.id = q.parlay_id
    WHERE q.id = ?
  `).bind(id).first();

  if (!entry) return err('Entry not found', 404);

  // Legs
  const { results: legs } = await env.DB.prepare(
    'SELECT player_name, market_type, label, direction, threshold, american_odds, status, result_value, event_name, sport ' +
    'FROM parlay_legs WHERE parlay_id = ? ORDER BY id'
  ).bind(entry.parlay_id).all();

  // Skipped card URLs
  const skippedIds = entry.skipped_cards ? JSON.parse(entry.skipped_cards) : [];
  const skippedUrls = skippedIds.map(cid => ({
    card_id: cid,
    url: 'https://www.realapp.com/' + rsUrlEncode(20, 0, 0, cid),
  }));

  // All other pending entries for the same user (to spot duplicates / contention)
  const { results: siblings } = await env.DB.prepare(
    "SELECT id, status, payout_rax, attempts FROM payout_queue WHERE user_id=? AND id!=? ORDER BY id DESC LIMIT 10"
  ).bind(entry.user_id, id).all();

  return ok({
    entry: {
      id:               entry.id,
      rs_username:      entry.rs_username,
      payout_rax:       entry.payout_rax,
      offer_amount:     entry.offer_amount,
      status:           entry.status,
      attempts:         entry.attempts,
      notes:            entry.notes,
      created_at:       entry.created_at,
      sent_at:          entry.sent_at,
      last_attempt_at:  entry.last_attempt_at,
    },
    parlay: {
      id:           entry.parlay_id,
      status:       entry.parlay_status,
      stake_rax:    entry.stake_rax,
      payout_rax:   entry.payout_rax,
      legs_count:   entry.legs_count,
      deposited_at: entry.deposited_at,
      is_free_play: entry.is_free_play,
    },
    legs: legs || [],
    winner: {
      user_id:         entry.user_id,
      rs_username:     entry.ra_username,
      rs_user_id:      entry.rs_user_id,
      parlay_verified: entry.parlay_verified,
    },
    card: entry.target_card_id ? {
      card_id: entry.target_card_id,
      url:     'https://www.realapp.com/' + rsUrlEncode(20, 0, 0, entry.target_card_id),
    } : null,
    skipped_cards: skippedUrls,
    other_entries_for_user: siblings || [],
  });
}
