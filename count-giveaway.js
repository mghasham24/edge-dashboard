#!/usr/bin/env node
// Usage: node count-giveaway.js <postId> "<real-auth-info>"
// Get real-auth-info from Network tab on realsports.io → any request to web.realapp.com

const postId  = process.argv[2];
const authInfo = process.argv[3];

if (!postId || !authInfo) {
  console.error('Usage: node count-giveaway.js <postId> "<real-auth-info>"');
  console.error('Example: node count-giveaway.js 178201444196300001 "DJ4YAdpv!1EyeKOpE!cf77c5d0..."');
  process.exit(1);
}

const GROUP_ID = '60099';
const RS_BASE  = 'https://web.realapp.com';
const LIMIT    = 100;

const HEADERS = {
  'Accept':             'application/json',
  'Content-Type':       'application/json',
  'Origin':             'https://realsports.io',
  'Referer':            'https://realsports.io/',
  'User-Agent':         'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15',
  'real-auth-info':     authInfo,
  'real-device-uuid':   '2e0a38e2-0ee8-4f93-9a34-218ac1d10161',
  'real-device-name':   '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15',
  'real-device-type':   'desktop_web',
  'real-version':       '34',
};

async function fetchAllComments() {
  const comments = [];
  let cursor = null;
  let page   = 0;

  while (true) {
    page++;
    const params = new URLSearchParams({ limit: LIMIT });
    if (cursor) params.set('cursor', cursor);
    const url = `${RS_BASE}/comments/groups/${GROUP_ID}/replies/${postId}?${params}`;

    const res = await fetch(url, {
      headers: { ...HEADERS, 'real-request-token': Math.random().toString(36).slice(2, 18) }
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`RS ${res.status}: ${body}`);
    }

    const data = await res.json();
    const batch = data.comments || [];
    if (!batch.length) break;

    comments.push(...batch);
    process.stdout.write(`\rPage ${page}: ${comments.length} comments fetched...`);

    cursor = data.cursor || data.nextCursor || data.next || null;
    if (!cursor || batch.length < LIMIT) break;
  }

  console.log('');
  return comments;
}

function buildLeaderboard(comments) {
  const seen   = new Set();
  const tally  = {};

  const sorted = [...comments].sort((a, b) =>
    new Date(a.createdAt) - new Date(b.createdAt)
  );

  for (const c of sorted) {
    const commenter = c.user?.userName || c.userId;
    if (!commenter || seen.has(commenter)) continue;
    seen.add(commenter);

    // Only count direct replies to the giveaway post, not replies-to-replies
    if (c.replyingToCommentId !== c.parentCommentId) continue;

    // Referrer = @mentioned user in their reply (replyingToUserName is always moe_)
    let referrer = null;
    for (const node of (c.content?.nodes || [])) {
      for (const child of (node.children || [])) {
        if (child.type === 'Mention' && child.mentionType === 'user' && child.name) {
          referrer = child.name; break;
        }
      }
      if (referrer) break;
    }
    if (!referrer && c.plainText) {
      const m = c.plainText.match(/@([\w.]+)/);
      if (m) referrer = m[1];
    }
    if (!referrer) continue;

    tally[referrer] = (tally[referrer] || 0) + 1;
  }

  return Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count], i) => ({ rank: i + 1, name, count }));
}

(async () => {
  console.log(`Fetching comments for post ${postId} in group ${GROUP_ID}...`);
  try {
    const comments  = await fetchAllComments();
    const board     = buildLeaderboard(comments);
    const unique    = new Set(comments.map(c => c.user?.userName || c.userId)).size;

    console.log(`\n=== GIVEAWAY LEADERBOARD ===`);
    console.log(`${unique} unique entries · ${comments.length} total comments\n`);

    const medals = ['🥇', '🥈', '🥉'];
    for (const r of board) {
      const medal = medals[r.rank - 1] || `#${r.rank}`;
      console.log(`${medal}  @${r.name.padEnd(24)} ${r.count} referral${r.count !== 1 ? 's' : ''}`);
    }
  } catch(e) {
    console.error('\nError:', e.message);
    if (e.message.includes('401')) {
      console.error('Token expired — grab a fresh real-auth-info from Network tab on realsports.io');
    }
  }
})();
