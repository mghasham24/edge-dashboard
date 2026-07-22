// functions/_lib/hashids.js
// hashidsEncode: single-number encode with 'realwebapp' salt (used for real-request-token header)
// rsUrlEncode: 4-number encode with 'routing' salt (used for RS page URLs)

// Encodes [routeType, sportCode, section, entityId] into an RS page URL hash.
// salt='routing', minLen=11. Verified against live RS URLs.
export function rsUrlEncode(routeType, sportCode, section, id) {
  const saltChars = Array.from('routing');
  const minLen = 11;
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
    const res=[]; let v=n;
    do { res.unshift(alpha[v%alpha.length]); v=Math.floor(v/alpha.length); } while(v>0);
    return res;
  }
  let alpha = Array.from('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890');
  let seps  = Array.from('cfhistuCFHISTU');
  const uniq = [...new Set(alpha)];
  alpha = uniq.filter(c => !seps.includes(c));
  seps  = shuffle(seps.filter(c => uniq.includes(c)), saltChars);
  if (!seps.length || alpha.length/seps.length > 3.5) {
    const sl = Math.ceil(alpha.length/3.5);
    if (sl > seps.length) { seps.push(...alpha.slice(0,sl-seps.length)); alpha=alpha.slice(sl-seps.length); }
  }
  alpha = shuffle(alpha, saltChars);
  const gc = Math.ceil(alpha.length/12);
  let guards;
  if (alpha.length < 3) { guards = seps.splice(0, gc); }
  else { guards = alpha.splice(0, gc); }
  const nums = [routeType, sportCode, section, id];
  const numId = nums.reduce((s, n, i) => s + n % (i + 100), 0);
  const lottery = [alpha[numId % alpha.length]];
  let ret = lottery.slice();
  for (let i = 0; i < nums.length; i++) {
    alpha = shuffle(alpha.slice(), lottery.concat(saltChars, alpha));
    const encoded = toAlpha(nums[i], alpha);
    ret.push(...encoded);
    if (i + 1 < nums.length) {
      const p = encoded[0].codePointAt(0) + i;
      ret.push(seps[nums[i] % p % seps.length]);
    }
  }
  if (ret.length < minLen) ret.unshift(guards[(numId + ret[0].codePointAt(0)) % guards.length]);
  if (ret.length < minLen) ret.push(guards[(numId + ret[2].codePointAt(0)) % guards.length]);
  const half = Math.floor(alpha.length / 2);
  while (ret.length < minLen) {
    alpha = shuffle(alpha.slice(), alpha);
    ret = [...alpha.slice(half), ...ret, ...alpha.slice(0, half)];
    const ex = ret.length - minLen;
    if (ex > 0) ret = ret.slice(Math.floor(ex/2), Math.floor(ex/2) + minLen);
  }
  return ret.join('');
}

// Encodes a number using the Real Sports 'realwebapp' Hashids config.
// Used for the real-request-token header on all RS API calls.
export function hashidsEncode(number) {
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
