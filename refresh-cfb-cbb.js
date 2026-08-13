#!/usr/bin/env node
// Force-refresh OTD earnings cache for CFB (ncaaf) and CBB (ncaabb/ncaam).
// Reads CF_ACCOUNT_ID and CF_API_TOKEN from wrangler config automatically.
//
// Usage:
//   CRON_SECRET=xxx node refresh-cfb-cbb.js

import { readFileSync } from 'fs';
import { homedir } from 'os';

const CRON_SECRET = process.env.CRON_SECRET;
const SITE_URL    = process.env.SITE_URL || 'https://raxedge.com';
const D1_DB_ID    = 'ff9b93f1-81f8-4370-bd57-f634e0300443';
const CF_ACCOUNT  = 'd199da4529f3e3317d6c6b16fb396ed2';

if (!CRON_SECRET) {
    console.error('Missing CRON_SECRET env var.');
    console.error('Find it: CF Dashboard → Workers & Pages → edge-dashboard → Settings → Variables');
    process.exit(1);
}

// Read OAuth token from wrangler config
let CF_TOKEN;
try {
    const cfg = readFileSync(`${homedir()}/.wrangler/config/default.toml`, 'utf8');
    const m = cfg.match(/oauth_token\s*=\s*"([^"]+)"/);
    if (!m) throw new Error('oauth_token not found');
    CF_TOKEN = m[1];
} catch(e) {
    console.error('Could not read wrangler auth token:', e.message);
    console.error('Run: npx wrangler login');
    process.exit(1);
}

const TARGET_SPORTS = new Set(['ncaaf', 'ncaabb', 'ncaam']);
const RS_SPORT_ALIAS = { ncaabb: 'ncaam' };

function cacheKey(p) {
    const sportKey = RS_SPORT_ALIAS[p.sport] || p.sport;
    return `otd_earnings_v10_${p.entityType || 'player'}_${sportKey}_${p.season}_${p.playerId}`;
}

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/d1/database/${D1_DB_ID}/query`;

async function d1(sql, params = []) {
    const res = await fetch(D1_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, params }),
    });
    const j = await res.json();
    if (!j.success) throw new Error('D1 error: ' + JSON.stringify(j.errors));
    return j.result[0].results || [];
}

async function fetchViaApi(p) {
    const url = `${SITE_URL}/api/real/otd?action=earnings` +
        `&id=${encodeURIComponent(p.playerId)}` +
        `&sport=${encodeURIComponent(p.sport)}` +
        `&season=${encodeURIComponent(p.season)}` +
        `&level=1` +
        `&entityType=${encodeURIComponent(p.entityType || 'player')}` +
        `&_cron_key=${encodeURIComponent(CRON_SECRET)}`;

    for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt > 0) await sleep(2000 * attempt);
        let res;
        try {
            res = await fetch(url, { signal: AbortSignal.timeout(20000) });
        } catch(e) {
            if (attempt === 4) return { error: e.message };
            continue;
        }
        if (res.status === 429) continue;
        const text = await res.text();
        if (!res.ok) return { error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
        try { return JSON.parse(text); } catch(e) { return { error: `Bad JSON: ${text.slice(0, 200)}` }; }
    }
    return { error: 'max retries' };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    console.log('Reading user pass caches from D1...');
    const rows = await d1("SELECT data FROM odds_cache WHERE cache_key LIKE 'otd_passes_all_v8_%'");
    console.log(`Found ${rows.length} user cache entries.`);

    const playerMap = {};
    for (const row of rows) {
        let pd;
        try { pd = JSON.parse(row.data); } catch(e) { continue; }
        for (const p of (pd.passes || [])) {
            if (!TARGET_SPORTS.has(p.sport)) continue;
            const key = cacheKey(p);
            if (!playerMap[key]) playerMap[key] = p;
        }
    }

    const allKeys = Object.keys(playerMap);
    console.log(`Found ${allKeys.length} unique CFB/CBB player+sport+season combos.\n`);

    if (allKeys.length === 0) {
        console.log('No CFB/CBB passes found in any user cache. Nothing to do.');
        return;
    }

    // Delete existing earnings cache entries
    console.log('Deleting stale D1 earnings entries for CFB/CBB...');
    const CHUNK = 100;
    for (let i = 0; i < allKeys.length; i += CHUNK) {
        const chunk = allKeys.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        await d1(`DELETE FROM odds_cache WHERE cache_key IN (${placeholders})`, chunk);
    }
    console.log(`Deleted entries. Re-fetching fresh...\n`);

    let done = 0, failed = 0, empty = 0;
    for (const key of allKeys) {
        const p = playerMap[key];
        const label = `[${done + failed + empty + 1}/${allKeys.length}] ${p.sport} ${p.playerName || p.playerId} (${p.season})`;
        process.stdout.write(label + '... ');
        const result = await fetchViaApi(p);

        if (result.error) {
            console.log('FAILED: ' + result.error);
            failed++;
        } else if (!result.earnings || result.earnings.length === 0) {
            console.log('empty');
            empty++;
        } else {
            const bt = result.baseTotal != null ? ` base=${result.baseTotal}` : '';
            console.log(`OK (${result.earnings.length} events${bt})`);
            done++;
        }

        await sleep(400);
    }

    console.log(`\nDone. Refreshed: ${done} | Empty: ${empty} | Failed: ${failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
