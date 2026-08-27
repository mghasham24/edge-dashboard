// functions/api/admin/casino-withdrawals.js
// GET  /api/admin/casino-withdrawals          — list withdrawals (pending first)
// POST /api/admin/casino-withdrawals          — update status (complete | failed | processing)
//   Body: { id, status, notes? }
//   failed → auto-refunds casino_balance

import { getSession } from '../../_lib/session.js';

export async function onRequest({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session)        return fail(401, 'Not authenticated');
  if (!session.is_admin) return fail(403, 'Forbidden');

  const method = request.method;

  if (method === 'GET') {
    const url    = new URL(request.url);
    const status = url.searchParams.get('status') || '';
    const limit  = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const where  = status ? "WHERE cw.status = ?" : '';
    const params = status ? [status, limit, offset] : [limit, offset];

    const rows = await env.DB.prepare(
      `SELECT cw.id, cw.user_id, cw.amount, cw.rs_username, cw.status, cw.notes, cw.created_at,
              u.email, u.casino_balance
       FROM casino_withdrawals cw
       JOIN users u ON u.id = cw.user_id
       ${where}
       ORDER BY CASE cw.status WHEN 'pending' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END,
                cw.created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...params).all();

    // Summary stats
    const stats = await env.DB.prepare(
      `SELECT
         SUM(CASE WHEN status='pending'    THEN amount ELSE 0 END) AS pending_rax,
         SUM(CASE WHEN status='processing' THEN amount ELSE 0 END) AS processing_rax,
         SUM(CASE WHEN status='complete'   THEN amount ELSE 0 END) AS paid_rax,
         COUNT(CASE WHEN status='pending'    THEN 1 END) AS pending_count,
         COUNT(CASE WHEN status='processing' THEN 1 END) AS processing_count
       FROM casino_withdrawals`
    ).first();

    // Total casino liability across all users
    const liability = await env.DB.prepare(
      'SELECT SUM(casino_balance) AS total FROM users WHERE casino_balance > 0'
    ).first();

    return json({
      ok:          true,
      withdrawals: rows.results || [],
      stats: {
        ...stats,
        total_liability: liability?.total ?? 0,
      },
    });
  }

  if (method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return fail(400, 'Invalid JSON'); }

    const { id, status, notes } = body;
    if (!id || !status)                              return fail(400, 'id and status required');
    if (!['complete','failed','processing'].includes(status))
      return fail(400, 'status must be complete, failed, or processing');

    const withdrawal = await env.DB.prepare(
      'SELECT id, user_id, amount, status FROM casino_withdrawals WHERE id = ?'
    ).bind(id).first();
    if (!withdrawal) return fail(404, 'Withdrawal not found');

    if (status === 'failed') {
      // Refund balance atomically
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE casino_withdrawals SET status='failed', notes=? WHERE id=?"
        ).bind(notes ?? null, id),
        env.DB.prepare(
          'UPDATE users SET casino_balance = casino_balance + ? WHERE id = ?'
        ).bind(withdrawal.amount, withdrawal.user_id),
      ]);
      return json({ ok: true, refunded: withdrawal.amount });
    }

    await env.DB.prepare(
      'UPDATE casino_withdrawals SET status=?, notes=? WHERE id=?'
    ).bind(status, notes ?? null, id).run();

    return json({ ok: true, status });
  }

  return fail(405, 'Method not allowed');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
