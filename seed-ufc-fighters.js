#!/usr/bin/env node
// seed-ufc-fighters.js
// Fetches all UFC fighters from RS (season 2023, 20 pages) + their individual earnings,
// then writes everything to D1 odds_cache.
//
// Usage:
//   REAL_AUTH_TOKEN=... REAL_SESSION_TOKEN=... REAL_DEVICE_UUID=... node seed-ufc-fighters.js
//
// Optional: --dry-run  (fetch only, no D1 writes)
//           --skip-existing  (skip fighters already in earnings cache)

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const RS_BASE = 'https://web.realapp.com';
const SPORT = 'ufc';
const ENTITY_TYPE = 'team';
const SEASON = '2023';
const PAGES = 20;
const CONCURRENCY = 8;
const DELAY_MS = 300;

const AUTH_TOKEN = process.env.REAL_AUTH_TOKEN;
const SESSION_TOKEN = process.env.REAL_SESSION_TOKEN;
const DEVICE_UUID = process.env.REAL_DEVICE_UUID || '';
const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_EXISTING = process.argv.includes('--skip-existing');

if (!AUTH_TOKEN || !SESSION_TOKEN) {
  console.error('ERROR: REAL_AUTH_TOKEN and REAL_SESSION_TOKEN env vars required');
  process.exit(1);
}

const HEADERS = {
  'Origin': 'https://www.realapp.com',
  'Referer': 'https://www.realapp.com/',
  'real-auth-info': AUTH_TOKEN,
  'real-session-token': SESSION_TOKEN,
  'real-device-uuid': DEVICE_UUID,
  'real-device-name': '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
  'real-device-type': 'desktop_web',
  'real-version': '35',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithTimeout(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
    clearTimeout(t);
    return res;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

async function runInBatches(items, fn, concurrency, delay) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (i + concurrency < items.length) await sleep(delay);
  }
  return results;
}

function escSql(str) {
  return String(str).replace(/'/g, "''");
}

function d1Execute(sql) {
  const tmpFile = join(tmpdir(), `seed-ufc-${Date.now()}.sql`);
  writeFileSync(tmpFile, sql);
  try {
    execSync(`npx wrangler d1 execute edge-db --remote --file="${tmpFile}"`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: '/Users/mohamadghasham/RaxEdge Project',
    });
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

// ── Phase 1: Fetch all fighters ──────────────────────────────────────────────

console.log(`\n[1/4] Fetching ${PAGES} pages of UFC fighters from RS season ${SEASON}...`);

const pageResults = await runInBatches(
  Array.from({ length: PAGES }, (_, i) => i),
  async (page) => {
    const url = `${RS_BASE}/userpassshop/${SPORT}/season/${SEASON}/entity/${ENTITY_TYPE}/section/earningstotal?before=${page * 20}`;
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) { console.warn(`  page ${page}: HTTP ${res.status}`); return []; }
      const data = await res.json();
      const items = data.items || data.leaderboard || data.players || data.data || [];
      console.log(`  page ${page}: ${items.length} fighters`);
      return items;
    } catch (e) {
      console.warn(`  page ${page}: ${e.message}`);
      return [];
    }
  },
  6,
  200
);

const fighterMap = {};
for (const page of pageResults) {
  for (const item of page) {
    const id = String(item.id || item.entityId || '');
    const name = item.label || item.name || item.displayName || '';
    const value = Number(item.value) || 0;
    if (!id) continue;
    if (!fighterMap[id] || value > (fighterMap[id].value || 0)) {
      fighterMap[id] = { id, name, value };
    }
  }
}

const fighters = Object.values(fighterMap).sort((a, b) => b.value - a.value);
console.log(`\nTotal unique fighters found: ${fighters.length}`);

if (fighters.length === 0) {
  console.error('No fighters returned — check your RS tokens');
  process.exit(1);
}

// ── Phase 2: Check which IDs already have earnings cached ───────────────────

console.log('\n[2/4] Checking existing D1 earnings cache...');

let existingIds = new Set();
try {
  const out = execSync(
    `npx wrangler d1 execute edge-db --remote --command "SELECT cache_key FROM odds_cache WHERE cache_key LIKE 'otd_earnings_v10_team_ufc_2023_%'"`,
    { stdio: ['ignore', 'pipe', 'pipe'], cwd: '/Users/mohamadghasham/RaxEdge Project' }
  ).toString();
  const matches = [...out.matchAll(/"cache_key":\s*"otd_earnings_v10_team_ufc_2023_(\d+)"/g)];
  existingIds = new Set(matches.map(m => m[1]));
  console.log(`  Already cached: ${existingIds.size} fighters`);
} catch (e) {
  console.warn('  Could not query existing cache:', e.message);
}

const toFetch = SKIP_EXISTING
  ? fighters.filter(f => !existingIds.has(f.id))
  : fighters;

console.log(`  Will fetch earnings for: ${toFetch.length} fighters`);

// ── Phase 3: Fetch individual earnings ──────────────────────────────────────

console.log(`\n[3/4] Fetching individual earnings (${CONCURRENCY} concurrent, ${DELAY_MS}ms between batches)...`);

const now = Math.floor(Date.now() / 1000);
const earningsResults = [];

await runInBatches(
  toFetch,
  async (fighter) => {
    const url = `${RS_BASE}/userpassearnings/${SPORT}/season/${SEASON}/entity/${ENTITY_TYPE}/${fighter.id}?level=1`;
    try {
      const res = await fetchWithTimeout(url);
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { return; }
      const earnings = data.earnings || data.events || data.performances || data.playerEarnings || data.earningDays || [];
      const baseTotal = (data.info && typeof data.info.total === 'number') ? data.info.total : null;
      const rawSample = earnings[0] || null;
      const body = JSON.stringify({ ok: true, earnings, baseTotal, rawSample });
      earningsResults.push({ id: fighter.id, name: fighter.name, body, hasEarnings: earnings.length > 0 });
      process.stdout.write(`  [${earningsResults.length}/${toFetch.length}] ${fighter.name || fighter.id}: ${earnings.length} events\r`);
    } catch (e) {
      earningsResults.push({ id: fighter.id, name: fighter.name, body: null, hasEarnings: false });
    }
  },
  CONCURRENCY,
  DELAY_MS
);

console.log(`\n  Done. ${earningsResults.filter(r => r.hasEarnings).length}/${toFetch.length} had earnings data`);

// ── Phase 4: Write to D1 ─────────────────────────────────────────────────────

if (DRY_RUN) {
  console.log('\n[4/4] --dry-run: skipping D1 writes');
  console.log('Sample fighter:', fighters[0]);
  process.exit(0);
}

console.log('\n[4/4] Writing to D1...');

// Build SQL in chunks (D1 has a statement size limit)
const CHUNK_SIZE = 50;

// Write player name rows (permanent cache — fetched_at=9999999999)
const nameRows = fighters.map(f => {
  const data = JSON.stringify({ name: f.name, id: f.id, position: null });
  return `INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES ('otd_player_${SPORT}_${escSql(f.id)}', '${escSql(data)}', 9999999999) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at;`;
});

console.log(`  Writing ${nameRows.length} player name rows...`);
for (let i = 0; i < nameRows.length; i += CHUNK_SIZE) {
  const sql = nameRows.slice(i, i + CHUNK_SIZE).join('\n');
  d1Execute(sql);
  process.stdout.write(`  names: ${Math.min(i + CHUNK_SIZE, nameRows.length)}/${nameRows.length}\r`);
}
console.log(`\n  Player names done.`);

// Write earnings rows (only for fighters that had earnings)
const earningsWithData = earningsResults.filter(r => r.hasEarnings && r.body);
const earningsRows = earningsWithData.map(r => {
  const cacheKey = `otd_earnings_v10_${ENTITY_TYPE}_${SPORT}_${SEASON}_${r.id}`;
  return `INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES ('${escSql(cacheKey)}', '${escSql(r.body)}', ${now}) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at;`;
});

console.log(`  Writing ${earningsRows.length} earnings rows...`);
for (let i = 0; i < earningsRows.length; i += CHUNK_SIZE) {
  const sql = earningsRows.slice(i, i + CHUNK_SIZE).join('\n');
  d1Execute(sql);
  process.stdout.write(`  earnings: ${Math.min(i + CHUNK_SIZE, earningsRows.length)}/${earningsRows.length}\r`);
}
console.log(`\n  Earnings done.`);

console.log(`
Done!
  Fighters found:     ${fighters.length}
  Names written:      ${nameRows.length}
  Earnings written:   ${earningsRows.length}
  No earnings found:  ${toFetch.length - earningsWithData.length}
`);
