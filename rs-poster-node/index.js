// rs-poster-node/index.js
// Runs every minute on Railway. Polls RS open positions and posts new ones to the RS group.
// RS auth token is fetched from RaxEdge D1 (pushed there by Tampermonkey).
//
// Required env vars:
//   RS_TOKEN_SECRET  — matches RaxEdge RS_TOKEN_SECRET
//   RS_GROUP_ID      — numeric RS group ID
//   RAXEDGE_URL      — e.g. https://raxedge.com

import { CronJob } from 'cron';

const RAXEDGE_URL    = process.env.RAXEDGE_URL || 'https://raxedge.com';
const TOKEN_ENDPOINT = `${RAXEDGE_URL}/api/admin/rs-token?key=${process.env.RS_TOKEN_SECRET}`;
const RS_GROUP_ID    = process.env.RS_GROUP_ID;
const RS_BASE        = 'https://web.realapp.com';
const RS_OPEN_POS    = RS_BASE + '/predictions/openpositions';
const RS_POS_DETAIL  = (id) => RS_BASE + '/predictions/position/' + id;
const RS_GROUP_POST  = (groupId) => RS_BASE + '/comments/groups/' + groupId;

// In-memory set — good enough since restarts are rare and worst case is a double-post
const postedIds = new Set();

function rsHeaders(token, deviceUuid) {
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
    'real-auth-info':     token,
  };
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
    const tokenRes = await fetch(TOKEN_ENDPOINT);
    if (!tokenRes.ok) { console.log('rs-poster: no token in D1'); return; }
    const { token, deviceUuid } = await tokenRes.json();
    if (!token) { console.log('rs-poster: empty token'); return; }

    const posRes = await fetch(RS_OPEN_POS, { headers: rsHeaders(token, deviceUuid) });
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
        const detailRes = await fetch(RS_POS_DETAIL(posId), { headers: rsHeaders(token, deviceUuid) });
        const detail    = detailRes.ok ? await detailRes.json() : {};
        const path      = detail.position?.marketDisplay?.path;
        const shareUrl  = path ? 'https://www.realapp.com' + path : '';
        const text      = formatPost(pos) + (shareUrl ? '\n\n' + shareUrl : '');

        const groupRes = await fetch(RS_GROUP_POST(RS_GROUP_ID), {
          method:  'POST',
          headers: rsHeaders(token, deviceUuid),
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
