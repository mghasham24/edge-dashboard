// rs-poster-node/index.js
// Polls RS open positions every minute and posts new ones to the RS group.
// Uses Playwright (headless Chrome) so RS sees a real browser TLS fingerprint.
// RS_AUTH_INFO token is long-lived — set once, never expires.
//
// Required env vars:
//   RS_AUTH_INFO  — real-auth-info token from browser DevTools (long-lived)
//   RS_GROUP_ID   — numeric RS group ID
// Optional:
//   RS_DEVICE_UUID — device UUID matching the token

import { chromium } from 'playwright';
import { CronJob } from 'cron';

const RS_GROUP_ID = process.env.RS_GROUP_ID;
const RS_BASE     = 'https://web.realapp.com';
const RS_WEB_BASE = 'https://www.realapp.com';
const AUTH_TOKEN  = process.env.RS_AUTH_INFO || '';
const DEVICE_UUID = process.env.RS_DEVICE_UUID || '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';

const postedIds = new Set();
let _browser = null;
let _page    = null;

async function ensureBrowser() {
  if (_browser && _browser.isConnected() && _page && !_page.isClosed()) return;
  if (_browser) { try { await _browser.close(); } catch {} }
  console.log('rs-poster: launching headless Chrome');
  _browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await _browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
  });
  _page = await ctx.newPage();
  // Navigate to realapp.com so the page is on the right origin for CORS + session cookies
  await _page.goto(RS_WEB_BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('rs-poster: browser ready at', RS_WEB_BASE);
}

// All RS API calls run inside the actual Chrome process — real browser TLS fingerprint
async function rsFetch(method, url, body, token, deviceUuid) {
  return _page.evaluate(async ({ method, url, body, token, deviceUuid }) => {
    const headers = {
      'Content-Type':       'application/json',
      'Accept':             'application/json',
      'Accept-Language':    'en-US,en;q=0.9',
      'Origin':             'https://www.realapp.com',
      'Referer':            'https://www.realapp.com/',
      'real-device-uuid':   deviceUuid,
      'real-device-name':   '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
      'real-device-type':   'desktop_web',
      'real-version':       '31',
      'real-request-token': Math.random().toString(36).slice(2, 18),
      'real-auth-info':     token,
    };
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res  = await fetch(url, opts);
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text };
  }, { method, url, body, token, deviceUuid });
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
    await ensureBrowser();

    const posResult = await rsFetch('GET', RS_BASE + '/predictions/openpositions', null, AUTH_TOKEN, DEVICE_UUID);
    if (!posResult.ok) {
      console.error('rs-poster: openpositions failed', posResult.status, posResult.body.slice(0, 200));
      if (posResult.status === 401 || posResult.status === 403) {
        _page = null;
        try { await _browser.close(); } catch {}
        _browser = null;
      }
      return;
    }

    const positions = JSON.parse(posResult.body).positions || [];
    if (!positions.length) { console.log('rs-poster: no open positions'); return; }

    const newPositions = positions.filter(p => p.sharedPositionId && !postedIds.has(p.sharedPositionId));
    if (!newPositions.length) { console.log('rs-poster: no new positions'); return; }

    console.log('rs-poster: found', newPositions.length, 'new position(s)');

    for (let i = 0; i < newPositions.length; i++) {
      const pos   = newPositions[i];
      const posId = pos.sharedPositionId;
      try {
        const detailResult = await rsFetch('GET', RS_BASE + '/predictions/position/' + posId, null, AUTH_TOKEN, DEVICE_UUID);
        const detail       = detailResult.ok ? JSON.parse(detailResult.body) : {};
        const path         = detail.position?.marketDisplay?.path;
        const shareUrl     = path ? RS_WEB_BASE + path : '';
        const text         = formatPost(pos) + (shareUrl ? '\n\n' + shareUrl : '');

        const groupResult = await rsFetch('POST', RS_BASE + '/comments/groups/' + RS_GROUP_ID, {
          groupId: parseInt(RS_GROUP_ID), text, parentCommentId: null,
        }, AUTH_TOKEN, DEVICE_UUID);

        if (groupResult.ok) {
          console.log('rs-poster: posted', posId);
          postedIds.add(posId);
        } else {
          console.error('rs-poster: group post failed', posId, groupResult.status, groupResult.body.slice(0, 200));
        }

        if (i < newPositions.length - 1) await new Promise(r => setTimeout(r, 1000));
      } catch (e) {
        console.error('rs-poster: error for', posId, e.message);
      }
    }
  } catch (e) {
    console.error('rs-poster: run error', e.message);
    _page = null;
    if (_browser) { try { await _browser.close(); } catch {} _browser = null; }
  }
}

if (!RS_GROUP_ID) { console.error('rs-poster: RS_GROUP_ID not set');  process.exit(1); }
if (!AUTH_TOKEN)  { console.error('rs-poster: RS_AUTH_INFO not set'); process.exit(1); }

console.log('rs-poster: starting, group', RS_GROUP_ID);
run();
new CronJob('* * * * *', run, null, true, 'America/Chicago');
