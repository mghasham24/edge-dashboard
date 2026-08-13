// node marketplace-scanner/probe-hash.mjs
// Finds which hashids minLen produces the URL hash RS uses for listing links

function hashidsEncode(number, minLen, salt = 'realwebapp') {
  const saltChars = Array.from(salt);
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

// Known: card 236285222 → dvhrFgFRVRm84
const TARGET_HASH = 'dvhrFgFRVRm84';
const LISTING_ID  = 236285222;

const SALTS = [
  'realsports', 'realsports.io', 'realapp', 'real', 'real_app',
  'RealSports', 'RealApp', 'REAL', 'rs', 'realwebapp2',
  'marketplace', 'listing', 'card', 'cards', 'rs_marketplace',
  'realsportsio', 'rsx', 'real_sports', 'raxedge', '',
];

console.log(`Cracking salt for: ${LISTING_ID} → ${TARGET_HASH}\n`);
let found = false;
for (const salt of SALTS) {
  for (const ml of [0, 13]) {
    const h = hashidsEncode(LISTING_ID, ml, salt);
    if (h === TARGET_HASH) {
      console.log(`✅ FOUND! salt="${salt}" minLen=${ml}`);
      found = true;
    }
  }
}
if (!found) console.log('No match found. Try adding more salts.');
