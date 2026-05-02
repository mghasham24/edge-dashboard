// functions/api/admin/rs-check-position.js
// iOS Shortcut sends one position at a time. Returns {posted:true} or {posted:false, id, text}.

export async function onRequestPost({ request, env }) {
  const secret = new URL(request.url).searchParams.get('key');
  if (!secret || secret !== env.RS_TOKEN_SECRET) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Bad JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const pos = body.position;
  if (!pos?.sharedPositionId) {
    return new Response(JSON.stringify({ posted: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  const id = pos.sharedPositionId;

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS rs_posted_positions (
      position_id TEXT PRIMARY KEY,
      posted_at   INTEGER NOT NULL
    )
  `).run();

  const row = await env.DB.prepare(
    'SELECT position_id FROM rs_posted_positions WHERE position_id = ?'
  ).bind(id).first();

  if (row) return new Response(JSON.stringify({ posted: true }), { headers: { 'Content-Type': 'application/json' } });

  const game    = pos.marketDisplay?.display || '';
  const label   = pos.headerLabel || '';
  const outcome = pos.outcomeLabel || '';
  const det     = (pos.details || []).reduce((a, d) => { a[d.label] = d.display; return a; }, {});
  const text    = `New Pick: ${game}\n${label} — ${outcome}\nAvg: ${det.Avg || '—'} | Cost: ${det.Cost || '—'} | Pays: ${det.Pays || '—'}`;

  return new Response(JSON.stringify({ posted: false, id, text }), { headers: { 'Content-Type': 'application/json' } });
}
