// test-id.mjs — run from marketplace-scanner dir with: node --env-file=.env test-id.mjs
import { ProxyAgent, fetch as uFetch } from 'undici';
import { readFileSync } from 'fs';

const token = readFileSync('/root/raxedge/shared-token.txt','utf8').trim();
const proxy = new ProxyAgent(process.env.RS_PROXY_URL);

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

const ENTITY_ID = process.argv[2] || '2338416';

const res = await uFetch(
  `https://web.realapp.com/cardmarketplacelistings?cohort=all&filterEntityType=player&listingType=userpassfull&prestige=all&rarity=all&season=2025&sport=soccer&limit=10&filterEntityId=${ENTITY_ID}`,
  {
    dispatcher: proxy,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Origin': 'https://realsports.io',
      'Referer': 'https://realsports.io/',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
      'real-device-uuid': '2e0a38e2-0ee8-4f93-9a34-218ac1d10161',
      'real-device-type': 'desktop_web',
      'real-version': '34',
      'real-request-token': hashidsEncode(Date.now()),
      'real-auth-info': token,
    },
    signal: AbortSignal.timeout(10000),
  }
);

console.log('status:', res.status);
const d = await res.json();
const l = d.listings?.[0];
console.log('count:', d.listings?.length ?? 0);
if (l) {
  const e = l.card?.entity;
  console.log('player:', e?.firstName, e?.lastName, '| entityId:', l.card?.entityId ?? l.entityId ?? 'n/a');
  console.log('rarity:', l.card?.boostInfo?.rarityLabel, '| bid:', l.currentBidAmount, '| buy:', l.buyNowPrice);
}
