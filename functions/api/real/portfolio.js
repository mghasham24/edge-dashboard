import { getSession } from '../../_lib/session.js';
import { hashidsEncode } from '../../_lib/hashids.js';
// functions/api/real/portfolio.js
// GET /api/real/portfolio — fetches user's portfolio from Real Sports API

function buildHeaders(authToken, deviceUuid) {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': 'https://realsports.io',
    'Referer': 'https://realsports.io/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-auth-info': authToken,
    'real-device-type': 'desktop_web',
    'real-device-uuid': deviceUuid || '2e0a38e2-0ee8-4f93-9a34-218ac1d10161',
    'real-device-name': '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-request-token': hashidsEncode(Date.now()),
    'real-version': '32'
  };
}

async function safeFetch(url, headers) {
  try {
    const res = await fetch(url, { headers });
    const text = await res.text();
    if (!res.ok) return { _err: res.status, _url: url };
    try { return JSON.parse(text); } catch { return { _err: 'json_parse', _url: url, _body: text.slice(0, 200) }; }
  } catch (e) {
    return { _err: e.message, _url: url };
  }
}

async function probe(url, headers, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
    return { status: res.status, body };
  } catch (e) {
    clearTimeout(timer);
    return { status: e.name === 'AbortError' ? 'timeout' : 'err', body: e.message };
  }
}

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env.DB);
  if (!session) return fail(401, 'Authentication required');

  let authRow = null;
  try {
    authRow = await env.DB.prepare(
      'SELECT auth_token, device_uuid FROM real_auth WHERE user_id = ?'
    ).bind(session.user_id).first();
  } catch {
    return json({ ok: true, connected: false });
  }

  // Fall back to static env token for admin when no real_auth row exists
  if (!authRow?.auth_token) {
    if (session.is_admin && env.RS_AUTH_TOKEN) {
      authRow = { auth_token: env.RS_AUTH_TOKEN, device_uuid: null };
    } else {
      return json({ ok: true, connected: false });
    }
  }

  const hdrs = buildHeaders(authRow.auth_token, authRow.device_uuid);
  const base = 'https://web.realapp.com';
  const url  = new URL(request.url);

  // ?debug=1 — probe candidate paths sequentially, stop at first 200
  if (url.searchParams.get('debug') === '1' && session.is_admin) {
    const candidates = [
      '/portfolio',
      '/portfolio/overview',
      '/portfolio/positions',
      '/portfolio/positions/open',
      '/portfolio/positions/history',
      '/portfolio/history',
      '/account/portfolio',
      '/user/portfolio',
      '/predictions/portfolio',
      '/positions',
      '/bets',
    ];
    const results = {};
    for (const path of candidates) {
      const r = await probe(`${base}${path}`, hdrs, 3000);
      results[path] = { status: r.status };
      // include body only for 200s to keep response small
      if (r.status === 200) results[path].body = r.body;
    }
    return json({ ok: true, connected: true, probe: results });
  }

  // ?path=/some/endpoint — test a single specific path and return full body
  const testPath = url.searchParams.get('path');
  if (testPath && session.is_admin) {
    const r = await probe(`${base}${testPath}`, hdrs, 5000);
    return json({ ok: true, connected: true, path: testPath, status: r.status, body: r.body });
  }

  // ?probepagination=LAST_ITEM_ID&ts=LAST_TRANSACTED_AT — targeted pagination probe
  // e.g. /api/real/portfolio?probepagination=history-3187-6373&ts=2026-04-06T01:40:32.355Z
  const probeId = url.searchParams.get('probepagination');
  if (probeId && session.is_admin) {
    const ts = url.searchParams.get('ts') || '';
    // Only 6 candidates, sequential, 3s abort each = max ~18s
    const candidates = [
      ['after',       probeId],
      ['cursor',      probeId],
      ['before',      ts || probeId],
      ['offset',      '10'],
      ['page',        '2'],
      ['lastItemId',  probeId],
    ];
    const baselineItems = (await probe(`${base}/predictions/historyrollup`, hdrs, 3000)).body?.items || [];
    const baselineFirst = baselineItems[0]?.id || null;
    const results = {};
    for (const [param, val] of candidates) {
      const r = await probe(`${base}/predictions/historyrollup?${param}=${encodeURIComponent(val)}`, hdrs, 3000);
      const items = r.body?.items || [];
      const firstId = items[0]?.id || null;
      results[param] = {
        status: r.status,
        count: items.length,
        firstId,
        paginationWorked: firstId !== null && firstId !== baselineFirst
      };
    }
    return json({ ok: true, baselineFirst, results });
  }

  // before param — cursor pagination for historyrollup (?before=LAST_LATEST_LEDGER_TIMESTAMP)
  const before    = url.searchParams.get('before') || '';
  const timeframe = url.searchParams.get('timeframe') || '1m';

  // Try to fetch as many items per page as the API will allow
  const PAGE_SIZE = 100;
  const limitParam = `limit=${PAGE_SIZE}&pageSize=${PAGE_SIZE}&size=${PAGE_SIZE}&count=${PAGE_SIZE}`;

  const histUrl   = before
    ? `${base}/predictions/historyrollup?before=${encodeURIComponent(before)}&${limitParam}`
    : `${base}/predictions/historyrollup?${limitParam}`;

  // Pagination-only request — skip perf + open
  if (before) {
    const history = await safeFetch(histUrl, hdrs);
    return json({ ok: true, connected: true, history });
  }

  const [perf, open, history] = await Promise.all([
    safeFetch(`${base}/predictions/portfolioperformance?timeframe=${timeframe}`, hdrs),
    safeFetch(`${base}/predictions/openpositions`, hdrs),
    safeFetch(histUrl, hdrs),
  ]);

  return json({ ok: true, connected: true, performance: perf, open, history });
}

function getToken(req) {
  const c = req.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  return m ? m[1] : null;
}

function json(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' }
  });
}

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
