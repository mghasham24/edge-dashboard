// rs-poster-node/index.js
// Polls RS open positions every minute and posts new ones to the RS group.
//
// Required env vars:
//   RS_AUTH_INFO  — real-auth-info token (format: userId!deviceId!token)
//   RS_GROUP_ID   — numeric RS group ID
// Optional:
//   RS_DEVICE_UUID — device UUID (defaults to the one stored in RS localStorage)

import { CronJob } from 'cron';

const RS_GROUP_ID  = process.env.RS_GROUP_ID;
const RS_AUTH_INFO = process.env.RS_AUTH_INFO;
const DEVICE_UUID  = process.env.RS_DEVICE_UUID || '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';
const RS_BASE      = 'https://web.realapp.com';
const RS_WEB_BASE  = 'https://www.realapp.com';

const postedIds = new Set();
let _running = false;

function rsHeaders() {
  return {
    'Content-Type':       'application/json',
    'Accept':             'application/json',
    'Accept-Language':    'en-US,en;q=0.9',
    'Origin':             RS_WEB_BASE,
    'Referer':            RS_WEB_BASE + '/',
    'User-Agent':         'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-device-uuid':   DEVICE_UUID,
    'real-device-name':   '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-device-type':   'desktop_web',
    'real-version':       '31',
    'real-request-token': Math.random().toString(36).slice(2, 18),
    'real-auth-info':     RS_AUTH_INFO,
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

        const groupRes = await fetch(RS_BASE + '/comments/groups/' + RS_GROUP_ID, {
          method:  'POST',
          headers: rsHeaders(),
          body:    JSON.stringify({ groupId: parseInt(RS_GROUP_ID), text, parentCommentId: null }),
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

if (!RS_GROUP_ID)  { console.error('rs-poster: RS_GROUP_ID not set');  process.exit(1); }
if (!RS_AUTH_INFO) { console.error('rs-poster: RS_AUTH_INFO not set'); process.exit(1); }

console.log('rs-poster: starting, group', RS_GROUP_ID);
run();
new CronJob('* * * * *', run, null, true, 'America/Chicago');
