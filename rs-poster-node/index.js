// rs-poster-node/index.js
// Runs every minute on Hetzner via Coolify. Polls RS open positions and posts new ones to the RS group.
// Authenticates with RS_LOGIN + RS_PASSWORD on startup; refreshes token automatically on 401.
//
// Required env vars:
//   RS_LOGIN      — RS email / phone
//   RS_PASSWORD   — RS password
//   RS_GROUP_ID   — numeric RS group ID
// Optional:
//   RS_DEVICE_UUID — device UUID (stable across restarts)

import { CronJob } from 'cron';

const RS_GROUP_ID   = process.env.RS_GROUP_ID;
const RS_BASE       = 'https://web.realapp.com';
const RS_LOGIN_URL  = RS_BASE + '/login';
const RS_OPEN_POS   = RS_BASE + '/predictions/openpositions';
const RS_POS_DETAIL = (id) => RS_BASE + '/predictions/position/' + id;
const RS_GROUP_POST = (groupId) => RS_BASE + '/comments/groups/' + groupId;
const DEVICE_UUID   = process.env.RS_DEVICE_UUID || '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';

// In-memory set — good enough since restarts are rare and worst case is a double-post
const postedIds = new Set();

// In-memory auth token cache
let _token = '';
let _tokenFetchedAt = 0;
const TOKEN_TTL = 55 * 60; // re-login after 55 minutes

function rsHeaders(token) {
  return {
    'Content-Type':       'application/json',
    'Accept':             'application/json',
    'Accept-Language':    'en-US,en;q=0.9',
    'Accept-Encoding':    'gzip, deflate, br',
    'Cache-Control':      'max-age=0',
    'Origin':             'https://www.realapp.com',
    'Referer':            'https://www.realapp.com/',
    'User-Agent':         'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'Sec-Fetch-Site':     'same-site',
    'Sec-Fetch-Mode':     'cors',
    'Sec-Fetch-Dest':     'empty',
    'real-device-uuid':   DEVICE_UUID,
    'real-device-name':   '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-device-type':   'desktop_web',
    'real-version':       '31',
    'real-request-token': Math.random().toString(36).slice(2, 18),
    'real-auth-info':     token,
  };
}

async function login() {
  const login    = process.env.RS_LOGIN;
  const password = process.env.RS_PASSWORD;
  if (!login || !password) { console.error('rs-poster: RS_LOGIN or RS_PASSWORD not set'); return null; }

  console.log('rs-poster: logging in as', login);
  const res = await fetch(RS_LOGIN_URL, {
    method:  'POST',
    headers: {
      'Content-Type':       'application/json',
      'Accept':             'application/json',
      'Accept-Language':    'en-US,en;q=0.9',
      'Origin':             'https://www.realapp.com',
      'Referer':            'https://www.realapp.com/',
      'User-Agent':         'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
      'real-device-uuid':   DEVICE_UUID,
      'real-device-name':   '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
      'real-device-type':   'desktop_web',
      'real-version':       '31',
      'real-request-token': Math.random().toString(36).slice(2, 18),
    },
    body: JSON.stringify({ login, password, tfaAuthCode: '', attestationToken: null, attestChallenge: null }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('rs-poster: login failed', res.status, body.slice(0, 300));
    return null;
  }

  const data  = await res.json();
  const token = data?.authInfo || data?.real_auth_info || data?.token || data?.auth;
  if (!token) { console.error('rs-poster: login response missing token', JSON.stringify(data).slice(0, 300)); return null; }

  console.log('rs-poster: logged in, token len', token.length);
  _token = token;
  _tokenFetchedAt = Math.floor(Date.now() / 1000);
  return token;
}

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_token && (now - _tokenFetchedAt) < TOKEN_TTL) return _token;
  return login();
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

async function run() {
  try {
    let token = await getToken();
    if (!token) { console.error('rs-poster: could not obtain auth token'); return; }

    let posRes = await fetch(RS_OPEN_POS, { headers: rsHeaders(token) });

    // On 401, try re-login once
    if (posRes.status === 401) {
      console.log('rs-poster: 401 on openpositions — re-logging in');
      _token = '';
      token = await login();
      if (!token) { console.error('rs-poster: re-login failed'); return; }
      posRes = await fetch(RS_OPEN_POS, { headers: rsHeaders(token) });
    }

    if (!posRes.ok) {
      const body = await posRes.text();
      console.error('rs-poster: openpositions failed', posRes.status, body.slice(0, 200));
      return;
    }

    const positions = (await posRes.json()).positions || [];
    if (!positions.length) { console.log('rs-poster: no open positions'); return; }

    const newPositions = positions.filter(p => p.sharedPositionId && !postedIds.has(p.sharedPositionId));
    if (!newPositions.length) { console.log('rs-poster: no new positions'); return; }

    console.log('rs-poster: found', newPositions.length, 'new position(s)');

    for (let i = 0; i < newPositions.length; i++) {
      const pos   = newPositions[i];
      const posId = pos.sharedPositionId;
      try {
        const detailRes = await fetch(RS_POS_DETAIL(posId), { headers: rsHeaders(token) });
        const detail    = detailRes.ok ? await detailRes.json() : {};
        const path      = detail.position?.marketDisplay?.path;
        const shareUrl  = path ? 'https://www.realapp.com' + path : '';
        const text      = formatPost(pos) + (shareUrl ? '\n\n' + shareUrl : '');

        const groupRes = await fetch(RS_GROUP_POST(RS_GROUP_ID), {
          method:  'POST',
          headers: rsHeaders(token),
          body:    JSON.stringify({ groupId: parseInt(RS_GROUP_ID), text, parentCommentId: null }),
        });

        if (groupRes.ok) {
          console.log('rs-poster: posted', posId);
          postedIds.add(posId);
        } else {
          const err = await groupRes.text();
          console.error('rs-poster: group post failed', posId, groupRes.status, err.slice(0, 200));
        }

        if (i < newPositions.length - 1) await new Promise(r => setTimeout(r, 1000));
      } catch (e) {
        console.error('rs-poster: error for', posId, e.message);
      }
    }
  } catch (e) {
    console.error('rs-poster: run error', e.message);
  }
}

if (!RS_GROUP_ID) { console.error('rs-poster: RS_GROUP_ID not set'); process.exit(1); }

console.log('rs-poster: starting, group', RS_GROUP_ID);
run();
new CronJob('* * * * *', run, null, true, 'America/Chicago');
