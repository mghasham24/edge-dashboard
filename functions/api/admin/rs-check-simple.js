// functions/api/admin/rs-check-simple.js
// GET with query params: id, game, label, outcome
// Returns {posted:true} or {posted:false, id, text}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const secret = url.searchParams.get('key');
  if (!secret || secret !== env.RS_TOKEN_SECRET) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }

  const id      = url.searchParams.get('id') || '';
  const game    = url.searchParams.get('game') || '';
  const label   = url.searchParams.get('label') || '';
  const outcome = url.searchParams.get('outcome') || '';

  if (!id) return new Response(JSON.stringify({ posted: true }), { headers: { 'Content-Type': 'application/json' } });

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

  const text = `New Pick: ${game}\n${label} — ${outcome}`;
  return new Response(JSON.stringify({ posted: false, id, text }), { headers: { 'Content-Type': 'application/json' } });
}
