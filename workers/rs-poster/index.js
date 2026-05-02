// workers/rs-poster/index.js
// Polls RS open positions every 5 minutes and posts new ones to the RS group.
//
// Secrets required (Cloudflare dashboard → Workers → rs-poster → Settings → Variables):
//   RS_AUTH_INFO   — real-auth-info header value from your RS session
//   RS_GROUP_ID    — numeric group ID of your RaxEdge Predictions RS group

const RS_BASE        = 'https://web.realapp.com';
const RS_WEB_BASE    = 'https://www.realapp.com';
const RS_OPEN_POS    = RS_BASE + '/predictions/openpositions';
const RS_POS_DETAIL  = (id) => RS_BASE + '/predictions/position/' + id;
const RS_GROUP_POST  = (groupId) => RS_BASE + '/comments/groups/' + groupId;

function rsHeaders(env) {
  return {
    'Content-Type':       'application/json',
    'Accept':             'application/json',
    'Accept-Language':    'en-US,en;q=0.9',
    'Origin':             'https://www.realapp.com',
    'Referer':            'https://www.realapp.com/',
    'User-Agent':         'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-device-uuid':   env.RS_DEVICE_UUID || '2e0a38e2-0ee8-4f93-9a34-218ac1d10161',
    'real-device-name':   '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-device-type':   'desktop_web',
    'real-version':       '31',
    'real-request-token': Math.random().toString(36).slice(2, 18),
    'real-auth-info':     env.RS_AUTH_INFO,
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
  if (!env.RS_AUTH_INFO) { console.error('rs-poster: RS_AUTH_INFO not set'); return; }
  if (!env.RS_GROUP_ID)  { console.error('rs-poster: RS_GROUP_ID not set');  return; }

  await ensureTable(env.DB);

  // 1. Fetch open positions
  const posRes = await fetch(RS_OPEN_POS, { headers: rsHeaders(env) });
  if (!posRes.ok) { console.error('rs-poster: openpositions failed', posRes.status); return; }
  const posData = await posRes.json();
  const positions = posData.positions || [];
  if (!positions.length) return;

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
      // Fetch individual position to get marketDisplay.path
      const detailRes = await fetch(RS_POS_DETAIL(posId), { headers: rsHeaders(env) });
      if (!detailRes.ok) { console.error('rs-poster: position detail failed', posId, detailRes.status); continue; }
      const detail = await detailRes.json();
      const path = detail.position?.marketDisplay?.path;
      if (!path) { console.error('rs-poster: no marketDisplay.path for', posId); continue; }

      const shareUrl = RS_WEB_BASE + path;
      const text = formatPost(pos) + '\n\n' + shareUrl;

      // Post to RS group
      const groupRes = await fetch(RS_GROUP_POST(env.RS_GROUP_ID), {
        method: 'POST',
        headers: rsHeaders(env),
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

      // Small delay between posts to avoid rate limiting
      if (newPositions.indexOf(pos) < newPositions.length - 1) {
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {
      console.error('rs-poster: error for', posId, e.message);
    }
  }
}
