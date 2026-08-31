// functions/api/admin/casino-audit.js
// GET /api/admin/casino-audit?user_id=N
// Admin-only: checks auction history for all deposits of a user

import { getSession } from '../../_lib/session.js';
import { ok, err }    from '../../_lib/response.js';
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

async function getAuctionHistory(cardId, authInfo, sessionToken) {
  try {
    const res = await fetch(
      `https://web.realapp.com/cardauctionhistory/${cardId}`,
      { headers: buildHeaders(authInfo, sessionToken), signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    const history = Array.isArray(data?.auctionHistory) ? data.auctionHistory : [];
    return { history: history.map(e => ({
      buyer:  e.user?.userName,
      seller: e.from?.user?.id,
      amount: String(e.amountDisplay || '').replace(/,/g, ''),
    })) };
  } catch (e) {
    return { error: e.message };
  }
}

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Unauthorized', 401);

  const adminUser = await env.DB.prepare('SELECT is_admin FROM users WHERE id=?')
    .bind(session.user_id).first();
  if (!adminUser?.is_admin) return err('Forbidden', 403);

  const url    = new URL(request.url);
  const userId = url.searchParams.get('user_id');
  if (!userId) return err('user_id required', 400);

  const authInfo   = env.EDGEBOT_AUTH_INFO;
  const sessionTok = env.EDGEBOT_SESSION_TOKEN || '';
  if (!authInfo) return err('EDGEBOT_AUTH_INFO not set', 500);

  const [deposits, authRow] = await Promise.all([
    env.DB.prepare(
      'SELECT id, rax_requested, rax_credited, card_id, status, created_at FROM casino_deposits WHERE user_id=? ORDER BY created_at ASC'
    ).bind(userId).all(),
    env.DB.prepare(
      'SELECT rs_username FROM real_auth WHERE user_id=? AND parlay_verified=1 LIMIT 1'
    ).bind(userId).first(),
  ]);

  const rsUsername = authRow?.rs_username || null;
  const rows = deposits.results || [];

  const results = await Promise.all(rows.map(async dep => {
    if (!dep.card_id) return { ...dep, auction: null };
    const auction = await getAuctionHistory(dep.card_id, authInfo, sessionTok);

    let matchedEntry = null;
    if (rsUsername && auction.history) {
      matchedEntry = auction.history.find(e => {
        const buyer  = (e.buyer  || '').toLowerCase();
        const seller = e.seller;
        const amount = parseInt(e.amount, 10);
        return buyer === rsUsername.toLowerCase()
          && seller === EDGEBOT_USER
          && amount >= dep.rax_requested * 0.9
          && amount <= dep.rax_requested * 1.1;
      }) || null;
    }

    return {
      deposit_id:    dep.id,
      card_id:       dep.card_id,
      rax_requested: dep.rax_requested,
      rax_credited:  dep.rax_credited,
      status:        dep.status,
      created_at:    dep.created_at,
      rs_match:      matchedEntry ? { buyer: matchedEntry.buyer, seller: matchedEntry.seller, amount: matchedEntry.amount } : null,
      all_trades:    auction.history || [],
      api_error:     auction.error   || null,
    };
  }));

  return ok({ user_id: userId, rs_username: rsUsername, deposits: results });
}
