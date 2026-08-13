// GET /api/admin/performance?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns daily parlay performance aggregates for admin dashboard.
import { getSession } from '../../_lib/session.js';
import { ok, err }    from '../../_lib/response.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return err('Authentication required', 401);

  const user = await env.DB.prepare('SELECT is_admin FROM users WHERE id=?').bind(session.user_id).first();
  if (!user?.is_admin) return err('Forbidden', 403);

  const url  = new URL(request.url);
  const from = url.searchParams.get('from');
  const to   = url.searchParams.get('to');

  if (!from || !to) return err('from and to required', 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return err('Invalid date format', 400);

  const fromTs = Math.floor(new Date(from + 'T00:00:00Z').getTime() / 1000);
  const toTs   = Math.floor(new Date(to   + 'T23:59:59Z').getTime() / 1000);

  const { results: rows } = await env.DB.prepare(`
    SELECT
      DATE(created_at, 'unixepoch') AS day,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'won'             THEN 1 ELSE 0 END) AS won,
      SUM(CASE WHEN status = 'lost'            THEN 1 ELSE 0 END) AS lost,
      SUM(CASE WHEN status = 'active'          THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status = 'pending_deposit' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status IN ('void','voided','expired') THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN status IN ('active','won','lost') THEN stake_rax   ELSE 0 END) AS staked,
      SUM(CASE WHEN status = 'won'             THEN payout_rax ELSE 0 END) AS paid_out,
      ROUND(AVG(CASE WHEN status IN ('won','lost') AND stake_rax > 0
                     THEN CAST(payout_rax AS REAL) / stake_rax END), 2) AS avg_mult,
      COUNT(DISTINCT CASE WHEN status IN ('active','won','lost') THEN user_id END) AS unique_bettors
    FROM parlays
    WHERE created_at >= ? AND created_at <= ?
    GROUP BY day
    ORDER BY day DESC
  `).bind(fromTs, toTs).all();

  const summary = rows.reduce((acc, r) => {
    acc.total    += r.total    || 0;
    acc.won      += r.won      || 0;
    acc.lost     += r.lost     || 0;
    acc.active   += r.active   || 0;
    acc.pending  += r.pending  || 0;
    acc.cancelled+= r.cancelled|| 0;
    acc.staked   += r.staked   || 0;
    acc.paid_out += r.paid_out || 0;
    return acc;
  }, { total:0, won:0, lost:0, active:0, pending:0, cancelled:0, staked:0, paid_out:0 });

  summary.net = summary.staked - summary.paid_out;
  summary.win_rate = summary.won + summary.lost > 0
    ? Math.round(summary.won / (summary.won + summary.lost) * 100)
    : null;

  return ok({ rows, summary });
}
