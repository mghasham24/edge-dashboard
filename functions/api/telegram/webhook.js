// functions/api/telegram/webhook.js
// Receives Telegram Update objects from the Bot API.
// When a user sends /start {token}, we link their chat_id to their RaxEdge account.
//
// Setup (one-time, run after deploying):
//   curl "https://api.telegram.org/bot{TOKEN}/setWebhook" \
//     -d "url=https://yourdomain.com/api/telegram/webhook" \
//     -d "secret_token={TELEGRAM_WEBHOOK_SECRET}"

async function sendMessage(chatId, text, botToken) {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return new Response('ok', { status: 200 });
  // Verify request is from Telegram using the shared secret
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  if (!env.TELEGRAM_BOT_TOKEN) return new Response('ok', { status: 200 });

  let update;
  try { update = await request.json(); }
  catch { return new Response('ok', { status: 200 }); }

  // ── Handle inline button taps ──────────────────────────
  if (update.callback_query) {
    const cq     = update.callback_query;
    const cqId   = cq.id;
    const data   = cq.data || '';
    const chatId = String(cq.message?.chat?.id);
    const msgId  = cq.message?.message_id;

    if (data.startsWith('t:')) {
      const rowId = parseInt(data.slice(2));
      let toastText = '✅ Bet recorded!';

      try {
        const row = await env.DB.prepare(
          'SELECT id, user_id, chat_id, game, market, taken FROM alert_messages WHERE id=?'
        ).bind(rowId).first();

        if (row && String(row.chat_id) === chatId) {
          const newTaken = row.taken ? 0 : 1;
          await env.DB.prepare(
            'UPDATE alert_messages SET taken=? WHERE id=?'
          ).bind(newTaken, rowId).run();

          toastText = newTaken ? '✅ Bet recorded!' : '↩️ Bet unrecorded';
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              message_id: msgId,
              reply_markup: { inline_keyboard: [[{ text: newTaken ? '✅ Bet Recorded' : '☑️ Mark Bet Taken', callback_data: 't:' + rowId }]] }
            })
          });
        }
      } catch(e) {}

      // Must answer callback query within 10s
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cqId, text: toastText, show_alert: false })
      });
    }

    return new Response('ok', { status: 200 });
  }

  const msg = update.message;
  if (!msg || !msg.text) return new Response('ok', { status: 200 });

  const chatId = String(msg.chat.id);
  const text   = msg.text.trim();

  // Handle /start {token}
  const startMatch = text.match(/^\/start\s+([a-f0-9]{32})$/i);
  if (!startMatch) {
    // Any other message — send a generic reply
    await sendMessage(chatId, '👋 Send your verification link from the RaxEdge alerts settings to connect your account.', env.TELEGRAM_BOT_TOKEN);
    return new Response('ok', { status: 200 });
  }

  const token = startMatch[1].toLowerCase();
  const now   = Math.floor(Date.now() / 1000);

  const tokenRow = await env.DB.prepare(
    'SELECT user_id, expires_at FROM telegram_verify_tokens WHERE token=?'
  ).bind(token).first();

  if (!tokenRow) {
    await sendMessage(chatId, '❌ Invalid verification link. Please generate a new one from RaxEdge settings.', env.TELEGRAM_BOT_TOKEN);
    return new Response('ok', { status: 200 });
  }

  if (tokenRow.expires_at < now) {
    await sendMessage(chatId, '⏰ This link has expired. Please generate a new one from RaxEdge settings.', env.TELEGRAM_BOT_TOKEN);
    await env.DB.prepare('DELETE FROM telegram_verify_tokens WHERE token=?').bind(token).run();
    return new Response('ok', { status: 200 });
  }

  // Link the chat_id to the user account
  await env.DB.prepare(`
    INSERT INTO notification_settings (user_id, telegram_chat_id, telegram_verified, enabled, min_ev, sports, updated_at)
    VALUES (?, ?, 1, 1, 5.0, 'ALL', ?)
    ON CONFLICT(user_id) DO UPDATE SET
      telegram_chat_id  = excluded.telegram_chat_id,
      telegram_verified = 1,
      enabled           = 1,
      updated_at        = excluded.updated_at
  `).bind(tokenRow.user_id, chatId, now).run();

  // Clean up used token
  await env.DB.prepare('DELETE FROM telegram_verify_tokens WHERE token=?').bind(token).run();

  await sendMessage(chatId,
    '✅ <b>RaxEdge alerts connected!</b>\n\nYou\'ll receive a Telegram message whenever a bet hits your EV threshold.\n\nManage your settings anytime from the RaxEdge alerts panel.',
    env.TELEGRAM_BOT_TOKEN
  );

  return new Response('ok', { status: 200 });
}
