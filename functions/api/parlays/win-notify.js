// functions/api/parlays/win-notify.js
// POST /api/parlays/win-notify?_cron_key=...
// Called every 60s by alert-cron.
// Sends an RS DM via edgebot to each parlay winner not yet notified.
// Reuses the dm_channel_id cached in real_auth during the verify flow.

import { hashidsEncode } from '../../_lib/hashids.js';
import { ok, err }       from '../../_lib/response.js';

const RS_BASE        = 'https://web.realapp.com';
const RS_DEVICE_UUID = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';

const CAPSOLVER_SITEKEY = '0x4AAAAAADHHMQ4l_2uyXqiu';

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

function buildWinMessage(parlay, legs) {
  const mult = parlay.stake_rax > 0
    ? (parlay.payout_rax / parlay.stake_rax).toFixed(2) + 'x'
    : '';
  const legLines = (legs || []).map(l => `✅ ${l.player_name} — ${l.label}`).join('\n');
  const slipUrl = parlay.share_token ? `\nhttps://raxedge.com/slip?t=${parlay.share_token}` : '';
  return (
    `🏆 Your parlay won!\n\n` +
    `${parlay.legs_count}-leg · ${Number(parlay.stake_rax).toLocaleString()} Rax → ${Number(parlay.payout_rax).toLocaleString()} Rax${mult ? ' (' + mult + ')' : ''}\n\n` +
    (legLines ? legLines + '\n\n' : '') +
    `Your payout is on its way — check your offers!` +
    slipUrl
  );
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  if (!env.CRON_SECRET || url.searchParams.get('_cron_key') !== env.CRON_SECRET)
    return err('Unauthorized', 401);

  const authInfo     = env.EDGEBOT_AUTH_INFO;
  const sessionToken = env.EDGEBOT_SESSION_TOKEN;
  const capsolverKey = env.CAPSOLVER_API_KEY;

  if (!authInfo || !sessionToken)
    return ok({ skipped: 'EDGEBOT credentials not configured' });

  const now = Math.floor(Date.now() / 1000);

  // Find won parlays that haven't been notified yet and have a cached DM channel
  const { results: pending } = await env.DB.prepare(
    'SELECT p.id, p.stake_rax, p.payout_rax, p.legs_count, p.share_token, ra.dm_channel_id ' +
    'FROM parlays p ' +
    'JOIN real_auth ra ON ra.user_id = p.user_id ' +
    "WHERE p.status = 'won' AND p.win_notified_at IS NULL AND ra.dm_channel_id IS NOT NULL " +
    'LIMIT 5'
  ).all();

  if (!pending.length) return ok({ notified: 0 });

  // Batch-fetch legs for all winning parlays
  const ids = pending.map(p => p.id);
  const { results: allLegs } = await env.DB.prepare(
    `SELECT parlay_id, player_name, label FROM parlay_legs WHERE parlay_id IN (${ids.map(() => '?').join(',')}) ORDER BY parlay_id, id ASC`
  ).bind(...ids).all();
  const legsByParlay = {};
  for (const leg of allLegs) {
    if (!legsByParlay[leg.parlay_id]) legsByParlay[leg.parlay_id] = [];
    legsByParlay[leg.parlay_id].push(leg);
  }

  let notified = 0;
  const results = [];

  for (const parlay of pending) {
    const channelId = parlay.dm_channel_id;
    const message   = buildWinMessage(parlay, legsByParlay[parlay.id] || []);

    // Solve Turnstile
    let turnstileToken = null;
    if (capsolverKey) {
      try { turnstileToken = await solveTurnstile(capsolverKey); }
      catch(e) {
        results.push({ parlayId: parlay.id, error: 'turnstile_failed: ' + e.message });
        continue;
      }
    }

    const sendHeaders = {
      ...buildHeaders(authInfo, sessionToken, true),
      ...(turnstileToken ? { 'real-turnstile-token': turnstileToken } : {}),
    };

    try {
      const sendRes = await fetch(`${RS_BASE}/messages/channels/${channelId}/messages`, {
        method:  'POST',
        headers: sendHeaders,
        body:    JSON.stringify({ text: message, parentMessageId: null }),
        signal:  AbortSignal.timeout(15000),
      });

      if (!sendRes.ok) {
        const body = await sendRes.text().catch(() => '');
        results.push({ parlayId: parlay.id, error: 'send_failed ' + sendRes.status, body: body.slice(0, 200) });
        continue;
      }

      await env.DB.prepare('UPDATE parlays SET win_notified_at = ? WHERE id = ?')
        .bind(now, parlay.id).run();

      notified++;
      results.push({ parlayId: parlay.id, ok: true });
    } catch(e) {
      results.push({ parlayId: parlay.id, error: e.message });
    }
  }

  return ok({ notified, results });
}
