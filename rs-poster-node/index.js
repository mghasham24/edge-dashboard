// rs-poster-node/index.js
// Polls RS open positions every minute and posts new ones to the RS group.
//
// Required env vars:
//   RS_AUTH_INFO  — initial real-auth-info token (format: userId!deviceId!token)
//   RS_GROUP_ID   — numeric RS group ID
// Optional:
//   RS_DEVICE_UUID — device UUID
//   TOKEN_PORT     — port for Tampermonkey token refresh bridge (default 27182)
//
// Token refresh: Tampermonkey pushes fresh tokens to POST /token on TOKEN_PORT.
// RS tokens expire every 1-3 minutes; the browser keeps them live automatically.

import { CronJob } from 'cron';
import { createServer } from 'http';

const RS_GROUP_ID  = process.env.RS_GROUP_ID;
const DEVICE_UUID  = process.env.RS_DEVICE_UUID || '2e0a38e2-0ee8-4f93-9a34-218ac1d10161';
const RS_BASE      = 'https://web.realapp.com';
const RS_WEB_BASE  = 'https://www.realsports.io';
const TOKEN_PORT   = parseInt(process.env.TOKEN_PORT || '27182');

// Live auth token — updated by Tampermonkey bridge
let currentAuthInfo = process.env.RS_AUTH_INFO || '';
let tokenUpdatedAt  = Date.now();

// Token refresh server — Tampermonkey POSTs { token: "userId!deviceId!token" } here
const tokenServer = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/token') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const { token } = JSON.parse(body);
        if (token && typeof token === 'string' && token.split('!').length === 3) {
          currentAuthInfo = token;
          tokenUpdatedAt  = Date.now();
          console.log('rs-poster: token refreshed via bridge, age reset');
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400); res.end('bad token format');
        }
      } catch(e) { res.writeHead(400); res.end('bad json'); }
    });
  } else if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
  } else if (req.method === 'GET' && req.url === '/status') {
    const ageSec = Math.floor((Date.now() - tokenUpdatedAt) / 1000);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, tokenAge: ageSec, hasToken: !!currentAuthInfo, token: currentAuthInfo }));
  } else {
    res.writeHead(404); res.end();
  }
});
tokenServer.listen(TOKEN_PORT, '127.0.0.1', () => {
  console.log('rs-poster: token bridge listening on localhost:' + TOKEN_PORT);
});

const postedIds = new Set();
let _running = false;

function rsHeaders() {
  return {
    'Accept':             'application/json',
    'Accept-Language':    'en-US,en;q=0.9',
    'Accept-Encoding':    'gzip, deflate, br',
    'Cache-Control':      'max-age=0',
    'Content-Type':       'application/json',
    'Origin':             RS_WEB_BASE,
    'Referer':            RS_WEB_BASE + '/',
    'Sec-Fetch-Dest':     'empty',
    'Sec-Fetch-Mode':     'cors',
    'Sec-Fetch-Site':     'cross-site',
    'User-Agent':         'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-device-uuid':   DEVICE_UUID,
    'real-device-name':   '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-device-type':   'desktop_web',
    'real-version':       '31',
    'real-request-token': Math.random().toString(36).slice(2, 18),
    'real-auth-info':     currentAuthInfo,
  };
}

function formatPost(pos) {
  const game    = pos.marketDisplay?.display || '';
  const label   = pos.headerLabel  || '';
  const outcome = pos.outcomeLabel || '';
  const details = (pos.details || []).reduce((acc, d) => { acc[d.label] = d.display; return acc; }, {});
  const avg  = details['Avg']  || '—';
  const cost = details['Cost'] || '—';
  const pays = details['Pays'] || '—';
  return `New Pick: ${game}\n${label} — ${outcome}\nAvg: ${avg} | Cost: ${cost} | Pays: ${pays}`;
}

async function run() {
  if (_running) { console.log('rs-poster: previous run still in progress, skipping'); return; }
  if (!currentAuthInfo) { console.error('rs-poster: no auth token'); return; }

  const tokenAgeSec = Math.floor((Date.now() - tokenUpdatedAt) / 1000);
  if (tokenAgeSec > 90) {
    console.warn('rs-poster: token is', tokenAgeSec + 's old — Tampermonkey bridge may be disconnected');
  }

  _running = true;
  try {
    const posRes = await fetch(RS_BASE + '/predictions/openpositions', { headers: rsHeaders() });
    if (!posRes.ok) {
      console.error('rs-poster: openpositions failed', posRes.status, (await posRes.text()).slice(0, 200));
      return;
    }

    const positions    = (await posRes.json()).positions || [];
    const newPositions = positions.filter(p => p.sharedPositionId && !postedIds.has(p.sharedPositionId));

    if (!positions.length)    { console.log('rs-poster: no open positions'); return; }
    if (!newPositions.length) { console.log('rs-poster: no new positions'); return; }

    console.log('rs-poster: found', newPositions.length, 'new position(s)');

    for (let i = 0; i < newPositions.length; i++) {
      const pos   = newPositions[i];
      const posId = pos.sharedPositionId;
      try {
        const detailRes = await fetch(RS_BASE + '/predictions/position/' + posId, { headers: rsHeaders() });
        const detail    = detailRes.ok ? await detailRes.json() : {};
        const path      = detail.position?.marketDisplay?.path;
        const shareUrl  = path ? RS_WEB_BASE + path : '';
        const text      = formatPost(pos) + (shareUrl ? '\n\n' + shareUrl : '');

        const groupRes = await fetch(RS_BASE + '/groups/' + RS_GROUP_ID + '/posts', {
          method:  'POST',
          headers: rsHeaders(),
          body:    JSON.stringify({ content: { nodes: [{ type: 'Paragraph', children: [{ text, type: 'Text' }] }] } }),
        });

        if (groupRes.ok) {
          console.log('rs-poster: posted', posId);
          postedIds.add(posId);
        } else {
          console.error('rs-poster: group post failed', posId, groupRes.status, (await groupRes.text()).slice(0, 200));
        }

        if (i < newPositions.length - 1) await new Promise(r => setTimeout(r, 1000));
      } catch (e) {
        console.error('rs-poster: error for', posId, e.message);
      }
    }
  } catch (e) {
    console.error('rs-poster: run error', e.message);
  } finally {
    _running = false;
  }
}

if (!RS_GROUP_ID) { console.error('rs-poster: RS_GROUP_ID not set'); process.exit(1); }

console.log('rs-poster: starting, group', RS_GROUP_ID);
run();
new CronJob('* * * * *', run, null, true, 'America/Chicago');
