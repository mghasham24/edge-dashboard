// find-ids.js — run on VPS with: node --env-file=.env find-ids.js
// Probes RS API to find entity IDs for target soccer players

import { ProxyAgent, fetch as uFetch } from 'undici';
import { readFileSync } from 'fs';

const SHARED_TOKEN_FILE = '/root/raxedge/shared-token.txt';
function getToken() {
  try { const t = readFileSync(SHARED_TOKEN_FILE, 'utf8').trim(); if (t) return t; } catch(_) {}
  return process.env.RS_AUTH_INFO || '';
}

const token     = getToken();
const proxyUrl  = process.env.RS_PROXY_URL;
const deviceUuid = process.env.RS_DEVICE_UUID || '2e0a38e2-0ee8-4f93-9a34-218ac1d10161';
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

const NAMES = [
  'haaland', 'diaz', 'vinicius', 'enzo fernandez',
  'mbappe', 'olise', 'kane', 'yamal',
  'bruno fernandes', 'van dijk', 'bellingham', 'mckennie',
];

const HEADERS = {
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'Origin': 'https://realsports.io',
  'Referer': 'https://realsports.io/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
  'real-device-uuid': deviceUuid,
  'real-device-type': 'desktop_web',
  'real-version': '34',
  'real-auth-info': token,
};

async function tryUrl(label, url) {
  try {
    const res = await uFetch(url, { dispatcher, headers: HEADERS, signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    console.log(`\n[${label}] status=${res.status} len=${text.length}`);
    if (res.ok) {
      console.log(text.slice(0, 800));
    } else {
      console.log(text.slice(0, 200));
    }
  } catch(e) {
    console.log(`[${label}] ERROR: ${e.message}`);
  }
}

// Try several search endpoint patterns
const testName = 'mbappe';
await tryUrl('entities?search', `https://web.realapp.com/entities?sport=soccer&search=${testName}`);
await tryUrl('entities?name', `https://web.realapp.com/entities?sport=soccer&name=${testName}`);
await tryUrl('entities?q', `https://web.realapp.com/entities?sport=soccer&q=${testName}`);
await tryUrl('players?search', `https://web.realapp.com/players?sport=soccer&search=${testName}`);
await tryUrl('search?query', `https://web.realapp.com/search?sport=soccer&query=${testName}&types=player`);
await tryUrl('globalcards?search', `https://web.realapp.com/globalcards?sport=soccer&search=${testName}&limit=5`);
await tryUrl('globalcards?player', `https://web.realapp.com/globalcards?sport=soccer&player=${testName}&limit=5`);
await tryUrl('globalcards?query', `https://web.realapp.com/globalcards?sport=soccer&query=${testName}&limit=5`);
