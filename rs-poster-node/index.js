// rs-poster-node/index.js
// Polls RS open positions every minute and posts new ones to the RS group.
// Uses Playwright headless Chrome — logs in via browser form to get a real session,
// then makes RS API calls via context.request (Chromium network stack, carries session cookies).
//
// Required env vars:
//   RS_LOGIN      — RS email / phone number
//   RS_PASSWORD   — RS password
//   RS_GROUP_ID   — numeric RS group ID
// Optional:
//   RS_DEVICE_UUID — device UUID

import { chromium } from 'playwright';
import { CronJob } from 'cron';

const RS_GROUP_ID = process.env.RS_GROUP_ID;
const RS_BASE     = 'https://web.realapp.com';
const RS_WEB_BASE = 'https://www.realapp.com';
const DEVICE_UUID = process.env.RS_DEVICE_UUID || '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';

const postedIds = new Set();
let _browser = null;
let _context = null;

function rsHeaders() {
  return {
    'Content-Type':       'application/json',
    'Accept':             'application/json',
    'Accept-Language':    'en-US,en;q=0.9',
    'Origin':             RS_WEB_BASE,
    'Referer':            RS_WEB_BASE + '/',
    'real-device-uuid':   DEVICE_UUID,
    'real-device-name':   '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
    'real-device-type':   'desktop_web',
    'real-version':       '31',
    'real-request-token': Math.random().toString(36).slice(2, 18),
  };
}

async function loginViaForm(page) {
  const login    = process.env.RS_LOGIN;
  const password = process.env.RS_PASSWORD;
  if (!login || !password) throw new Error('RS_LOGIN or RS_PASSWORD not set');

  console.log('rs-poster: navigating to login page');
  await page.goto(RS_WEB_BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  console.log('rs-poster: login page URL:', page.url());

  // Fill first visible input (email/phone)
  const firstInput = page.locator('input').first();
  await firstInput.waitFor({ timeout: 8000 });
  await firstInput.fill(login);

  // Check if password field is already visible (single-step) or need to continue (multi-step)
  const pwInput = page.locator('input[type="password"]');
  if (await pwInput.count() === 0) {
    await page.locator('button').first().click();
    await page.waitForTimeout(1500);
  }

  await page.locator('input[type="password"]').fill(password);

  // Submit
  await page.locator('button[type="submit"]').click();

  // Wait for navigation away from login
  try {
    await page.waitForURL(url => !url.includes('/login'), { timeout: 20000 });
    console.log('rs-poster: logged in, URL:', page.url());
  } catch {
    const bodyText = await page.locator('body').textContent().catch(() => '');
    console.error('rs-poster: login may have failed. Body snippet:', bodyText.slice(0, 300));
    throw new Error('login form did not redirect away from /login');
  }
}

async function ensureSession() {
  if (_browser && _browser.isConnected() && _context) return;
  if (_browser) { try { await _browser.close(); } catch {} }

  console.log('rs-poster: launching headless Chrome');
  _browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  _context = await _browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
  });

  const page = await _context.newPage();
  try {
    await loginViaForm(page);
  } finally {
    await page.close();
  }
}

async function rsFetch(method, url, body) {
  const opts = { method, headers: rsHeaders() };
  if (body) opts.data = JSON.stringify(body);
  const res  = await _context.request.fetch(url, opts);
  const text = await res.text();
  return { ok: res.ok(), status: res.status(), body: text };
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
    await ensureSession();

    const posResult = await rsFetch('GET', RS_BASE + '/predictions/openpositions', null);
    if (!posResult.ok) {
      console.error('rs-poster: openpositions failed', posResult.status, posResult.body.slice(0, 200));
      if (posResult.status === 401 || posResult.status === 403) {
        _context = null;
        try { await _browser.close(); } catch {}
        _browser = null;
      }
      return;
    }

    const positions    = JSON.parse(posResult.body).positions || [];
    if (!positions.length) { console.log('rs-poster: no open positions'); return; }

    const newPositions = positions.filter(p => p.sharedPositionId && !postedIds.has(p.sharedPositionId));
    if (!newPositions.length) { console.log('rs-poster: no new positions'); return; }

    console.log('rs-poster: found', newPositions.length, 'new position(s)');

    for (let i = 0; i < newPositions.length; i++) {
      const pos   = newPositions[i];
      const posId = pos.sharedPositionId;
      try {
        const detailResult = await rsFetch('GET', RS_BASE + '/predictions/position/' + posId, null);
        const detail       = detailResult.ok ? JSON.parse(detailResult.body) : {};
        const path         = detail.position?.marketDisplay?.path;
        const shareUrl     = path ? RS_WEB_BASE + path : '';
        const text         = formatPost(pos) + (shareUrl ? '\n\n' + shareUrl : '');

        const groupResult = await rsFetch('POST', RS_BASE + '/comments/groups/' + RS_GROUP_ID, {
          groupId: parseInt(RS_GROUP_ID), text, parentCommentId: null,
        });

        if (groupResult.ok) {
          console.log('rs-poster: posted', posId);
          postedIds.add(posId);
        } else {
          console.error('rs-poster: group post failed', posId, groupResult.status, groupResult.body.slice(0, 200));
        }

        if (i < newPositions.length - 1) await new Promise(r => setTimeout(r, 1000));
      } catch (e) {
        console.error('rs-poster: error for', posId, e.message);
      }
    }
  } catch (e) {
    console.error('rs-poster: run error', e.message);
    _context = null;
    if (_browser) { try { await _browser.close(); } catch {} _browser = null; }
  }
}

if (!RS_GROUP_ID) { console.error('rs-poster: RS_GROUP_ID not set'); process.exit(1); }

console.log('rs-poster: starting, group', RS_GROUP_ID);
run();
new CronJob('* * * * *', run, null, true, 'America/Chicago');
