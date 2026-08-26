// GET /api/parlays/avatar-backfill?_cron_key=...&reset=1
// Resumable: pages through edgebot DM channels, saves cursor to D1 so the 30s CF wall
// clock never cuts it off. Call repeatedly until response shows done:true.
// ?reset=1  — clear saved cursor and start from the beginning.
//
// GET /api/parlays/avatar-backfill?_cron_key=...&targeted=1
// Targeted: fetches /user/{rs_username} for every real_auth row with rs_avatar_url IS NULL.
// Use this after the channel-pagination pass to catch users whose DM channels are past the
// RS history cutoff.

import { hashidsEncode } from '../../_lib/hashids.js';

const RS_BASE        = 'https://web.realapp.com';
const RS_DEVICE_UUID = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';
const CURSOR_KEY     = 'avatar_backfill_cursor';
const BUDGET_MS      = 22000; // stop fetching pages after 22s — leaves time for D1 writes

function buildHeaders(authInfo, sessionToken) {
  return {
    'Accept':             'application/json',
    'Origin':             'https://www.realapp.com',
    'Referer':            'https://www.realapp.com/',
    'User-Agent':         'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
    'real-auth-info':     authInfo,
    'real-session-token': sessionToken || '',
    'real-device-uuid':   RS_DEVICE_UUID,
    'real-device-type':   'desktop_web',
    'real-version':       '35',
    'real-request-token': hashidsEncode(Date.now()),
    'real-device-name':   '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
  };
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (!env.CRON_SECRET || url.searchParams.get('_cron_key') !== env.CRON_SECRET)
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  const authInfo     = env.EDGEBOT_AUTH_INFO;
  const sessionToken = env.EDGEBOT_SESSION_TOKEN;
  if (!authInfo || !sessionToken)
    return new Response(JSON.stringify({ error: 'EDGEBOT credentials not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } });

  const reset    = url.searchParams.get('reset') === '1';
  const targeted = url.searchParams.get('targeted') === '1';

  // --- Targeted mode: fetch /user/{rs_username} for all rows missing an avatar ---
  if (targeted) {
    const rows = await env.DB.prepare(
      "SELECT rs_user_id, rs_username FROM real_auth WHERE rs_avatar_url IS NULL AND rs_username IS NOT NULL"
    ).all();
    const users = rows.results || [];

    let attempted = 0, updated = 0, errors = 0;
    for (const u of users) {
      attempted++;
      try {
        const res = await fetch(`${RS_BASE}/user/${encodeURIComponent(u.rs_username)}`, {
          headers: buildHeaders(authInfo, sessionToken),
          signal:  AbortSignal.timeout(8000),
        });
        if (!res.ok) { errors++; continue; }
        const data = await res.json();
        const avatarKey = data?.user?.avatarKey;
        const userId    = data?.user?.id;
        if (!avatarKey || !userId) { errors++; continue; }
        const avatarUrl = `https://media.realapp.com/assets/user/default/large/${userId}_${avatarKey}.webp`;
        const result = await env.DB.prepare(
          'UPDATE real_auth SET rs_avatar_url=? WHERE rs_user_id=? AND (rs_avatar_url IS NULL OR rs_avatar_url != ?)'
        ).bind(avatarUrl, u.rs_user_id, avatarUrl).run();
        if (result.meta?.changes) updated++;
      } catch { errors++; }
      await new Promise(r => setTimeout(r, 150));
    }

    if (updated > 0) {
      await env.DB.prepare("DELETE FROM odds_cache WHERE cache_key LIKE 'leaderboard:%'").run().catch(() => {});
    }

    return new Response(JSON.stringify({ targeted: true, attempted, updated, errors }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // --- Channel-pagination mode (default) ---

  // Load or clear saved cursor
  let before = '';
  if (!reset) {
    const saved = await env.DB.prepare(
      "SELECT data FROM odds_cache WHERE cache_key=?"
    ).bind(CURSOR_KEY).first();
    before = saved?.data ? JSON.parse(saved.data) : '';
  } else {
    await env.DB.prepare(
      "DELETE FROM odds_cache WHERE cache_key=?"
    ).bind(CURSOR_KEY).run().catch(() => {});
  }

  const avatarMap = new Map();
  let totalChannels = 0;
  let pages = 0;
  let timedOut = false;
  const start = Date.now();

  while (true) {
    if (Date.now() - start >= BUDGET_MS) { timedOut = true; break; }

    let data;
    try {
      const qs  = before ? `?type=default&before=${encodeURIComponent(before)}` : '?type=default';
      const res = await fetch(`${RS_BASE}/messages/channels${qs}`, {
        headers: buildHeaders(authInfo, sessionToken),
        signal:  AbortSignal.timeout(10000),
      });
      if (!res.ok) break;
      data = await res.json();
    } catch { break; }

    const channels = data.channels || data.data || (Array.isArray(data) ? data : []);
    pages++;
    totalChannels += channels.length;

    for (const ch of channels) {
      for (const u of (ch.users || [])) {
        if (u.userId && u.avatarKey && !avatarMap.has(u.userId)) {
          avatarMap.set(u.userId, `https://media.realapp.com/assets/user/default/large/${u.userId}_${u.avatarKey}.webp`);
        }
      }
    }

    if (channels.length === 0) break;

    const oldest    = channels[channels.length - 1];
    const nextBefore = oldest?.bumpedAt || '';
    if (!nextBefore || nextBefore === before) break;
    before = nextBefore;

    await new Promise(r => setTimeout(r, 100));
  }

  // Save cursor for next run (or delete it if we finished)
  if (timedOut) {
    await env.DB.prepare(
      "INSERT INTO odds_cache (cache_key,data,fetched_at) VALUES(?,?,?) " +
      "ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at"
    ).bind(CURSOR_KEY, JSON.stringify(before), Math.floor(Date.now() / 1000)).run().catch(() => {});
  } else {
    await env.DB.prepare(
      "DELETE FROM odds_cache WHERE cache_key=?"
    ).bind(CURSOR_KEY).run().catch(() => {});
  }

  // Bulk-write avatars to real_auth — only update when missing or changed
  let updated = 0;
  for (const [uid, avatarUrl] of avatarMap) {
    try {
      const result = await env.DB.prepare(
        'UPDATE real_auth SET rs_avatar_url=? WHERE rs_user_id=? AND (rs_avatar_url IS NULL OR rs_avatar_url != ?)'
      ).bind(avatarUrl, uid, avatarUrl).run();
      if (result.meta?.changes) updated++;
    } catch (_) {}
  }

  // Bust leaderboard cache on final pass so fresh avatars appear immediately
  if (!timedOut) {
    await env.DB.prepare("DELETE FROM odds_cache WHERE cache_key LIKE 'leaderboard:%'").run().catch(() => {});
  }

  return new Response(JSON.stringify({
    done: !timedOut,
    pages,
    totalChannels,
    avatarsFound: avatarMap.size,
    updated,
    cursor: timedOut ? before : null,
    elapsed_ms: Date.now() - start,
  }), { headers: { 'Content-Type': 'application/json' } });
}
