#!/usr/bin/env node
// seed-cfb-earnings.js
// Fetches per-game earnings for every CFB player in a given season, writes to D1.
//
// Usage:
//   SEASON=2025 REAL_AUTH_TOKEN=... REAL_SESSION_TOKEN=... REAL_DEVICE_UUID=... node seed-cfb-earnings.js
//   SEASON=2024 ... node seed-cfb-earnings.js
//   SEASON=2023 ... node seed-cfb-earnings.js
//
// On D1 write failure, just re-run — fetched results are saved to disk and reused.
// Flags: --reset  clear all progress for this season

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, existsSync, readFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const RS_BASE = 'https://web.realapp.com';
const SPORT = 'ncaaf';
const ENTITY_TYPE = 'player';

const SEASON = process.env.SEASON || '2025';
const AUTH_TOKEN = process.env.REAL_AUTH_TOKEN;
const SESSION_TOKEN = process.env.REAL_SESSION_TOKEN || '';
const DEVICE_UUID = process.env.REAL_DEVICE_UUID || '';

// Conservative to avoid RS rate limiting
const CONCURRENCY = 3;
const DELAY_MS = 500;

const RESET = process.argv.includes('--reset');
const PLAYER_CACHE = '/tmp/cfb-players-cache.json';
// Fetched results saved here line-by-line (JSONL) — survives crashes
const FETCH_CACHE = `/tmp/cfb-earnings-fetched-${SEASON}.jsonl`;
// IDs already written to D1
const WRITE_CHECKPOINT = `/tmp/cfb-earnings-written-${SEASON}.json`;

const CACHE_KEY_PREFIX = `otd_earnings_v10_${ENTITY_TYPE}_${SPORT}_${SEASON}_`;
const D1_CHUNK_SIZE = 80;

if (!AUTH_TOKEN) { console.error('ERROR: REAL_AUTH_TOKEN required'); process.exit(1); }
if (!existsSync(PLAYER_CACHE)) { console.error('ERROR: /tmp/cfb-players-cache.json not found — run seed-cfb-players.js first'); process.exit(1); }

if (RESET) {
  if (existsSync(FETCH_CACHE)) { unlinkSync(FETCH_CACHE); console.log('Cleared fetch cache.'); }
  if (existsSync(WRITE_CHECKPOINT)) { unlinkSync(WRITE_CHECKPOINT); console.log('Cleared write checkpoint.'); }
}

// ── hashidsEncode (salt='realwebapp', minLen=16) ─────────────────────────────
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

async function fetchEarnings(id) {
  const url = `${RS_BASE}/userpassearnings/${SPORT}/season/${SEASON}/entity/${ENTITY_TYPE}/${id}?level=1`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { headers: buildHeaders(), signal: ctrl.signal });
    clearTimeout(t);
    if (res.status === 429) return { status: 429 };
    if (!res.ok) return { status: res.status };
    const data = await res.json();
    const earnings = data.earnings || [];
    const baseTotal = data.info?.total ?? earnings.reduce((s, e) => s + (e.earnings || 0), 0);
    return { ok: true, earnings, baseTotal };
  } catch (e) {
    clearTimeout(t);
    return { status: 0, error: e.message };
  }
}

function escSql(str) { return String(str).replace(/'/g, "''"); }

function d1Execute(sql) {
  const tmpFile = join(tmpdir(), `cfbe-${Date.now()}.sql`);
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

// ── Load players for this season ─────────────────────────────────────────────
const allPlayers = JSON.parse(readFileSync(PLAYER_CACHE, 'utf8'));
const seasonYear = parseInt(SEASON);
const players = allPlayers.filter(p => p.seasons.includes(seasonYear));
console.log(`\nSeason ${SEASON}: ${players.length} players`);

// ── Phase 1: Fetch (resumable via JSONL cache) ────────────────────────────────

// Load already-fetched IDs from JSONL
const fetchedMap = new Map(); // id → body string
if (existsSync(FETCH_CACHE)) {
  const lines = readFileSync(FETCH_CACHE, 'utf8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    try { const r = JSON.parse(line); fetchedMap.set(String(r.id), r.body); } catch {}
  }
  console.log(`Loaded ${fetchedMap.size} already-fetched from disk cache`);
}

const toFetch = players.filter(p => !fetchedMap.has(String(p.id)));
console.log(`To fetch: ${toFetch.length} | Already fetched: ${fetchedMap.size}`);

if (toFetch.length > 0) {
  let fetched = 0, errors = 0, ratelimited = 0;
  const startTime = Date.now();
  let backoffMs = 0;

  for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
    if (backoffMs > 0) { await sleep(backoffMs); backoffMs = 0; }

    const batch = toFetch.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(p => fetchEarnings(p.id)));

    let hit429 = false;
    for (let j = 0; j < batch.length; j++) {
      const p = batch[j];
      const r = batchResults[j];
      if (r.status === 429) { hit429 = true; ratelimited++; continue; }
      if (!r.ok) { errors++; continue; }
      const body = JSON.stringify({ ok: true, earnings: r.earnings, baseTotal: r.baseTotal });
      fetchedMap.set(String(p.id), body);
      // Append to JSONL immediately — survives crashes
      appendFileSync(FETCH_CACHE, JSON.stringify({ id: p.id, body }) + '\n');
      fetched++;
    }

    if (hit429) {
      backoffMs = 15000; // 15s backoff on any 429
      console.log(`  [429] Rate limited — backing off 15s`);
    }

    if ((i + CONCURRENCY) % 300 === 0 || i + CONCURRENCY >= toFetch.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = fetched / Math.max(elapsed, 1);
      const eta = rate > 0 ? Math.round((toFetch.length - fetched) / rate) : '?';
      process.stdout.write(`  fetch ${fetched + fetchedMap.size - (players.length - toFetch.length)}/${players.length} | errors:${errors} rl:${ratelimited} | ${elapsed}s ETA ~${eta}s\n`);
    }

    if (i + CONCURRENCY < toFetch.length) await sleep(DELAY_MS);
  }

  console.log(`\nFetch done. ${fetchedMap.size} total on disk, ${errors} errors, ${ratelimited} rate-limited.`);
} else {
  console.log('All players already fetched from disk cache — skipping fetch phase.');
}

// ── Phase 2: Write to D1 (resumable via write checkpoint) ────────────────────

const writtenIds = new Set(existsSync(WRITE_CHECKPOINT)
  ? JSON.parse(readFileSync(WRITE_CHECKPOINT, 'utf8'))
  : []);

const allFetched = [...fetchedMap.entries()]; // [id, body]
const toWrite = allFetched.filter(([id]) => !writtenIds.has(id));

console.log(`\nD1 writes: ${toWrite.length} remaining (${writtenIds.size} already written)`);

if (toWrite.length === 0) {
  console.log('All rows already in D1!');
} else {
  const now = Math.floor(Date.now() / 1000);
  let written = 0;

  for (let i = 0; i < toWrite.length; i += D1_CHUNK_SIZE) {
    const chunk = toWrite.slice(i, i + D1_CHUNK_SIZE);
    const sql = chunk.map(([id, body]) =>
      `INSERT INTO odds_cache (cache_key, data, fetched_at) VALUES ('${CACHE_KEY_PREFIX}${escSql(id)}', '${escSql(body)}', ${now}) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at;`
    ).join('\n');

    let retries = 3;
    while (retries > 0) {
      try {
        d1Execute(sql);
        break;
      } catch (e) {
        retries--;
        if (retries === 0) throw e;
        console.log(`  D1 write failed, retrying in 5s... (${retries} left)`);
        await sleep(5000);
      }
    }

    // Save checkpoint after each successful chunk
    for (const [id] of chunk) writtenIds.add(id);
    writeFileSync(WRITE_CHECKPOINT, JSON.stringify([...writtenIds]));
    written += chunk.length;
    process.stdout.write(`  ${written}/${toWrite.length} written\r`);
  }

  console.log(`\n\nAll done! Season ${SEASON}`);
  console.log(`  Players fetched: ${fetchedMap.size}`);
  console.log(`  D1 rows written: ${writtenIds.size}`);
  console.log(`  Cache key prefix: ${CACHE_KEY_PREFIX}`);
}
