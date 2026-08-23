#!/usr/bin/env node
// Fetch edgebot's RS offer history (no CF timeout)
// Usage: EDGEBOT_AUTH_INFO="..." EDGEBOT_SESSION_TOKEN="..." node offer-history.js
//   days=90 min_amount=1000 view=incoming status=accepted (change via env)
//
// Get EDGEBOT_AUTH_INFO from: CF dashboard → edge-dashboard → Settings → Environment variables

const authInfo     = process.env.EDGEBOT_AUTH_INFO;
const sessionToken = process.env.EDGEBOT_SESSION_TOKEN || '';
const minAmount    = parseInt(process.env.MIN_AMOUNT || '1000', 10);
const days         = parseInt(process.env.DAYS || '90', 10);
const view         = process.env.VIEW || 'incoming';
const status       = process.env.STATUS || 'accepted';

if (!authInfo) {
  console.error('Set EDGEBOT_AUTH_INFO env var. Get it from CF dashboard → edge-dashboard → Settings → Environment variables');
  process.exit(1);
}

const cutoff = Date.now() - days * 86400000;
const RS_DEVICE_UUID = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';

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
    'Accept':               'application/json',
    'Content-Type':         'application/json',
    'Origin':               'https://www.realapp.com',
    'Referer':              'https://www.realapp.com/',
    'User-Agent':           'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
    'real-auth-info':       authInfo,
    'real-session-token':   sessionToken,
    'real-device-uuid':     RS_DEVICE_UUID,
    'real-device-type':     'desktop_web',
    'real-device-name':     '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
    'real-version':         '35',
    'real-request-token':   hashidsEncode(Date.now()),
  };
}

async function fetchPage(offset) {
  const url = `https://web.realapp.com/cardmarketplace/user/offers?offset=${offset}&status=${status}&view=${view}`;
  const res = await fetch(url, { headers: buildHeaders(), signal: AbortSignal.timeout(15000) });
  if (offset === 0) console.log(`  RS status: ${res.status}`);
  if (!res.ok) {
    if (offset === 0) console.log(`  RS error body: ${await res.text().catch(() => '?')}`);
    return [];
  }
  const text = await res.text().catch(() => '');
  if (offset === 0) console.log(`  RS response (first 300): ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  return Array.isArray(data) ? data : (data.offers || []);
}

async function main() {
  console.log(`Fetching edgebot's ${view}/${status} offers ≥ ${minAmount} Rax from the past ${days} days...\n`);

  const all = [];
  let page = 0;
  let done = false;

  while (!done) {
    // Fetch 10 pages at a time in parallel
    const offsets = Array.from({ length: 10 }, (_, i) => (page + i) * 10);
    process.stdout.write(`  pages ${page}–${page + 9}...`);
    const results = await Promise.all(offsets.map(o => fetchPage(o)));
    let fetched = 0;
    for (const pageOffers of results) {
      if (!pageOffers.length) { done = true; break; }
      fetched += pageOffers.length;
      all.push(...pageOffers);
      const oldest = pageOffers[pageOffers.length - 1];
      const ts = oldest?.statusChangedAt || oldest?.createdAt || oldest?.updatedAt;
      if (ts && new Date(ts).getTime() < cutoff) { done = true; break; }
    }
    console.log(` got ${fetched} offers (total: ${all.length})`);
    page += 10;
    if (page > 500) { console.log('Hit 500-page safety limit'); break; }
  }

  // Filter
  const filtered = all.filter(o => {
    const ts = o.statusChangedAt || o.createdAt || o.updatedAt;
    if (ts && new Date(ts).getTime() < cutoff) return false;
    const amt = o.counterAmount ?? o.amount ?? o.offerAmount ?? 0;
    return amt >= minAmount;
  });

  filtered.sort((a, b) => {
    const ta = new Date(a.statusChangedAt || a.createdAt || 0).getTime();
    const tb = new Date(b.statusChangedAt || b.createdAt || 0).getTime();
    return tb - ta;
  });

  console.log(`\n${'─'.repeat(80)}`);
  console.log(`${filtered.length} offers ≥ ${minAmount} Rax in past ${days} days (scanned ${all.length} total)\n`);

  for (const o of filtered) {
    const amt  = o.counterAmount ?? o.amount ?? o.offerAmount;
    const ts   = o.statusChangedAt || o.createdAt || o.updatedAt;
    const date = ts ? new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' }) : '?';
    const name = o.fromUsername ?? o.offerFromUsername ?? o.sellerUsername ?? o.buyerUsername ?? '?';
    const card = o.cardId ?? o.card?.id ?? o.card_id ?? o.linkedCardIds?.[0] ?? '?';
    console.log(`  ${date.padEnd(18)} ${String(amt).padStart(6)} Rax   from: ${name.padEnd(20)} card: ${card}   offer#${o.id}`);
  }

  console.log(`\n${'─'.repeat(80)}`);
  const total = filtered.reduce((s, o) => s + (o.counterAmount ?? o.amount ?? o.offerAmount ?? 0), 0);
  console.log(`Total: ${total.toLocaleString()} Rax across ${filtered.length} offers`);
}

main().catch(e => { console.error(e); process.exit(1); });
