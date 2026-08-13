#!/usr/bin/env node
// One-off: fix all annual pro users with null pro_expires_at.
// For each: fetch their Stripe subscription → update pro_expires_at in D1.
// If they have pending invoice items (deferred proration from monthly→annual switch),
// create and immediately pay an invoice so they're charged now, not at next renewal.
//
// Usage:
//   STRIPE_SECRET_KEY=sk_live_xxx node fix-annual-users.js
//   Add --dry-run to preview without charging or writing to D1.

import { readFileSync } from 'fs';
import { homedir } from 'os';

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const DRY_RUN = process.argv.includes('--dry-run');

if (!STRIPE_KEY) {
    console.error('Missing STRIPE_SECRET_KEY env var.');
    process.exit(1);
}

if (DRY_RUN) console.log('--- DRY RUN --- (no charges, no DB writes)\n');

const cfg = readFileSync(`${homedir()}/.wrangler/config/default.toml`, 'utf8');
const CF_TOKEN = cfg.match(/oauth_token\s*=\s*"([^"]+)"/)[1];
const CF_ACCOUNT = 'd199da4529f3e3317d6c6b16fb396ed2';
const D1_DB_ID   = 'ff9b93f1-81f8-4370-bd57-f634e0300443';
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

async function stripe(path, method = 'GET', body = null) {
    const opts = {
        method,
        headers: { 'Authorization': `Bearer ${STRIPE_KEY}` },
    };
    if (body) {
        opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        opts.body = new URLSearchParams(body).toString();
    }
    const res = await fetch('https://api.stripe.com/v1' + path, opts);
    return res.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    const users = await d1(`
        SELECT id, email, stripe_customer_id, stripe_sub_id, billing_interval
        FROM users
        WHERE billing_interval = 'annual' AND stripe_sub_id IS NOT NULL AND plan = 'pro' AND pro_expires_at IS NULL
    `);

    // Skip obvious test accounts
    const SKIP = new Set(['annualtest@gmail.com']);
    const targets = users.filter(u => !SKIP.has(u.email));

    console.log(`Found ${targets.length} users to fix (skipped ${users.length - targets.length} test accounts)\n`);

    for (const u of targets) {
        console.log(`\n[${u.email}]`);

        // 1. Fetch their Stripe subscription
        const sub = await stripe('/subscriptions/' + u.stripe_sub_id);
        if (sub.error || !sub.id) {
            console.log(`  ⚠ Could not fetch sub: ${JSON.stringify(sub.error || sub)}`);
            continue;
        }

        const periodEnd = sub.items?.data?.[0]?.current_period_end || sub.current_period_end || null;
        const periodEndDate = periodEnd ? new Date(periodEnd * 1000).toISOString().slice(0, 10) : 'null';
        console.log(`  Subscription status: ${sub.status}, period_end: ${periodEndDate}`);

        // 2. Update pro_expires_at in D1
        if (!DRY_RUN) {
            await d1(
                'UPDATE users SET pro_expires_at=?, stripe_status=? WHERE id=?',
                [periodEnd, sub.status, u.id]
            );
            console.log(`  ✓ D1 updated: pro_expires_at=${periodEndDate}, stripe_status=${sub.status}`);
        } else {
            console.log(`  [dry] Would set pro_expires_at=${periodEndDate}, stripe_status=${sub.status}`);
        }

        // 3. Check for pending invoice items (deferred proration from monthly→annual)
        const pending = await stripe('/invoiceitems?customer=' + u.stripe_customer_id + '&pending=true&limit=10');
        const items = pending.data || [];
        const totalPending = items.reduce((s, i) => s + (i.amount || 0), 0);

        if (items.length === 0) {
            console.log(`  No pending invoice items — nothing to charge.`);
            continue;
        }

        console.log(`  Pending items: ${items.length}, total: $${(totalPending / 100).toFixed(2)}`);
        items.forEach(item => {
            console.log(`    - ${item.description || item.id}: $${(item.amount / 100).toFixed(2)}`);
        });

        if (DRY_RUN) {
            console.log(`  [dry] Would create invoice and charge $${(totalPending / 100).toFixed(2)} immediately.`);
            continue;
        }

        // 4. Create invoice from pending items
        const inv = await stripe('/invoices', 'POST', { customer: u.stripe_customer_id });
        if (!inv.id) {
            console.log(`  ⚠ Invoice creation failed: ${JSON.stringify(inv.error || inv)}`);
            continue;
        }
        console.log(`  Created invoice ${inv.id}`);

        // 5. Finalize
        const finalized = await stripe('/invoices/' + inv.id + '/finalize', 'POST');
        if (finalized.status !== 'open') {
            console.log(`  ⚠ Finalize failed: ${JSON.stringify(finalized.error || finalized)}`);
            continue;
        }
        console.log(`  Finalized invoice`);

        // 6. Pay
        const paid = await stripe('/invoices/' + inv.id + '/pay', 'POST');
        if (paid.status === 'paid') {
            console.log(`  ✓ Charged $${(totalPending / 100).toFixed(2)} successfully`);
        } else {
            console.log(`  ⚠ Payment result: ${paid.status} — ${JSON.stringify(paid.error || '')}`);
        }

        await sleep(500); // rate limiting
    }

    console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
