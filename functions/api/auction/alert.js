// functions/api/auction/alert.js
// Relay endpoint for Tampermonkey auction-alert script.
// Accepts POST { text, key } and forwards to Telegram using server-side token.
// Requires AUCTION_ALERT_KEY + AUCTION_TG_TOKEN in Cloudflare env vars.
// AUCTION_TG_CHAT defaults to the known chat ID if not set.

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return fail(400, 'bad json'); }

  const key = env.AUCTION_ALERT_KEY;
  if (key && body.key !== key) return fail(403, 'forbidden');

  const token = env.AUCTION_TG_TOKEN;
  if (!token) return fail(503, 'bot not configured');

  const chat  = env.AUCTION_TG_CHAT || '5439959074';
  const text  = String(body.text || '').slice(0, 4096);
  if (!text) return fail(400, 'no text');

  const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML' }),
  });

  return new Response(JSON.stringify({ ok: tgRes.ok }), {
    status: tgRes.ok ? 200 : 502,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
