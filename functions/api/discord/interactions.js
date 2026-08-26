// functions/api/discord/interactions.js
// Discord interactions endpoint — handles slash commands and button clicks.
// Set this as the "Interactions Endpoint URL" in the Discord Developer Portal:
//   https://discord.com/developers/applications → Your App → General Information → Interactions Endpoint URL
//   URL: https://raxedge.com/api/discord/interactions
//
// Register /connect command (one-time setup, run after deploying):
//   curl -X POST "https://discord.com/api/v10/applications/{DISCORD_APP_ID}/commands" \
//     -H "Authorization: Bot {DISCORD_BOT_TOKEN}" \
//     -H "Content-Type: application/json" \
//     -d '{"name":"connect","description":"Connect your RaxEdge account to receive bet alerts","options":[{"name":"code","description":"Verification code from RaxEdge settings","type":3,"required":true}]}'

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

async function verifyDiscordRequest(request, publicKey) {
  const sig = request.headers.get('X-Signature-Ed25519');
  const ts  = request.headers.get('X-Signature-Timestamp');
  if (!sig || !ts) return null;
  const body = await request.text();
  try {
    const key   = await crypto.subtle.importKey('raw', hexToBytes(publicKey), { name: 'Ed25519' }, false, ['verify']);
    const valid = await crypto.subtle.verify('Ed25519', key, hexToBytes(sig), new TextEncoder().encode(ts + body));
    return valid ? body : null;
  } catch(e) { return null; }
}

export async function onRequest({ request, env }) {
  if (!env.DISCORD_PUBLIC_KEY) return new Response('Not configured', { status: 500 });
  if (request.method !== 'POST') return new Response('ok');

  const bodyText = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
  if (!bodyText) return new Response('Unauthorized', { status: 401 });

  let body;
  try { body = JSON.parse(bodyText); } catch { return new Response('Bad Request', { status: 400 }); }

  // Discord PING — must respond with PONG for endpoint verification
  if (body.type === 1) {
    return new Response(JSON.stringify({ type: 1 }), { headers: { 'Content-Type': 'application/json' } });
  }

  // APPLICATION_COMMAND — /connect <code>
  if (body.type === 2) {
    const commandName = body.data?.name;
    if (commandName !== 'connect') {
      return new Response(JSON.stringify({ type: 4, data: { content: 'Unknown command.', flags: 64 } }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const code       = (body.data?.options?.[0]?.value || '').trim().toUpperCase();
    const discordId  = body.member?.user?.id || body.user?.id;
    const channelId  = body.channel_id;
    const now        = Math.floor(Date.now() / 1000);

    if (!code || !discordId || !channelId) {
      return new Response(JSON.stringify({ type: 4, data: { content: '❌ Missing required info. Please try again.', flags: 64 } }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const tokenRow = await env.DB.prepare(
      'SELECT user_id, expires_at FROM discord_verify_tokens WHERE token=?'
    ).bind(code).first().catch(() => null);

    if (!tokenRow) {
      return new Response(JSON.stringify({ type: 4, data: { content: '❌ Invalid code. Please generate a new one from RaxEdge Settings → Alerts.', flags: 64 } }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (tokenRow.expires_at < now) {
      await env.DB.prepare('DELETE FROM discord_verify_tokens WHERE token=?').bind(code).run().catch(() => {});
      return new Response(JSON.stringify({ type: 4, data: { content: '⏰ Code expired. Please generate a new one from RaxEdge Settings → Alerts.', flags: 64 } }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    await env.DB.prepare(`
      INSERT INTO notification_settings (user_id, discord_user_id, discord_dm_channel_id, discord_verified, enabled, min_ev, sports, updated_at)
      VALUES (?, ?, ?, 1, 1, 5.0, 'ALL', ?)
      ON CONFLICT(user_id) DO UPDATE SET
        discord_user_id       = excluded.discord_user_id,
        discord_dm_channel_id = excluded.discord_dm_channel_id,
        discord_verified      = 1,
        enabled               = 1,
        updated_at            = excluded.updated_at
    `).bind(tokenRow.user_id, discordId, channelId, now).run();

    await env.DB.prepare('DELETE FROM discord_verify_tokens WHERE token=?').bind(code).run().catch(() => {});

    return new Response(JSON.stringify({
      type: 4,
      data: {
        content: '✅ **RaxEdge alerts connected!**\n\nYou\'ll receive a Discord DM whenever a bet hits your EV threshold.\n\nManage settings anytime from RaxEdge → Settings → Alerts.',
        flags: 64
      }
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  // MESSAGE_COMPONENT — button click (t:alertId)
  if (body.type === 3) {
    const customId = body.data?.custom_id || '';
    if (!customId.startsWith('t:')) return new Response(JSON.stringify({ type: 1 }), { headers: { 'Content-Type': 'application/json' } });

    const alertId = parseInt(customId.slice(2));
    let nowTaken = false;

    if (alertId) {
      try {
        const row = await env.DB.prepare('SELECT taken FROM alert_messages WHERE id=?').bind(alertId).first();
        nowTaken = !row?.taken;
        await env.DB.prepare('UPDATE alert_messages SET taken=? WHERE id=?').bind(nowTaken ? 1 : 0, alertId).run();
      } catch(e) {}
    }

    const btnLabel = nowTaken ? '✅ Bet Taken' : '☑️ Mark Bet Taken';
    const btnStyle = nowTaken ? 3 : 2; // 3=success, 2=secondary

    return new Response(JSON.stringify({
      type: 7,
      data: {
        components: [{
          type: 1,
          components: [{
            type: 2,
            style: btnStyle,
            label: btnLabel,
            custom_id: customId
          }]
        }]
      }
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ type: 1 }), { headers: { 'Content-Type': 'application/json' } });
}
