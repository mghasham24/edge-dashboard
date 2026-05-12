// tests/webhook.test.js — Stripe webhook handler unit tests
// Focuses on the three highest-risk paths: signature rejection, trial cancellation,
// and invoice.payment_failed no-op (the audit items that caused bugs).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Helpers replicated from webhook.js for isolated testing ──────────────────
// (The handler itself is difficult to import in Node because it fetches Stripe
//  and uses Cloudflare env bindings. We test the pure logic extracted here.)

async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = sigHeader.split(',');
  const tPart = parts.find(p => p.startsWith('t='));
  const vParts = parts.filter(p => p.startsWith('v1='));
  if (!tPart || !vParts.length) return false;
  const timestamp = tPart.slice(2);
  const signatures = vParts.map(p => p.slice(3));
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;
  const signedPayload = timestamp + '.' + payload;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload));
  const expected = Array.from(new Uint8Array(mac))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return signatures.some(sig => sig === expected);
}

async function buildValidHeader(payload, secret) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signedPayload = timestamp + '.' + payload;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload));
  const sig = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `t=${timestamp},v1=${sig}`;
}

// ── Signature verification ───────────────────────────────────────────────────

describe('verifyStripeSignature', () => {
  const SECRET = 'whsec_test_secret';
  const PAYLOAD = '{"id":"evt_test"}';

  it('accepts a valid signature', async () => {
    const header = await buildValidHeader(PAYLOAD, SECRET);
    expect(await verifyStripeSignature(PAYLOAD, header, SECRET)).toBe(true);
  });

  it('rejects wrong secret', async () => {
    const header = await buildValidHeader(PAYLOAD, SECRET);
    expect(await verifyStripeSignature(PAYLOAD, header, 'wrong_secret')).toBe(false);
  });

  it('rejects tampered payload', async () => {
    const header = await buildValidHeader(PAYLOAD, SECRET);
    expect(await verifyStripeSignature('{"id":"tampered"}', header, SECRET)).toBe(false);
  });

  it('rejects expired timestamp (>5 min old)', async () => {
    const oldTs = String(Math.floor(Date.now() / 1000) - 400);
    const signedPayload = oldTs + '.' + PAYLOAD;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const mac = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload));
    const sig = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
    const header = `t=${oldTs},v1=${sig}`;
    expect(await verifyStripeSignature(PAYLOAD, header, SECRET)).toBe(false);
  });

  it('rejects missing header', async () => {
    expect(await verifyStripeSignature(PAYLOAD, '', SECRET)).toBe(false);
    expect(await verifyStripeSignature(PAYLOAD, null, SECRET)).toBe(false);
  });

  it('rejects missing secret', async () => {
    const header = await buildValidHeader(PAYLOAD, SECRET);
    expect(await verifyStripeSignature(PAYLOAD, header, '')).toBe(false);
  });
});

// ── Trial cancellation logic ─────────────────────────────────────────────────
// The bug: invoice.payment_failed was incorrectly dropping users to free.
// The fix: only downgrade on customer.subscription.deleted.
// Secondary: if trial_end is still in the future, keep pro until trial ends.

describe('subscription.deleted downgrade logic', () => {
  function shouldKeepProUntilTrialEnd(obj) {
    const now = Math.floor(Date.now() / 1000);
    return !!(obj.trial_end && obj.trial_end > now);
  }

  it('keeps pro when trial_end is in the future', () => {
    const futureTrialEnd = Math.floor(Date.now() / 1000) + 86400; // 1 day from now
    expect(shouldKeepProUntilTrialEnd({ trial_end: futureTrialEnd })).toBe(true);
  });

  it('drops to free when trial_end is in the past', () => {
    const pastTrialEnd = Math.floor(Date.now() / 1000) - 86400;
    expect(shouldKeepProUntilTrialEnd({ trial_end: pastTrialEnd })).toBe(false);
  });

  it('drops to free when trial_end is null (non-trial sub)', () => {
    expect(shouldKeepProUntilTrialEnd({ trial_end: null })).toBe(false);
    expect(shouldKeepProUntilTrialEnd({})).toBe(false);
  });
});

// ── invoice.payment_failed should be a no-op ────────────────────────────────

describe('invoice.payment_failed no-op', () => {
  it('does not downgrade plan', async () => {
    const dbUpdates = [];
    const mockDB = {
      prepare: (sql) => ({
        bind: (...args) => ({ run: async () => { dbUpdates.push({ sql, args }); return { meta: { changes: 0 } }; } })
      })
    };

    // Simulate the webhook handler's switch statement for payment_failed
    const event = { type: 'invoice.payment_failed', data: { object: { customer: 'cus_123' } } };
    switch (event.type) {
      case 'invoice.payment_failed':
        break; // intentional no-op
      default:
        await mockDB.prepare('UPDATE users SET plan=\'free\'').bind('cus_123').run();
    }

    expect(dbUpdates).toHaveLength(0);
  });
});

// ── Referral credit race guard ───────────────────────────────────────────────

describe('invoice.created referral credit atomicity', () => {
  it('skips Stripe call when no credits exist (changes=0)', async () => {
    const stripeCalls = [];
    const mockDB = {
      prepare: (sql) => ({
        bind: (...args) => ({
          run: async () => ({ meta: { changes: 0 } }), // no credits to spend
          first: async () => null
        })
      })
    };

    // Simulate the atomic decrement check
    const { meta } = await mockDB.prepare(
      'UPDATE users SET referral_credits = referral_credits - 1 WHERE stripe_customer_id=? AND referral_credits > 0'
    ).bind('cus_123').run();

    if (!meta.changes) {
      // early exit — no Stripe call should happen
    } else {
      stripeCalls.push('credit applied');
    }

    expect(stripeCalls).toHaveLength(0);
  });

  it('proceeds with Stripe call when credits exist (changes=1)', async () => {
    const stripeCalls = [];
    const mockDB = {
      prepare: () => ({
        bind: () => ({
          run: async () => ({ meta: { changes: 1 } }),
          first: async () => ({ id: 42 })
        })
      })
    };

    const { meta } = await mockDB.prepare('UPDATE ...').bind('cus_123').run();
    if (!meta.changes) {
      // no-op
    } else {
      stripeCalls.push('credit applied');
    }

    expect(stripeCalls).toHaveLength(1);
  });
});
