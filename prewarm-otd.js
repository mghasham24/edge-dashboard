#!/usr/bin/env node
// Pre-warm OTD earnings cache before launch.
// Reads all user passes from D1, finds uncached players, calls our own CF API to fetch+cache each one.
//
// Usage:
//   CF_ACCOUNT_ID=xxx CF_API_TOKEN=xxx CRON_SECRET=xxx node prewarm-otd.js
//
// CF_API_TOKEN: Cloudflare API token with D1 read permission (to read pass caches)
// CRON_SECRET:  from Cloudflare env vars — used to authenticate the /api/real/otd earnings calls

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN  = process.env.CF_API_TOKEN;
const CRON_SECRET   = process.env.CRON_SECRET;
const SITE_URL      = process.env.SITE_URL || 'https://raxedge.com';
const D1_DB_ID      = 'ff9b93f1-81f8-4370-bd57-f634e0300443';

if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !CRON_SECRET) {
    console.error('Missing env vars: CF_ACCOUNT_ID, CF_API_TOKEN, CRON_SECRET');
    process.exit(1);
}

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DB_ID}/query`;

async function d1(sql, params = []) {
    const res = await fetch(D1_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, params }),
    });
    const j = await res.json();
    if (!j.success) throw new Error('D1 error: ' + JSON.stringify(j.errors));
    return j.result[0].results || [];
}

const RS_SPORT_ALIAS = { ncaabb: 'ncaam' };
const RS_SEASON_NORM = { ufc: 'alltime' };

function cacheKey(p) {
    const sportKey  = RS_SPORT_ALIAS[p.sport] || p.sport;
    const seasonKey = RS_SEASON_NORM[p.sport]  || p.season;
    return `otd_earnings_v10_${p.entityType || 'player'}_${sportKey}_${seasonKey}_${p.playerId}`;
}

async function fetchViaApi(p) {
    const url = `${SITE_URL}/api/real/otd?action=earnings` +
        `&id=${encodeURIComponent(p.playerId)}` +
        `&sport=${encodeURIComponent(p.sport)}` +
        `&season=${encodeURIComponent(p.season)}` +
        `&level=${encodeURIComponent(p.level || 1)}` +
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
        if (res.status === 429) continue; // CF rate limiter — retry
        const text = await res.text();
        if (!res.ok) return { error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
        try { return JSON.parse(text); } catch(e) { return { error: `Bad JSON (${res.status}): ${text.slice(0, 200)}` }; }
    }
    return { error: 'max retries' };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    console.log('Reading user pass caches from D1...');
    const rows = await d1("SELECT data FROM odds_cache WHERE cache_key LIKE 'otd_passes_all_v8_%'");
    console.log(`Found ${rows.length} user pass cache entries.`);

    // Collect unique player combos keyed by D1 cache key
    const playerMap = {};
    for (const row of rows) {
        let pd;
        try { pd = JSON.parse(row.data); } catch(e) { continue; }
        for (const p of (pd.passes || [])) {
            const key = cacheKey(p);
            if (!playerMap[key]) playerMap[key] = p;
        }
    }
    const allKeys = Object.keys(playerMap);
    console.log(`Found ${allKeys.length} unique player+sport+season combos.`);

    // Batch-check which are already in D1
    const cached = new Set();
    const CHUNK = 100;
    for (let i = 0; i < allKeys.length; i += CHUNK) {
        const chunk = allKeys.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        const existing = await d1(`SELECT cache_key FROM odds_cache WHERE cache_key IN (${placeholders})`, chunk);
        for (const r of existing) cached.add(r.cache_key);
    }

    const toFetch = allKeys.filter(k => !cached.has(k));
    console.log(`${cached.size} already cached. ${toFetch.length} need fetching.\n`);

    if (toFetch.length === 0) { console.log('All warm! Nothing to do.'); return; }

    let done = 0, failed = 0, empty = 0;
    for (const key of toFetch) {
        const p = playerMap[key];
        const label = `[${done + failed + empty + 1}/${toFetch.length}] ${p.sport} ${p.playerName || p.playerId} (${p.season})`;
        process.stdout.write(label + '... ');
        const result = await fetchViaApi(p);
        if (result.error) {
            console.log('FAILED: ' + result.error);
            failed++;
        } else if (!result.earnings || result.earnings.length === 0) {
            console.log('empty');
            empty++;
        } else {
            console.log(`OK (${result.earnings.length} events)`);
            done++;
        }
        // Pace requests — CF API writes to D1 after each RS fetch
        await sleep(400);
    }

    console.log(`\nDone. Cached: ${done} | Empty: ${empty} | Failed: ${failed}`);
    console.log(`D1 earnings entries after: run "npx wrangler d1 execute edge-db --remote --command \\"SELECT COUNT(*) FROM odds_cache WHERE cache_key LIKE 'otd_earnings_v10_%'\\""`);
}

main().catch(e => { console.error(e); process.exit(1); });
