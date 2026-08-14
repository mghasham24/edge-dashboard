// vps-dk-proxy/index.js
// Runs on the Hetzner VPS (port 3003). Proxies:
//   1. DK MMA API calls blocked by DK's WAF from CF Worker IPs (via residential proxy)
//   2. ESPN WNBA scoreboard + summary calls blocked from CF Worker IPs (direct VPS fetch)
//
// Required env: DK_PROXY_KEY — shared secret checked on every request
// Optional env: PROXY_URL    — residential proxy e.g. http://user:pass@host:port (DK only)

import http from 'http';
import { URL } from 'url';
import { fetch, ProxyAgent } from 'undici';

const PORT      = parseInt(process.env.PORT || '3003');
const SECRET    = process.env.DK_PROXY_KEY;
const PROXY_URL = process.env.PROXY_URL;
const DK_BASE   = 'https://sportsbook-nash.draftkings.com/sites/US-SB/api/sportscontent';
const ESPN_WNBA = 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba';
const ESPN_NFL  = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';

if (!SECRET) { console.error('DK_PROXY_KEY env var required'); process.exit(1); }

const DK_HEADERS = {
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6.1 Safari/605.1.15',
  'Origin':          'https://sportsbook.draftkings.com',
  'Referer':         'https://sportsbook.draftkings.com/',
};

const ESPN_HEADERS = {
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Referer':         'https://www.espn.com/',
  'Origin':          'https://www.espn.com',
};

const proxyDispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;

function dkUrl(league, subcat) {
  return `${DK_BASE}/controldata/league/leagueSubcategory/v1/markets?isBatchable=false` +
    `&templateVars=${league}` +
    `&eventsQuery=%24filter%3DleagueId%20eq%20%27${league}%27%20AND%20clientMetadata%2FSubcategories%2Fany%28s%3A%20s%2FId%20eq%20%27${subcat}%27%29` +
    `&marketsQuery=%24filter%3DclientMetadata%2FsubCategoryId%20eq%20%27${subcat}%27%20AND%20tags%2Fall%28t%3A%20t%20ne%20%27SportcastBetBuilder%27%29` +
    `&include=Events&entity=events`;
}

const server = http.createServer(async (req, res) => {
  const url  = new URL(req.url, `http://localhost:${PORT}`);
  const key  = url.searchParams.get('key');

  if (key !== SECRET) { res.writeHead(403); res.end('Unauthorized'); return; }

  // ── DK MMA proxy ──────────────────────────────────────────────────────────
  if (url.pathname === '/dk-mma') {
    const league = url.searchParams.get('league');
    const subcat = url.searchParams.get('subcat') || '13025';
    if (!league) { res.writeHead(400); res.end('Missing league param'); return; }
    try {
      const fetchOpts = { headers: DK_HEADERS, signal: AbortSignal.timeout(10000) };
      if (proxyDispatcher) fetchOpts.dispatcher = proxyDispatcher;
      const dkRes = await fetch(dkUrl(league, subcat), fetchOpts);
      const body  = await dkRes.text();
      res.writeHead(dkRes.status, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── ESPN WNBA scoreboard ───────────────────────────────────────────────────
  // GET /espn-wnba/scoreboard?dates=YYYYMMDD&key=SECRET
  if (url.pathname === '/espn-wnba/scoreboard') {
    const dates = url.searchParams.get('dates');
    if (!dates) { res.writeHead(400); res.end('Missing dates param'); return; }
    try {
      const espnRes = await fetch(
        `${ESPN_WNBA}/scoreboard?dates=${dates}`,
        { headers: ESPN_HEADERS, signal: AbortSignal.timeout(10000) }
      );
      const body = await espnRes.text();
      res.writeHead(espnRes.status, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── ESPN NFL scoreboard ────────────────────────────────────────────────────
  // GET /espn-nfl/scoreboard?dates=YYYYMMDD[&seasontype=1]&key=SECRET
  if (url.pathname === '/espn-nfl/scoreboard') {
    const dates      = url.searchParams.get('dates');
    const seasontype = url.searchParams.get('seasontype');
    if (!dates) { res.writeHead(400); res.end('Missing dates param'); return; }
    const espnUrl = `${ESPN_NFL}/scoreboard?dates=${dates}${seasontype ? `&seasontype=${seasontype}` : ''}`;
    try {
      const espnRes = await fetch(espnUrl, { headers: ESPN_HEADERS, signal: AbortSignal.timeout(10000) });
      const body = await espnRes.text();
      res.writeHead(espnRes.status, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── ESPN WNBA game summary ─────────────────────────────────────────────────
  // GET /espn-wnba/summary?event=ID&key=SECRET
  if (url.pathname === '/espn-wnba/summary') {
    const event = url.searchParams.get('event');
    if (!event) { res.writeHead(400); res.end('Missing event param'); return; }
    try {
      const espnRes = await fetch(
        `${ESPN_WNBA}/summary?event=${event}`,
        { headers: ESPN_HEADERS, signal: AbortSignal.timeout(10000) }
      );
      const body = await espnRes.text();
      res.writeHead(espnRes.status, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`DK+ESPN proxy listening on :${PORT}${PROXY_URL ? ' (residential proxy active)' : ''}`));
