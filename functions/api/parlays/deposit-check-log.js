// GET /api/parlays/deposit-check-log?_cron_key=...  (or logged in as admin)
// Returns the last deposit-check run result + full activation history from parlays table.
import { getSession } from '../../_lib/session.js';
import { err } from '../../_lib/response.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const cronOk = env.CRON_SECRET && url.searchParams.get('_cron_key') === env.CRON_SECRET;
  if (!cronOk) {
    const session = await getSession(request, env.DB);
    const user = session
      ? await env.DB.prepare('SELECT is_admin FROM users WHERE id=?').bind(session.user_id).first()
      : null;
    if (!user?.is_admin) return err('Unauthorized', 401);
  }

  const [lastRun, activated] = await Promise.all([
    env.DB.prepare(
      'SELECT data, fetched_at FROM odds_cache WHERE cache_key=?'
    ).bind('deposit_check_debug').first(),

    env.DB.prepare(
      'SELECT id, rs_username, stake_rax, received_rax, payout_rax, deposit_card_id, ' +
      'rs_offer_id, deposited_at, status, created_at ' +
      'FROM parlays WHERE deposited_at IS NOT NULL ORDER BY deposited_at DESC LIMIT 200'
    ).all(),
  ]);

  return new Response(JSON.stringify({
    lastRun: lastRun ? { ...JSON.parse(lastRun.data), ts: lastRun.fetched_at } : null,
    activations: activated.results || [],
  }, null, 2), { headers: { 'Content-Type': 'application/json' } });
}
