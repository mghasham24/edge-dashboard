// functions/api/parlays/rs-verify-poll.js
// POST /api/parlays/rs-verify-poll?_cron_key=...
// Called every 60s by alert-cron.
// Polls edgebot's DM channels on RS for "parlay" trigger messages.
// When found: generates a 6-digit code, replies via DM, stores in D1.
//
// RS channels API response format (confirmed):
//   channel.id                  → numeric channel ID
//   channel.lastMessageDisplay  → plain-text preview of last message
//   channel.lastMessage.userId  → hashids user ID of last sender
//   channel.lastMessage.id      → message ID (numeric string)
//   channel.users[].userId      → hashids user ID
//   channel.users[].userName    → username string
//
// Edgebot's hashids user ID = first segment of EDGEBOT_AUTH_INFO (before '!')

import { hashidsEncode } from '../../_lib/hashids.js';
import { ok, err }       from '../../_lib/response.js';

const RS_BASE           = 'https://web.realapp.com';
const RS_DEVICE_UUID    = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';
const CAPSOLVER_SITEKEY = '0x4AAAAAADHHMQ4l_2uyXqiu';
const CODE_TTL          = 600; // 10 minutes

function buildHeaders(authInfo, sessionToken, withBody = false) {
  const h = {
    'Accept':             'application/json',
    'Accept-Language':    'en-US,en;q=0.9',
    'Origin':             'https://www.realapp.com',
    'Referer':            'https://www.realapp.com/',
    'User-Agent':         'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
    'real-auth-info':     authInfo,
    'real-session-token': sessionToken,
    'real-device-uuid':   RS_DEVICE_UUID,
    'real-device-type':   'desktop_web',
    'real-version':       '35',
    'real-request-token': hashidsEncode(Date.now()),
    'real-device-name':   '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
  };
  if (withBody) h['Content-Type'] = 'application/json';
  return h;
}

async function solveTurnstile(capsolverKey) {
  const createRes = await fetch('https://api.capsolver.com/createTask', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: capsolverKey,
      task: {
        type:       'AntiTurnstileTaskProxyLess',
        websiteURL: 'https://www.realapp.com/',
        websiteKey: CAPSOLVER_SITEKEY,
      },
    }),
    signal: AbortSignal.timeout(10000),
  });
  const created = await createRes.json();
  if (created.errorId !== 0 || !created.taskId)
    throw new Error('CapSolver create failed: ' + (created.errorCode || 'unknown'));

  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const poll = await fetch('https://api.capsolver.com/getTaskResult', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ clientKey: capsolverKey, taskId: created.taskId }),
      signal:  AbortSignal.timeout(8000),
    }).then(r => r.json());
    if (poll.status === 'ready')  return poll.solution.token;
    if (poll.status === 'failed') throw new Error('CapSolver solve failed');
  }
  throw new Error('CapSolver timeout');
}

function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function onRequestPost({ request, env }) {
  try {
    const url = new URL(request.url);
    if (!env.CRON_SECRET || url.searchParams.get('_cron_key') !== env.CRON_SECRET)
      return err('Unauthorized', 401);

    const debug        = url.searchParams.has('debug');
    const authInfo     = env.EDGEBOT_AUTH_INFO;
    const sessionToken = env.EDGEBOT_SESSION_TOKEN;
    const capsolverKey = env.CAPSOLVER_API_KEY;

    if (!authInfo || !sessionToken) return ok({ skipped: 'EDGEBOT credentials not configured' });

    // Edgebot's hashids user ID = first '!' segment of real-auth-info
    const edgebotHashId = authInfo.split('!')[0];
    const now = Math.floor(Date.now() / 1000);

    // 1. Fetch edgebot's DM channels — default + both request endpoints in parallel
    let channelData, requestData, requestsData;
    try {
      const headers = buildHeaders(authInfo, sessionToken);
      const [chanRes, reqRes, reqsRes] = await Promise.all([
        fetch(`${RS_BASE}/messages/channels?type=default`, { headers, signal: AbortSignal.timeout(8000) }),
        fetch(`${RS_BASE}/messages/channels?type=request`, { headers, signal: AbortSignal.timeout(8000) }),
        fetch(`${RS_BASE}/messages/requests`,              { headers, signal: AbortSignal.timeout(8000) }),
      ]);
      if (!chanRes.ok) {
        const body = await chanRes.text().catch(() => '');
        try { await env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at').bind('edgebot_debug', JSON.stringify({ error: 'channels_fetch_failed', status: chanRes.status, body: body.slice(0,300), ts: now }), now).run(); } catch(_) {}
        if ((chanRes.status === 401 || chanRes.status === 403) && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ALERT_CHAT_ID) {
          await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: env.TELEGRAM_ALERT_CHAT_ID, text: '⚠️ rs-verify-poll: edgebot RS session expired (' + chanRes.status + ') — users sending "parlay" won\'t get a code.\n\nUpdate EDGEBOT_AUTH_INFO + EDGEBOT_SESSION_TOKEN via wrangler.', parse_mode: 'HTML' }),
          }).catch(() => {});
        }
        return ok({ skipped: 'channels fetch failed', status: chanRes.status });
      }
      channelData = await chanRes.json();
      requestData  = reqRes.ok  ? await reqRes.json()  : { channels: [] };
      requestsData = reqsRes.ok ? await reqsRes.json() : {};
      // Debug: store channel snapshot + requestsData structure in D1
      try {
        const allCh = [...(channelData.channels || []), ...(requestData.channels || [])];
        const sorted = allCh.sort((a,b) => new Date(b.bumpedAt)-new Date(a.bumpedAt));
        const reqsArr = requestsData.channels || requestsData.requests || requestsData.data || Object.values(requestsData).find(v => Array.isArray(v)) || [];
        await env.DB.prepare('INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at').bind('edgebot_debug', JSON.stringify({
          ts: now,
          defaultCount: (channelData.channels || []).length,
          requestCount: (requestData.channels || []).length,
          requestsRawKeys: Object.keys(requestsData),
          requestsArrLen: reqsArr.length,
          requestsSample: reqsArr.slice(0,2).map(c => ({ id: c.id||c.channelId, lastDisplay: c.lastMessageDisplay, lastSenderId: c.lastMessage?.userId, bumpedAt: c.bumpedAt, keys: Object.keys(c).slice(0,8) })),
          withParlay: sorted.filter(c => (c.lastMessageDisplay||'').toLowerCase().includes('parlay')).map(c => ({ id: c.id, lastDisplay: c.lastMessageDisplay, lastSenderId: c.lastMessage?.userId, bumpedAt: c.bumpedAt })),
          top10: sorted.slice(0,10).map(c => ({ id: c.id, lastDisplay: (c.lastMessageDisplay||'').slice(0,60), lastSenderId: c.lastMessage?.userId, bumpedAt: c.bumpedAt })),
        }), now).run();
      } catch(_) {}
    } catch(e) {
      return ok({ skipped: 'channels fetch error', error: e.message });
    }

    // Track which channel IDs are pending requests — need acceptrequest before replying
    // Merge IDs from both /channels?type=request and /messages/requests
    const requestChannelIds = new Set([
      ...(requestData.channels  || []).map(c => String(c.id)),
      ...(requestsData.channels || requestsData.requests || []).map(c => String(c.id || c.channelId || '')).filter(Boolean),
    ]);

    if (debug) {
      const allChannels = [...(channelData.channels || []), ...(requestData.channels || [])];
      return new Response(JSON.stringify({
        edgebotHashId,
        channelCount: allChannels.length,
        requestCount: requestChannelIds.size,
        requestsEndpointRaw: requestsData,
        recent: allChannels
          .sort((a, b) => new Date(b.bumpedAt) - new Date(a.bumpedAt))
          .slice(0, 5)
          .map(c => ({
            id: c.id,
            isRequest: requestChannelIds.has(String(c.id)),
            bumpedAt: c.bumpedAt,
            lastDisplay: c.lastMessageDisplay,
            lastSenderId: c.lastMessage?.userId,
            users: (c.users || []).map(u => ({ userId: u.userId, userName: u.userName })),
          })),
      }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    // Deduplicate by channel ID across all three channel sources
    const _reqsChannels = requestsData.channels || requestsData.requests || [];
    const _seenIds = new Set();
    const channelList = [...(channelData.channels || []), ...(requestData.channels || []), ..._reqsChannels]
      .sort((a, b) => new Date(b.bumpedAt) - new Date(a.bumpedAt))
      .filter(c => { const id = String(c.id || ''); if (!id || _seenIds.has(id)) return false; _seenIds.add(id); return true; });

    const sent = [];

    for (const channel of channelList) {
      const channelId  = String(channel.id || '');
      if (!channelId) continue;

      // Quick-check: last message must contain "parlay" OR last sender is edgebot
      // (edgebot may have sent a win notification after a user's "parlay" message)
      const lastMsg       = channel.lastMessage;
      if (!lastMsg) continue;
      const lastDisplay   = (channel.lastMessageDisplay || '').toLowerCase().trim();
      const lastSenderId  = lastMsg.userId || '';
      let   lastMsgId     = String(lastMsg.id || '');

      // If lastSender is edgebot, dig into channel history to find the user's "parlay"
      let effectiveSenderId = lastSenderId;
      let effectiveDisplay  = lastDisplay;
      if (lastSenderId === edgebotHashId) {
        // Only look back if channel was bumped recently (within 24h)
        const bumpedMs = new Date(channel.bumpedAt || 0).getTime();
        if (Date.now() - bumpedMs > 24 * 60 * 60 * 1000) continue;
        try {
          const msgRes = await fetch(`${RS_BASE}/messages/channels/${channelId}/messages?limit=20`, {
            headers: buildHeaders(authInfo, sessionToken),
            signal: AbortSignal.timeout(8000),
          });
          if (msgRes.ok) {
            const msgData = await msgRes.json();
            const msgs = msgData.messages || msgData.data || [];
            // Find most recent non-edgebot message
            const userMsg = msgs.find(m => m.userId !== edgebotHashId && m.userId);
            if (!userMsg) continue;
            effectiveDisplay  = (userMsg.text || userMsg.body || '').toLowerCase();
            effectiveSenderId = userMsg.userId;
            lastMsgId         = String(userMsg.id || lastMsgId);
          }
        } catch(e) { continue; }
      }

      if (!effectiveDisplay.includes('parlay')) continue;
      if (effectiveSenderId === edgebotHashId) continue;

      // Skip if we already processed this exact message
      const seenKey = 'edgebot_dm_seen_' + channelId;
      try {
        const seenRow = await env.DB.prepare('SELECT data FROM odds_cache WHERE cache_key=?').bind(seenKey).first();
        if (seenRow) {
          const seenData = JSON.parse(seenRow.data);
          if (seenData.lastId === lastMsgId) continue;
        }
      } catch(e) {}

      // Skip if we already have an active code for this channel or RS user
      const rsUserId   = effectiveSenderId;
      const otherUser  = (channel.users || []).find(u => u.userId === rsUserId);
      const rsUsername = otherUser?.userName || '';

      try {
        const existing = await env.DB.prepare(
          'SELECT code FROM rs_verify_codes WHERE (channel_id=? OR rs_user_id=?) AND expires_at>?'
        ).bind(channelId, rsUserId, now).first();
        if (existing) continue;
      } catch(e) {}

      // 2. Accept message request if this is a first-time DM
      if (requestChannelIds.has(channelId)) {
        try {
          await fetch(`${RS_BASE}/messages/channels/${channelId}/acceptrequest`, {
            method:  'PUT',
            headers: buildHeaders(authInfo, sessionToken, true),
            body:    '{}',
            signal:  AbortSignal.timeout(8000),
          });
        } catch(e) { /* non-fatal — attempt send anyway */ }
      }

      // 3. Solve Turnstile (required for message send)
      let turnstileToken = null;
      if (capsolverKey) {
        try { turnstileToken = await solveTurnstile(capsolverKey); }
        catch(e) { sent.push({ skipped: 'turnstile_failed', channelId, error: e.message }); continue; }
      }

      // 4. Generate code and send reply
      const code      = genCode();
      const replyText = `Your RaxEdge verification code is: ${code}\n\nEnter it at raxedge.com under Parlays to connect your account. Expires in 10 minutes.`;

      const sendHeaders = {
        ...buildHeaders(authInfo, sessionToken, true),
        ...(turnstileToken ? { 'real-turnstile-token': turnstileToken } : {}),
      };

      let sendOk = false;
      try {
        const sendRes = await fetch(`${RS_BASE}/messages/channels/${channelId}/messages`, {
          method:  'POST',
          headers: sendHeaders,
          body:    JSON.stringify({ text: replyText, parentMessageId: null }),
          signal:  AbortSignal.timeout(15000),
        });
        if (!sendRes.ok) {
          const body = await sendRes.text().catch(() => '');
          sent.push({ skipped: 'send_failed', channelId, status: sendRes.status, body: body.slice(0, 300) });
          continue;
        }
        sendOk = true;
      } catch(e) {
        sent.push({ skipped: 'send_error', channelId, error: e.message }); continue;
      }

      if (!sendOk) continue;

      // 5. Store code in D1 + cache channel_id on real_auth for future win DMs
      try {
        await env.DB.prepare(
          'INSERT INTO rs_verify_codes (code, rs_user_id, rs_username, channel_id, created_at, expires_at) VALUES (?,?,?,?,?,?)'
        ).bind(code, rsUserId, rsUsername, channelId, now, now + CODE_TTL).run();
      } catch(e) {
        sent.push({ skipped: 'db_write_failed', channelId, error: e.message });
        continue;
      }
      try {
        await env.DB.prepare(
          'UPDATE real_auth SET dm_channel_id = ? WHERE rs_user_id = ?'
        ).bind(channelId, rsUserId).run();
      } catch(e) { /* non-fatal */ }

      // 6. Mark message as processed
      try {
        await env.DB.prepare(
          'INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at'
        ).bind(seenKey, JSON.stringify({ lastId: lastMsgId, processedAt: now }), now).run();
      } catch(e) {}

      sent.push({ channelId, rsUsername, rsUserId });
    }

    // Send any pending referral DMs queued by rs-verify.js
    // Uses the same Turnstile+send flow as verification codes above.
    const { results: pendingDms } = await env.DB.prepare(
      "SELECT cache_key, data FROM odds_cache WHERE cache_key LIKE 'referral_dm_pending_%'"
    ).all().catch(() => ({ results: [] }));

    for (const row of pendingDms) {
      let dmData;
      try { dmData = JSON.parse(row.data); } catch { continue; }
      const { channelId: dmChannelId, msg: dmMsg } = dmData;
      if (!dmChannelId || !dmMsg) continue;

      let dmTurnstile = null;
      if (capsolverKey) {
        try { dmTurnstile = await solveTurnstile(capsolverKey); }
        catch(e) { sent.push({ skipped: 'referral_dm_turnstile_failed', dmChannelId, error: e.message }); continue; }
      }

      // Claim the entry by deleting it first — prevents two cron instances from sending the same DM
      const del = await env.DB.prepare('DELETE FROM odds_cache WHERE cache_key=?').bind(row.cache_key).run().catch(() => ({ meta: { changes: 0 } }));
      if (!del.meta?.changes) continue; // another cron already claimed it

      try {
        const dmRes = await fetch(`${RS_BASE}/messages/channels/${dmChannelId}/messages`, {
          method:  'POST',
          headers: {
            ...buildHeaders(authInfo, sessionToken, true),
            ...(dmTurnstile ? { 'real-turnstile-token': dmTurnstile } : {}),
          },
          body:   JSON.stringify({ text: dmMsg, parentMessageId: null }),
          signal: AbortSignal.timeout(15000),
        });
        if (dmRes.ok) {
          sent.push({ referralDm: true, dmChannelId, ok: true });
        } else {
          const body = await dmRes.text().catch(() => '');
          sent.push({ referralDm: true, dmChannelId, status: dmRes.status, body: body.slice(0, 200) });
        }
      } catch(e) {
        sent.push({ referralDm: true, dmChannelId, error: e.message });
      }
    }

    // Send any pending milestone DMs queued by deposit-check.js (2k stake reached)
    const { results: pendingMilestoneDms } = await env.DB.prepare(
      "SELECT cache_key, data FROM odds_cache WHERE cache_key LIKE 'milestone_dm_pending_%'"
    ).all().catch(() => ({ results: [] }));

    for (const row of pendingMilestoneDms) {
      let dmData;
      try { dmData = JSON.parse(row.data); } catch { continue; }
      const { channelId: dmChannelId, msg: dmMsg } = dmData;
      if (!dmChannelId || !dmMsg) continue;

      let dmTurnstile = null;
      if (capsolverKey) {
        try { dmTurnstile = await solveTurnstile(capsolverKey); }
        catch(e) { sent.push({ skipped: 'milestone_dm_turnstile_failed', dmChannelId, error: e.message }); continue; }
      }

      const del = await env.DB.prepare('DELETE FROM odds_cache WHERE cache_key=?').bind(row.cache_key).run().catch(() => ({ meta: { changes: 0 } }));
      if (!del.meta?.changes) continue;

      try {
        const dmRes = await fetch(`${RS_BASE}/messages/channels/${dmChannelId}/messages`, {
          method:  'POST',
          headers: {
            ...buildHeaders(authInfo, sessionToken, true),
            ...(dmTurnstile ? { 'real-turnstile-token': dmTurnstile } : {}),
          },
          body:   JSON.stringify({ text: dmMsg, parentMessageId: null }),
          signal: AbortSignal.timeout(15000),
        });
        if (dmRes.ok) {
          sent.push({ milestoneDm: true, dmChannelId, ok: true });
        } else {
          const body = await dmRes.text().catch(() => '');
          sent.push({ milestoneDm: true, dmChannelId, status: dmRes.status, body: body.slice(0, 200) });
        }
      } catch(e) {
        sent.push({ milestoneDm: true, dmChannelId, error: e.message });
      }
    }

    return ok({ processed: sent.length, sent });

  } catch(e) {
    return new Response(JSON.stringify({ error: e.message, stack: e.stack }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
