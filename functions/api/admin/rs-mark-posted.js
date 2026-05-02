// functions/api/admin/rs-mark-posted.js
// Called by iOS Shortcut after successfully posting a position to the RS group.

export async function onRequestPost({ request, env }) {
  const secret = new URL(request.url).searchParams.get('key');
  if (!secret || secret !== env.RS_TOKEN_SECRET) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Bad JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const { id } = body;
  if (!id) return new Response(JSON.stringify({ error: 'Missing id' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    'INSERT OR IGNORE INTO rs_posted_positions (position_id, posted_at) VALUES (?, ?)'
  ).bind(id, now).run();

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}
