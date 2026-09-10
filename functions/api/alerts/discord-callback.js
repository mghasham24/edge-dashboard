// functions/api/alerts/discord-callback.js
// GET /api/alerts/discord-callback?code=...&state=...
// Discord redirects here after user authorizes. No session cookie needed — state ties back to user.

const BASE = 'https://raxedge.com';
function redirect(path) {
  return new Response(null, { status: 302, headers: { Location: path.startsWith('http') ? path : BASE + path } });
}

export async function onRequestGet({ request, env }) {
  const url   = new URL(request.url);
  const code  = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) return redirect('/?discord=error&reason=missing');

  // Verify state token
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    'SELECT user_id, expires_at FROM discord_verify_tokens WHERE token=?'
  ).bind(state).first();

  if (!row)                 return redirect('/?discord=error&reason=invalid');
  if (row.expires_at < now) return redirect('/?discord=error&reason=expired');

  await env.DB.prepare('DELETE FROM discord_verify_tokens WHERE token=?').bind(state).run();

  // Exchange code for access token
  const redirectUri = 'https://raxedge.com/api/alerts/discord-callback';
  let accessToken;
  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  redirectUri,
      }),
    });
    if (!tokenRes.ok) return redirect('/?discord=error&reason=token');
    const tokenData = await tokenRes.json();
    accessToken = tokenData.access_token;
  } catch (_) {
    return redirect('/?discord=error&reason=token');
  }

  // Get Discord user ID
  let discordUserId;
  try {
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userRes.ok) return redirect('/?discord=error&reason=user');
    const userData = await userRes.json();
    discordUserId = userData.id;
  } catch (_) {
    return redirect('/?discord=error&reason=user');
  }

  const now2 = Math.floor(Date.now() / 1000);

  // Create DM channel
  let dmChannelId = null;
  if (env.DISCORD_BOT_TOKEN) {
    try {
      const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
        method: 'POST',
        headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient_id: discordUserId }),
      });
      if (dmRes.ok) { const d = await dmRes.json(); dmChannelId = d.id || null; }
    } catch (_) {}
  }

  // Save discord_user_id + dm_channel_id but do NOT mark verified yet —
  // user must reply /connect <code> to prove they can receive messages
  await env.DB.prepare(`
    INSERT INTO notification_settings (user_id, discord_user_id, discord_dm_channel_id, discord_verified, updated_at)
    VALUES (?, ?, ?, 0, ?)
    ON CONFLICT(user_id) DO UPDATE SET discord_user_id=excluded.discord_user_id, discord_dm_channel_id=excluded.discord_dm_channel_id, discord_verified=0, updated_at=excluded.updated_at
  `).bind(row.user_id, discordUserId, dmChannelId, now2).run();

  // Generate verification code for the /connect slash command
  const verifyCode = Array.from(crypto.getRandomValues(new Uint8Array(3)), b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  const expiresAt = now2 + 600;
  await env.DB.prepare('DELETE FROM discord_verify_tokens WHERE user_id=?').bind(row.user_id).run();
  await env.DB.prepare('INSERT INTO discord_verify_tokens (token, user_id, expires_at) VALUES (?,?,?)')
    .bind(verifyCode, row.user_id, expiresAt).run();

  // Send verification code via DM — this lets users without a shared server connect.
  // If the bot can open a DM, the user sees a notification and types /connect CODE.
  // Error 50007 = user has DMs disabled; we fall through silently and show the code on screen.
  let dmSent = false;
  if (dmChannelId && env.DISCORD_BOT_TOKEN) {
    try {
      const msgRes = await fetch(`https://discord.com/api/v10/channels/${dmChannelId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `🎯 **RaxEdge Alert Setup**\n\nYour verification code: **\`${verifyCode}\`**\n\nType this command right here in this DM:\n\`/connect ${verifyCode}\`\n\n*Code expires in 10 minutes.*`
        }),
      });
      dmSent = msgRes.ok;
    } catch (_) {}
  }

  return redirect(dmSent ? '/?discord=dm_sent' : '/?discord=pending');
}
