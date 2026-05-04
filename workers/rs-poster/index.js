// workers/rs-poster/index.js
// Polls RS open positions every minute and posts new ones to the RS group.
// Auto-authenticates using stored credentials when the session token expires.
//
// Secrets required (Cloudflare dashboard → Workers → rs-poster → Settings → Variables):
//   RS_LOGIN      — RS phone number / email
//   RS_PASSWORD   — RS password
//   RS_GROUP_ID   — numeric group ID of your RaxEdge Predictions RS group

const RS_BASE       = 'https://web.realapp.com';
const RS_WEB_BASE   = 'https://www.realapp.com';
const RS_LOGIN_URL  = RS_BASE + '/login';
const RS_OPEN_POS   = RS_BASE + '/predictions/openpositions';
const RS_POS_DETAIL = (id) => RS_BASE + '/predictions/position/' + id;
const RS_GROUP_POST = (groupId) => RS_BASE + '/comments/groups/' + groupId;
const AUTH_CACHE_KEY = 'rs_auth_token';

function rsHeaders(authToken, deviceUuid) {
  return {
    'Content-Type':       'application/json',
    'Accept':             'application/json',
    'Accept-Language':    'en-US,en;q=0.9',
    'Origin':             'https://www.realapp.com',
    'Referer':            'https://www.realapp.com/',
    'User-Agent':         'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-device-uuid':   deviceUuid || '2e0a38e2-0ee8-4f93-9a34-218ac1d10161',
    'real-device-name':   '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-device-type':   'desktop_web',
    'real-version':       '31',
    'real-request-token': Math.random().toString(36).slice(2, 18),
    'real-auth-info':     authToken || '',
  };
}

// Module-level token cache — persists across invocations within the same Worker instance
// Avoids a D1 read on every scheduled run; re-reads only when the token is missing or expired
let _cachedToken = null;
let _cachedTokenFetchedAt = 0;
const TOKEN_CACHE_TTL = 10 * 60; // re-read from D1 at most once every 10 minutes

async function getCachedToken(db) {
  const now = Math.floor(Date.now() / 1000);
  if (_cachedToken && (now - _cachedTokenFetchedAt) < TOKEN_CACHE_TTL) return _cachedToken;
  try {
    // First check Tampermonkey-pushed token (rs_auth_token)
    const tm = await db.prepare(
      "SELECT data FROM odds_cache WHERE cache_key='rs_auth_token'"
    ).first();
    if (tm?.data) {
      const parsed = JSON.parse(tm.data);
      if (parsed.token) {
        _cachedToken = { token: parsed.token, deviceUuid: parsed.deviceUuid || '2e0a38e2-0ee8-4f93-9a34-218ac1d10161' };
        _cachedTokenFetchedAt = now;
        return _cachedToken;
      }
    }
    // Fall back to worker-managed cache
    const row = await db.prepare(
      "SELECT data FROM odds_cache WHERE cache_key=?"
    ).bind(AUTH_CACHE_KEY).first();
    const val = row?.data;
    if (val && val !== '__expired__') {
      _cachedToken = { token: val, deviceUuid: '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e' };
      _cachedTokenFetchedAt = now;
      return _cachedToken;
    }
  } catch {}
  return null;
}

async function setCachedToken(db, token) {
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    "INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at"
  ).bind(AUTH_CACHE_KEY, token, now).run();
  // Update in-memory cache so the new token is used immediately without another D1 read
  _cachedToken = { token, deviceUuid: '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e' };
  _cachedTokenFetchedAt = now;
}

function loginHeaders(deviceUuid) {
  return {
    'Content-Type':       'application/json',
    'Accept':             'application/json',
    'Accept-Language':    'en-US,en;q=0.9',
    'Origin':             'https://www.realapp.com',
    'Referer':            'https://www.realapp.com/',
    'User-Agent':         'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-device-uuid':   deviceUuid,
    'real-device-name':   '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-device-type':   'desktop_web',
    'real-version':       '31',
    'real-request-token': Math.random().toString(36).slice(2, 18),
  };
}

async function login(env) {
  if (!env.RS_LOGIN || !env.RS_PASSWORD) {
    console.error('rs-poster: RS_LOGIN or RS_PASSWORD not set');
    return null;
  }
  console.log('rs-poster: logging in as', env.RS_LOGIN);
  const res = await fetch(RS_LOGIN_URL, {
    method: 'POST',
    headers: loginHeaders(env.RS_DEVICE_UUID),
    body: JSON.stringify({
      login: env.RS_LOGIN,
      password: env.RS_PASSWORD,
      tfaAuthCode: '',
      attestationToken: null,
      attestChallenge: null,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error('rs-poster: login failed', res.status, body.slice(0, 300));
    return null;
  }
  const data = await res.json();
  const token = data?.authInfo || data?.real_auth_info || data?.token || data?.auth;
  if (!token) {
    console.error('rs-poster: login response missing token', JSON.stringify(data).slice(0, 300));
    return null;
  }
  console.log('rs-poster: logged in successfully');
  return token;
}

async function getAuthToken(env) {
  const cached = await getCachedToken(env.DB);
  if (cached) return cached;
  if (env.RS_AUTH_INFO) return { token: env.RS_AUTH_INFO, deviceUuid: env.RS_DEVICE_UUID };
  const fresh = await login(env);
  if (fresh) await setCachedToken(env.DB, fresh);
  return fresh ? { token: fresh, deviceUuid: env.RS_DEVICE_UUID } : null;
}

function formatPost(pos) {
  const game    = pos.marketDisplay?.display || '';
  const label   = pos.headerLabel || '';
  const outcome = pos.outcomeLabel || '';
  const details = (pos.details || []).reduce((acc, d) => { acc[d.label] = d.display; return acc; }, {});
  const avg  = details['Avg']  || '—';
  const cost = details['Cost'] || '—';
  const pays = details['Pays'] || '—';
  return `New Pick: ${game}\n${label} — ${outcome}\nAvg: ${avg} | Cost: ${cost} | Pays: ${pays}`;
}

async function ensureTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS rs_posted_positions (
      position_id TEXT PRIMARY KEY,
      posted_at   INTEGER NOT NULL
    )
  `).run();
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },
};

async function run(env) {
  if (!env.RS_GROUP_ID) { console.error('rs-poster: RS_GROUP_ID not set'); return; }
  await ensureTable(env.DB);

  // Get auth token — Tampermonkey cache → env secret → login
  let authInfo = await getAuthToken(env);
  if (!authInfo) { console.error('rs-poster: could not obtain auth token'); return; }
  let { token: authToken, deviceUuid } = authInfo;

  // 1. Fetch open positions
  let posRes = await fetch(RS_OPEN_POS, { headers: rsHeaders(authToken, deviceUuid) });

  // RS blocks Cloudflare IPs — posting is handled by Railway (rs-poster-node).
  // Do not clear D1 tokens on 401, sync.js needs them for odds data.
  if (posRes.status === 401) {
    console.log('rs-poster: CF Worker blocked by RS IP filter — Railway handles posting');
    return;
  }

  if (!posRes.ok) {
    const body = await posRes.text();
    console.error('rs-poster: openpositions failed', posRes.status, body.slice(0, 200));
    return;
  }

  const posData = await posRes.json();
  const positions = posData.positions || [];
  if (!positions.length) { console.log('rs-poster: no open positions'); return; }

  // 2. Find which ones we haven't posted yet
  const ids = positions.map(p => p.sharedPositionId).filter(Boolean);
  const placeholders = ids.map(() => '?').join(',');
  const posted = await env.DB.prepare(
    `SELECT position_id FROM rs_posted_positions WHERE position_id IN (${placeholders})`
  ).bind(...ids).all();
  const postedSet = new Set((posted.results || []).map(r => r.position_id));

  const newPositions = positions.filter(p => p.sharedPositionId && !postedSet.has(p.sharedPositionId));
  if (!newPositions.length) { console.log('rs-poster: no new positions'); return; }

  console.log('rs-poster: found', newPositions.length, 'new position(s)');

  // 3. For each new position, get the share URL and post to the group
  for (const pos of newPositions) {
    const posId = pos.sharedPositionId;
    try {
      const detailRes = await fetch(RS_POS_DETAIL(posId), { headers: rsHeaders(authToken, deviceUuid) });
      if (!detailRes.ok) { console.error('rs-poster: position detail failed', posId, detailRes.status); continue; }
      const detail = await detailRes.json();
      const path = detail.position?.marketDisplay?.path;
      if (!path) { console.error('rs-poster: no marketDisplay.path for', posId); continue; }

      const shareUrl = RS_WEB_BASE + path;
      const text = formatPost(pos) + '\n\n' + shareUrl;

      const groupRes = await fetch(RS_GROUP_POST(env.RS_GROUP_ID), {
        method: 'POST',
        headers: rsHeaders(authToken, deviceUuid),
        body: JSON.stringify({ groupId: parseInt(env.RS_GROUP_ID), text, parentCommentId: null }),
      });

      if (groupRes.ok) {
        console.log('rs-poster: posted', posId);
        await env.DB.prepare(
          'INSERT OR IGNORE INTO rs_posted_positions (position_id, posted_at) VALUES (?, ?)'
        ).bind(posId, Math.floor(Date.now() / 1000)).run();
      } else {
        const errText = await groupRes.text();
        console.error('rs-poster: group post failed', posId, groupRes.status, errText);
      }

      if (newPositions.indexOf(pos) < newPositions.length - 1) {
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {
      console.error('rs-poster: error for', posId, e.message);
    }
  }
}
