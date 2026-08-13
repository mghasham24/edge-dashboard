#!/usr/bin/env node
// seed-cfb-players.js
// Fetches all CFB (ncaaf) player IDs + names across seasons 2022-2025 and writes to D1.
// Run this first before seeding earnings.
//
// Usage:
//   REAL_AUTH_TOKEN=... REAL_SESSION_TOKEN=... node seed-cfb-players.js
//
// Optional: --dry-run  (fetch only, no D1 writes)

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const RS_BASE = 'https://web.realapp.com';
const SPORT = 'ncaaf';
const ENTITY_TYPE = 'player';
const SEASONS = [2025, 2024, 2023, 2022]; // 25-26, 24-25, 23-24, 22-23
const PAGES_PER_SEASON = 400; // ~8000 players per season max (actual end ~page 385)
const CONCURRENCY = 3;
const DELAY_MS = 600;
const SEASON_PAUSE_MS = 12000; // pause between seasons to avoid 429s

const AUTH_TOKEN = process.env.REAL_AUTH_TOKEN;
const DRY_RUN = process.argv.includes('--dry-run');
const WRITE_ONLY = process.argv.includes('--write-only');
const CACHE_FILE = join('/tmp', 'cfb-players-cache.json');

if (!AUTH_TOKEN && !WRITE_ONLY) {
  console.error('ERROR: REAL_AUTH_TOKEN env var required (or use --write-only to skip fetch)');
  process.exit(1);
}

const SESSION_TOKEN = process.env.REAL_SESSION_TOKEN || '';
const DEVICE_UUID = process.env.REAL_DEVICE_UUID || '';

// Inline hashidsEncode for real-request-token (salt='realwebapp', minLen=16)
function hashidsEncode(number) {
  const saltChars = Array.from('realwebapp');
  const minLen = 16;
  const keepUnique = c => [...new Set(c)];
  const without = (c, x) => c.filter(ch => !x.includes(ch));
  const only = (c, k) => c.filter(ch => k.includes(ch));
  function shuffle(alpha, salt) {
    if (!salt.length) return alpha;
    let int, t = [...alpha];
    for (let i = t.length-1, v=0, p=0; i>0; i--, v++) {
      v %= salt.length; p += int = salt[v].codePointAt(0);
      const j = (int+v+p) % i; [t[i],t[j]] = [t[j],t[i]];
    }
    return t;
  }
  function toAlpha(n, alpha) {
    const id=[]; let v=n;
    do { id.unshift(alpha[v%alpha.length]); v=Math.floor(v/alpha.length); } while(v>0);
    return id;
  }
  let alpha = Array.from('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890');
  let seps  = Array.from('cfhistuCFHISTU');
  const uniq = keepUnique(alpha);
  alpha = without(uniq, seps);
  seps  = shuffle(only(seps, uniq), saltChars);
  if (!seps.length || alpha.length/seps.length > 3.5) {
    const sl = Math.ceil(alpha.length/3.5);
    if (sl > seps.length) { seps.push(...alpha.slice(0,sl-seps.length)); alpha=alpha.slice(sl-seps.length); }
  }
  alpha = shuffle(alpha, saltChars);
  const gc = Math.ceil(alpha.length/12);
  let guards;
  if (alpha.length < 3) { guards=seps.slice(0,gc); seps=seps.slice(gc); }
  else { guards=alpha.slice(0,gc); alpha=alpha.slice(gc); }
  const numId = number % 100;
  let ret = [alpha[numId % alpha.length]];
  const lottery = [...ret];
  alpha = shuffle(alpha, lottery.concat(saltChars, alpha));
  ret.push(...toAlpha(number, alpha));
  if (ret.length < minLen) ret.unshift(guards[(numId+ret[0].codePointAt(0)) % guards.length]);
  if (ret.length < minLen) ret.push(guards[(numId+ret[2].codePointAt(0)) % guards.length]);
  const half = Math.floor(alpha.length/2);
  while (ret.length < minLen) {
    alpha = shuffle(alpha, alpha);
    ret.unshift(...alpha.slice(half)); ret.push(...alpha.slice(0,half));
    const ex = ret.length-minLen;
    if (ex>0) ret=ret.slice(ex/2, ex/2+minLen);
  }
  return ret.join('');
}

function buildHeaders() {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': 'https://www.realapp.com',
    'Referer': 'https://www.realapp.com/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
    'real-auth-info': AUTH_TOKEN,
    'real-session-token': SESSION_TOKEN,
    'real-device-uuid': DEVICE_UUID,
    'real-device-name': '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
    'real-device-type': 'desktop_web',
    'real-version': '35',
    'real-request-token': hashidsEncode(Date.now()),
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithTimeout(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: buildHeaders(), signal: ctrl.signal });
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
  const tmpFile = join(tmpdir(), `seed-cfb-${Date.now()}.sql`);
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

// ── Fetch all players across all seasons (or load from cache) ────────────────

const playerMap = {}; // id → { id, name, position, seasons: Set }

if (WRITE_ONLY || existsSync(CACHE_FILE)) {
  const cached = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  for (const p of cached) {
    playerMap[p.id] = { id: p.id, name: p.name, position: p.position, seasons: new Set(p.seasons) };
  }
  console.log(`Loaded ${Object.keys(playerMap).length} players from cache: ${CACHE_FILE}`);
}

if (!WRITE_ONLY) for (let si = 0; si < SEASONS.length; si++) {
  const season = SEASONS[si];
  const displaySeason = `${String(season).slice(2)}-${String(season + 1).slice(2)}`;
  console.log(`\n[Season ${displaySeason}] Fetching up to ${PAGES_PER_SEASON} pages...`);

  if (si > 0) {
    console.log(`  Pausing ${SEASON_PAUSE_MS / 1000}s before next season...`);
    await sleep(SEASON_PAUSE_MS);
  }

  let seasonCount = 0;
  let consecutiveEmpty = 0;

  for (let batchStart = 0; batchStart < PAGES_PER_SEASON; batchStart += CONCURRENCY) {
    if (consecutiveEmpty >= CONCURRENCY) break; // stop if last full batch was all empty
    const batch = Array.from({ length: Math.min(CONCURRENCY, PAGES_PER_SEASON - batchStart) }, (_, i) => batchStart + i);
    const batchResults = await Promise.all(batch.map(async (page) => {
      const url = `${RS_BASE}/userpassshop/${SPORT}/season/${season}/entity/${ENTITY_TYPE}/section/earningstotal?before=${page * 20}`;
      try {
        const res = await fetchWithTimeout(url);
        if (!res.ok) { process.stdout.write(`  [${displaySeason}] page ${page}: HTTP ${res.status}\n`); return 0; }
        const data = await res.json();
        const items = data.items || data.leaderboard || data.players || data.data || [];
        for (const item of items) {
          const id = String(item.id || item.entityId || '');
          const name = item.label || item.name || item.displayName || '';
          const position = item.position || item.entityPosition || item.positionLabel || null;
          if (!id) continue;
          if (!playerMap[id]) playerMap[id] = { id, name, position, seasons: new Set() };
          playerMap[id].seasons.add(season);
          seasonCount++;
        }
        process.stdout.write(`  [${displaySeason}] page ${page}: ${items.length} players\r`);
        return items.length;
      } catch (e) {
        process.stdout.write(`  [${displaySeason}] page ${page}: ${e.message}\n`);
        return 0;
      }
    }));
    consecutiveEmpty = batchResults.every(n => n === 0) ? consecutiveEmpty + CONCURRENCY : 0;
    if (batchStart + CONCURRENCY < PAGES_PER_SEASON) await sleep(DELAY_MS);
  }

  console.log(`\n  Season ${displaySeason} done. Found ${seasonCount} entries.`);
} // end if (!WRITE_ONLY)

const players = Object.values(playerMap);
console.log(`\nTotal unique players across all seasons: ${players.length}`);

if (players.length === 0) {
  console.error('No players returned — check your RS tokens');
  process.exit(1);
}

// Save to cache so we can retry writes without re-fetching
if (!WRITE_ONLY) {
  writeFileSync(CACHE_FILE, JSON.stringify(players.map(p => ({ id: p.id, name: p.name, position: p.position, seasons: [...p.seasons] }))));
  console.log(`Saved player cache to ${CACHE_FILE}`);
}

// Print sample
console.log('\nSample players:');
players.slice(0, 5).forEach(p => {
  console.log(`  ${p.id}  ${p.name}  pos=${p.position}  seasons=[${[...p.seasons].join(',')}]`);
});

if (DRY_RUN) {
  console.log('\n--dry-run: skipping D1 writes');
  process.exit(0);
}

// ── Write player name rows to D1 ─────────────────────────────────────────────

console.log(`\nWriting ${players.length} player rows to D1...`);

const CHUNK_SIZE = 200;
const nameRows = players.map(p => {
  const data = JSON.stringify({ name: p.name, id: p.id, position: p.position || null });
  return `INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES ('otd_player_${SPORT}_${escSql(p.id)}', '${escSql(data)}', 9999999999) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at;`;
});

for (let i = 0; i < nameRows.length; i += CHUNK_SIZE) {
  const sql = nameRows.slice(i, i + CHUNK_SIZE).join('\n');
  d1Execute(sql);
  process.stdout.write(`  ${Math.min(i + CHUNK_SIZE, nameRows.length)}/${nameRows.length} written\r`);
}

console.log(`\n\nDone!`);
console.log(`  Unique players: ${players.length}`);
console.log(`  Seasons covered: ${SEASONS.map(s => `${String(s).slice(2)}-${String(s+1).slice(2)}`).join(', ')}`);
console.log(`  D1 key pattern: otd_player_ncaaf_{id}`);
