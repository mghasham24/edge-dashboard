// functions/api/admin/rs-positions.js
// Called by iOS Shortcut — receives RS positions array, returns new ones with formatted text.

export async function onRequestPost({ request, env }) {
  const secret = new URL(request.url).searchParams.get('key');
  if (!secret || secret !== env.RS_TOKEN_SECRET) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Bad JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const positions = body.positions || [];
  if (!positions.length) return new Response(JSON.stringify({ toPost: [] }), { headers: { 'Content-Type': 'application/json' } });

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS rs_posted_positions (
      position_id TEXT PRIMARY KEY,
      posted_at   INTEGER NOT NULL
    )
  `).run();

  const ids = positions.map(p => p.sharedPositionId).filter(Boolean);
  if (!ids.length) return new Response(JSON.stringify({ toPost: [] }), { headers: { 'Content-Type': 'application/json' } });

  const placeholders = ids.map(() => '?').join(',');
  const posted = await env.DB.prepare(
    `SELECT position_id FROM rs_posted_positions WHERE position_id IN (${placeholders})`
  ).bind(...ids).all();
  const postedSet = new Set((posted.results || []).map(r => r.position_id));

  const toPost = positions
    .filter(p => p.sharedPositionId && !postedSet.has(p.sharedPositionId))
    .map(pos => {
      const game    = pos.marketDisplay?.display || '';
      const label   = pos.headerLabel || '';
      const outcome = pos.outcomeLabel || '';
      const det     = (pos.details || []).reduce((a, d) => { a[d.label] = d.display; return a; }, {});
      const text    = `New Pick: ${game}\n${label} — ${outcome}\nAvg: ${det.Avg || '—'} | Cost: ${det.Cost || '—'} | Pays: ${det.Pays || '—'}`;
      return { id: pos.sharedPositionId, text };
    });

  return new Response(JSON.stringify({ toPost }), { headers: { 'Content-Type': 'application/json' } });
}
