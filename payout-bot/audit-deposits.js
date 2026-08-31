// audit-deposits.js — check auction history for every confirmed casino deposit
// node audit-deposits.js

const EDGEBOT_USER   = 'V3yGgkkJ';
const RS_DEVICE_UUID = '310a20be-9ef8-4ee0-802f-5b1cffb5dd5e';
const AUTH_INFO      = process.env.RS_AUTH_INFO || 'V3yGgkkJ!GYZLVnbA!2528a49c-3b07-40a7-9cab-6a9d76232c9f';
const SESSION_TOKEN  = process.env.RS_SESSION   || 'baae579b51cff205';

function headers() {
  return {
    'Accept':             'application/json',
    'real-auth-info':     AUTH_INFO,
    'real-session-token': SESSION_TOKEN,
    'real-device-uuid':   RS_DEVICE_UUID,
    'real-device-type':   'desktop_web',
    'real-version':       '36',
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
    return { ok: true, found: !!match, match, count: history.length };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function main() {
  // Hardcoded from D1 query — all confirmed deposits for johnnyjohnson + mattlau
  const rows = [
    // johnnyjohnson
    { id:491, card_id:171072445, rax_requested:20000, rax_credited:18000, rs_username:'johnnjohnson', created:'2026-08-31 00:15:08' },
    { id:490, card_id:172104810, rax_requested:20000, rax_credited:18000, rs_username:'johnnjohnson', created:'2026-08-31 00:04:07' },
    { id:485, card_id:170995755, rax_requested:20000, rax_credited:18000, rs_username:'johnnjohnson', created:'2026-08-30 23:57:18' },
    { id:483, card_id:171072445, rax_requested:10000, rax_credited:9000,  rs_username:'johnnjohnson', created:'2026-08-30 23:47:11' },
    { id:479, card_id:170306902, rax_requested:20000, rax_credited:18000, rs_username:'johnnjohnson', created:'2026-08-30 23:37:58' },
    { id:472, card_id:152916061, rax_requested:20000, rax_credited:18000, rs_username:'johnnjohnson', created:'2026-08-30 23:12:02' },
    { id:461, card_id:147526354, rax_requested:10000, rax_credited:9000,  rs_username:'johnnjohnson', created:'2026-08-30 22:44:27' },
    // mattlau
    { id:499, card_id:178550190, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-31 00:42:30' },
    { id:290, card_id:172506346, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 08:34:32' },
    { id:289, card_id:172420906, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 08:29:07' },
    { id:288, card_id:171920315, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 08:26:20' },
    { id:287, card_id:169253814, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 08:11:13' },
    { id:286, card_id:169107632, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 08:04:31' },
    { id:285, card_id:167024256, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 07:56:41' },
    { id:284, card_id:166687547, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 07:50:39' },
    { id:283, card_id:166622355, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 07:41:44' },
    { id:273, card_id:151386970, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 06:42:35' },
    { id:269, card_id:147362739, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 06:39:37' },
    { id:268, card_id:145819643, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 06:36:38' },
    { id:266, card_id:145326700, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 06:33:36' },
    { id:265, card_id:144988639, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 06:30:38' },
    { id:264, card_id:144985730, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 06:28:35' },
    { id:262, card_id:143689229, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 06:14:18' },
    { id:261, card_id:142252719, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 05:41:07' },
    { id:225, card_id:135959253, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 03:09:24' },
    { id:218, card_id:134671572, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 02:59:29' },
    { id:198, card_id:225046386, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 02:36:37' },
    { id:196, card_id:223719626, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 02:34:07' },
    { id:193, card_id:194494000, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 02:31:57' },
    { id:186, card_id:205221029, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 02:25:06' },
    { id:183, card_id:194494000, rax_requested:1000,  rax_credited:900,   rs_username:'mattlau', created:'2026-08-30 02:25:00' },
    { id:182, card_id:177661481, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 02:24:46' },
    { id:178, card_id:198359331, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 02:22:09' },
    { id:176, card_id:177661481, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 02:21:33' },
    { id:169, card_id:151756600, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 02:15:30' },
    { id:164, card_id:188628221, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 02:10:36' },
    { id:159, card_id:182100932, rax_requested:20000, rax_credited:18000, rs_username:'mattlau', created:'2026-08-30 02:07:43' },
    { id:149, card_id:173029694, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 02:00:55' },
    { id:128, card_id:155544342, rax_requested:10000, rax_credited:9000,  rs_username:'mattlau', created:'2026-08-30 01:53:43' },
  ];

  console.log(`\nAuditing ${rows.length} confirmed deposits...\n`);

  const fraud   = [];
  const legit   = [];
  const errors  = [];
  const dupeCards = {};

  // track duplicate card_ids
  for (const r of rows) {
    if (!dupeCards[r.card_id]) dupeCards[r.card_id] = [];
    dupeCards[r.card_id].push(r.id);
  }

  for (const row of rows) {
    const rsUsername = row.rs_username;
    const isDupe = dupeCards[row.card_id].length > 1 ? ` ⚠ DUPE CARD (also dep ${dupeCards[row.card_id].filter(i => i !== row.id).join(',')})` : '';
    process.stdout.write(`dep ${row.id}  card ${row.card_id}  ${row.rax_requested} Rax  @${rsUsername}${isDupe} ... `);

    const result = await checkAuction(row.card_id, rsUsername, row.rax_requested);
    await new Promise(r => setTimeout(r, 300)); // gentle rate limit

    if (!result.ok) {
      console.log(`ERROR: ${result.reason}`);
      errors.push({ ...row, error: result.reason });
    } else if (result.found) {
      console.log(`✅ PAID (${result.match?.amount ?? '?'} Rax)`);
      legit.push(row);
    } else {
      console.log(`❌ NO AUCTION HISTORY (${result.count} trades found for other amounts)`);
      fraud.push(row);
    }
  }

  console.log('\n─────────────────────────────────────────────');
  console.log(`✅ Legitimate: ${legit.length}`);
  console.log(`❌ No auction history (suspicious): ${fraud.length}`);
  console.log(`⚠  Errors: ${errors.length}`);

  if (fraud.length) {
    console.log('\nSuspicious deposits (no matching auction trade):');
    for (const r of fraud) {
      console.log(`  dep ${r.id}  card ${r.card_id}  credited ${r.rax_credited}  @${r.rs_username}  ${r.created}`);
    }
    const totalOverCredited = fraud.reduce((s, r) => s + (r.rax_credited || 0), 0);
    console.log(`\nTotal over-credited (suspicious): ${totalOverCredited.toLocaleString()} Rax`);
  }

  const dupes = Object.entries(dupeCards).filter(([, ids]) => ids.length > 1);
  if (dupes.length) {
    console.log('\nDuplicate card_ids (same card used in multiple deposits):');
    for (const [cardId, ids] of dupes) {
      console.log(`  card ${cardId} → deposits ${ids.join(', ')}`);
    }
  }
}

main().catch(console.error);
