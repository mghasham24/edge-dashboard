// audit-mattlau.js — check all 33 mattlau confirmed deposits against RS auction history
// node audit-mattlau.js

const EDGEBOT_USER   = 'V3yGgkkJ';
const RS_DEVICE_UUID = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';
const AUTH_INFO      = process.env.RS_AUTH_INFO || 'V3yGgkkJ!GYZLVnbA!2528a49c-3b07-40a7-9cab-6a9d76232c9f';
const SESSION_TOKEN  = process.env.RS_SESSION   || '8faf0144d80523d2';

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

function headers() {
  return {
    'Accept':             'application/json',
    'Origin':             'https://www.realapp.com',
    'Referer':            'https://www.realapp.com/',
    'real-auth-info':     AUTH_INFO,
    'real-session-token': SESSION_TOKEN,
    'real-device-uuid':   RS_DEVICE_UUID,
    'real-device-type':   'desktop_web',
    'real-version':       '36',
    'real-request-token': hashidsEncode(Date.now()),
  };
}

async function checkAuction(cardId, rsUsername, raxRequested) {
  try {
    const url = `https://web.realapp.com/cardauctionhistory/${cardId}`;
    const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const data = await res.json();
    const history = Array.isArray(data?.auctionHistory) ? data.auctionHistory : [];
    const match = history.find(entry => {
      const buyer  = (entry.user?.userName || '').toLowerCase();
      const seller = entry.from?.user?.id;
      if (buyer !== rsUsername.toLowerCase() || seller !== EDGEBOT_USER) return false;
      const amt = parseInt(String(entry.amountDisplay || '').replace(/,/g, ''), 10);
      return amt > 0 && amt >= raxRequested * 0.9 && amt <= raxRequested * 1.1;
    });
    const paidAmt = match ? parseInt(String(match.amountDisplay || '').replace(/,/g, ''), 10) : null;
    return { ok: true, found: !!match, paidAmt, tradeCount: history.length };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function main() {
  // All 33 confirmed mattlau deposits from D1 (queried 2026-08-30)
  const rows = [
    { id:507, card_id:181314142, rax_requested:10000, rax_credited:9000  },
    { id:499, card_id:178550190, rax_requested:10000, rax_credited:9000  },
    { id:290, card_id:172506346, rax_requested:10000, rax_credited:9000  },
    { id:289, card_id:172420906, rax_requested:10000, rax_credited:9000  },
    { id:288, card_id:171920315, rax_requested:10000, rax_credited:9000  },
    { id:287, card_id:169253814, rax_requested:10000, rax_credited:9000  },
    { id:286, card_id:169107632, rax_requested:10000, rax_credited:9000  },
    { id:285, card_id:167024256, rax_requested:10000, rax_credited:9000  },
    { id:284, card_id:166687547, rax_requested:10000, rax_credited:9000  },
    { id:283, card_id:166622355, rax_requested:10000, rax_credited:9000  },
    { id:273, card_id:151386970, rax_requested:10000, rax_credited:9000  },
    { id:269, card_id:147362739, rax_requested:10000, rax_credited:9000  },
    { id:268, card_id:145819643, rax_requested:10000, rax_credited:9000  },
    { id:266, card_id:145326700, rax_requested:10000, rax_credited:9000  },
    { id:265, card_id:144988639, rax_requested:10000, rax_credited:9000  },
    { id:264, card_id:144985730, rax_requested:10000, rax_credited:9000  },
    { id:262, card_id:143689229, rax_requested:10000, rax_credited:9000  },
    { id:261, card_id:142252719, rax_requested:10000, rax_credited:9000  },
    { id:225, card_id:135959253, rax_requested:10000, rax_credited:9000  },
    { id:218, card_id:134671572, rax_requested:10000, rax_credited:9000  },
    { id:198, card_id:225046386, rax_requested:10000, rax_credited:9000  },
    { id:196, card_id:223719626, rax_requested:10000, rax_credited:9000  },
    { id:193, card_id:194494000, rax_requested:10000, rax_credited:9000  },
    { id:186, card_id:205221029, rax_requested:10000, rax_credited:9000  },
    { id:183, card_id:194494000, rax_requested:1000,  rax_credited:900   },
    { id:182, card_id:177661481, rax_requested:10000, rax_credited:9000  },
    { id:178, card_id:198359331, rax_requested:10000, rax_credited:9000  },
    { id:176, card_id:177661481, rax_requested:10000, rax_credited:9000  },
    { id:169, card_id:151756600, rax_requested:10000, rax_credited:9000  },
    { id:164, card_id:188628221, rax_requested:10000, rax_credited:9000  },
    { id:159, card_id:182100932, rax_requested:20000, rax_credited:18000 },
    { id:149, card_id:173029694, rax_requested:10000, rax_credited:9000  },
    { id:128, card_id:155544342, rax_requested:10000, rax_credited:9000  },
  ];

  // flag duplicate card_ids
  const cardCounts = {};
  for (const r of rows) cardCounts[r.card_id] = (cardCounts[r.card_id] || 0) + 1;

  console.log(`\nAuditing ${rows.length} mattlau deposits against RS auction history...\n`);

  const legit = [], suspicious = [], errors = [];

  for (const row of rows) {
    const dupe = cardCounts[row.card_id] > 1 ? ' [DUPE CARD]' : '';
    process.stdout.write(`dep ${row.id}  card ${row.card_id}  ${row.rax_requested.toLocaleString()} Rax${dupe} ... `);

    const result = await checkAuction(row.card_id, 'mattlau', row.rax_requested);
    await new Promise(r => setTimeout(r, 300));

    if (!result.ok) {
      console.log(`ERROR: ${result.reason}`);
      errors.push({ ...row, error: result.reason });
    } else if (result.found) {
      console.log(`OK  paid ${result.paidAmt?.toLocaleString()} Rax  (${result.tradeCount} trades on card)`);
      legit.push({ ...row, paidAmt: result.paidAmt });
    } else {
      console.log(`SUSPICIOUS  no matching trade  (${result.tradeCount} trades on card)`);
      suspicious.push(row);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`LEGIT:      ${legit.length}`);
  console.log(`SUSPICIOUS: ${suspicious.length}`);
  console.log(`ERRORS:     ${errors.length}`);

  if (suspicious.length) {
    console.log('\nSUSPICIOUS (no matching auction trade from mattlau -> edgebot):');
    let total = 0;
    for (const r of suspicious) {
      console.log(`  dep ${r.id}  card ${r.card_id}  credited ${r.rax_credited.toLocaleString()} Rax`);
      total += r.rax_credited;
    }
    console.log(`  Total over-credited: ${total.toLocaleString()} Rax`);
  }

  const dupes = Object.entries(cardCounts).filter(([,c]) => c > 1);
  if (dupes.length) {
    console.log('\nDUPLICATE CARDS (same card used in multiple deposits):');
    for (const [cardId, count] of dupes) {
      const ids = rows.filter(r => r.card_id === Number(cardId)).map(r => r.id).join(', ');
      console.log(`  card ${cardId} used ${count}x in deps ${ids}`);
    }
  }
}

main().catch(console.error);
