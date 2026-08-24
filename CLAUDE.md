# RaxEdge — Claude Context

## Project Type
Cloudflare Pages (static frontend) + Cloudflare Functions (API) + D1 (SQLite) + Workers (cron).

## Stack
- **Frontend**: Three-file SPA — `index.html` (shell + script tags), `app.js` (~8k+ lines, all JS), `app.css` (~2.3k lines, all CSS).
- **API**: `functions/api/` — Cloudflare Pages Functions (ES modules, `onRequest` / `onRequestGet` export).
- **Shared helpers**: `functions/_lib/` — `auth.js`, `session.js`, `password.js`, `stripe.js`, `response.js`, `rateLimit.js`, `hashids.js`, `blockedDomains.js`.
- **Database**: Cloudflare D1 (`edge-db`, id `ff9b93f1-81f8-4370-bd57-f634e0300443`). Schema in `migrations/0001_initial.sql`.
- **Billing**: Stripe subscriptions via `functions/api/stripe/webhook.js`.
- **Email**: Resend — `functions/api/auth/register.js` and `forgot.js`.
- **Alerts**: Telegram bot via `workers/alert-cron/` — separate Cloudflare Worker, deployed independently with `npx wrangler deploy` from that directory.
- **Odds**: Native FD/DK API fetches for all sports except UFC. Odds API (`api.the-odds-api.com`) only for UFC.
- **Error tracking**: PostHog — global `error` + `unhandledrejection` handlers in `app.js`.

## Key Files
| Path | Purpose |
|---|---|
| `index.html` | SPA shell — loads app.css + app.js, auth gate markup |
| `app.js` | All frontend JS — sport tabs, EV logic, settings, admin panel |
| `app.css` | All frontend CSS |
| `functions/api/_middleware.js` | Auth + plan enforcement on all `/api/` routes |
| `functions/api/real/sync.js` | RS native sync — fetches Real Sports market probabilities |
| `functions/api/real/connect.js` | GET/POST/DELETE RS auth connection (per-user token or username) |
| `functions/api/real/markets.js` | RS market data for portfolio |
| `functions/api/real/portfolio.js` | RS portfolio positions |
| `functions/api/real/public.js` | Unauthenticated RS public position lookup |
| `functions/api/fd/nbaalts.js` | FD NBA spread/ML/total odds (native) |
| `functions/api/fd/wnbaalts.js` | FD WNBA spread/ML/total odds (native) |
| `functions/api/fd/nhl.js` | FD NHL odds (native) |
| `functions/api/fd/mlb.js` | FD MLB odds — parallelized with Promise.all + 5s AbortController timeout per game |
| `functions/api/fd/fc.js` | DK soccer alt handicap odds for FC tab (subcat 13170). DK league IDs: EPL=40253, La Liga=40031, Serie A=40030, Ligue 1=40032, Bundesliga=40481 |
| `functions/api/fd/rfi.js` | FD RFI (run first innings) odds |
| `functions/api/dk/nbaalts.js` | DK NBA alt lines |
| `functions/api/dk/nhalalts.js` | DK NHL alt lines |
| `functions/api/dk/mlb-props.js` | DK MLB player props (hits, total bases, RBIs, etc.) — groups O/U per player, stores `awayShort`/`homeShort` for correct event_name on slips |
| `functions/api/dk/wnba-props.js` | DK WNBA player props |
| `functions/api/dk/wnba-lines.js` | DK WNBA spread/ML/total |
| `functions/api/dk/nfl-lines.js` | DK NFL spread/ML/total |
| `functions/api/dk/mlb-lines.js` | DK MLB spread/ML/total |
| `functions/api/dk/soccer-props.js` | DK soccer player props |
| `functions/api/odds.js` | Odds API proxy — UFC only, with D1 caching and day-of-week block |
| `functions/api/stripe/webhook.js` | All Stripe billing events |
| `functions/api/stripe/checkout.js` | Stripe checkout session creation |
| `functions/api/stripe/portal.js` | Stripe billing portal |
| `functions/api/auth/` | Login, register, forgot-password, reset |
| `functions/api/admin/users.js` | Admin user management |
| `functions/api/admin/stats.js` | Admin dashboard stats |
| `functions/api/bets/taken.js` | Track bets taken by user (capped at 1000) |
| `functions/api/real/game-ids.js` | Returns RS game IDs from D1 sync cache — used by My Slips to show RS icon on legs |
| `functions/api/parlays/place.js` | Place a parlay slip — validates legs, deducts deposit, creates `parlays` + `parlay_legs` rows. Free play path: `is_free_play=1`, no deposit, payout capped at 3000 Rax |
| `functions/api/parlays/my-slips.js` | Returns user's slips + legs + `free_play_credits` balance |
| `functions/api/parlays/auto-settle.js` | Cron-triggered leg settler — MLB (statsapi), WNBA (ESPN), soccer (ESPN). Soccer name normalization: prefix match + last-name fallback for DK vs ESPN name differences |
| `functions/api/parlays/payout.js` | Payout bot — accepts RS offers on winning slips. Reads `EDGEBOT_AUTH_INFO` + `EDGEBOT_SESSION_TOKEN` CF env vars |
| `functions/api/parlays/deposit-check.js` | Verifies RS deposit arrived, marks slip active. Tracks cumulative stake for referral reward at 2k |
| `functions/api/parlays/rs-verify.js` | RS username verification — links RS account to user, records referredBy, DMs referrer |
| `functions/api/parlays/rs-verify-poll.js` | Polls RS verify status, solves captcha via `CAPSOLVER_API_KEY` |
| `functions/api/parlays/win-notify.js` | Sends winning slip Telegram notification, solves captcha |
| `functions/api/parlays/cancel.js` | Cancels a pending slip and refunds deposit |
| `functions/api/parlays/settle.js` | Admin manual settle endpoint |
| `functions/api/parlays/payout-queue.js` | Admin view of payout queue |
| `functions/api/parlays/leaderboard.js` | Public parlay leaderboard |
| `functions/api/parlays/all-slips.js` | Admin view of all slips |
| `functions/api/parlays/market-buy.js` | RS market buy for payout flow |
| `functions/api/parlays/offer-history.js` | RS offer history for payout tracking |
| `functions/api/parlays/sync-cards.js` | Syncs RS card inventory for payout bot |
| `functions/api/parlays/card-reconcile.js` | Reconciles payout card state |
| `functions/api/parlays/player-rs-ids.js` | Maps player names to RS player IDs |
| `functions/api/parlays/wnba-settle.js` | WNBA-specific settle logic |
| `functions/api/parlays/contender-series.js` | Contender series parlay support |
| `functions/api/alerts/settings.js` | Telegram alert preferences |
| `functions/api/alerts/connect.js` | Telegram connection/verify |
| `workers/alert-cron/index.js` | Telegram bet alert cron — runs every 60s on Cloudflare |
| `workers/rs-poster/` | Dead CF Worker (DO NOT redeploy — deleted from CF dashboard, was 401-ing every minute) |
| `rs-poster-node/index.js` | Local Node.js RS group auto-poster — runs on Mac via LaunchAgent, polls RS open positions, posts to RS group 61979. Token refreshed by Tampermonkey bridge on port 27182. Currently STOPPED (rate-limited). |
| `vps-scanner/index.js` | Hetzner VPS auction scanner — scans RS FC player card auction for target players (dimarco, mckennie, locatelli, grimaldo) below max price 100. Receives live RS tokens pushed by Tampermonkey every 30s. Sends Telegram alerts directly via TG_TOKEN env var on the VPS. |
| `tampermonkey-auction-alert.user.js` | Browser userscript (install in Tampermonkey on realsports.io). Detects FC auction listings, queues Telegram alerts, pushes live RS auth tokens to VPS scanner at 178.156.194.254:3001. NOTE: the CF relay endpoint (`/api/auction/alert`) was deleted — Telegram alerts now go through vps-scanner only. |
| `tampermonkey-rs-poster.user.js` | Browser-based RS auto-poster — polls RS open positions every 60s from within the browser (realsports.io tab) and posts new ones to RS group 61979. Alternative to rs-poster-node when running in browser. |
| `tampermonkey-rs-token.js` | Pushes user's live RS auth token to `/api/admin/rs-token?key=RS_TOKEN_SECRET` silently whenever they use RS. Used to keep the shared `RS_AUTH_TOKEN` fresh without manual rotation. |
| `tampermonkey-token-bridge.user.js` | Pushes RS auth token every 30s + full market data every 4min to RaxEdge. TOKEN_URL = `/api/admin/rs-token?key=rax-bridge-9w2k5j7n`, SYNC_URL = `/api/real/sync?_tm_key=rax-bridge-9w2k5j7n`. |
| `functions/api/admin/rs-token.js` | POST: receives RS token from TM bridge, stores in D1 as `odds_cache` key `meta:rs_auth_token`. GET: retrieves stored token. Protected by `RS_TOKEN_SECRET` env var or `TM_PUSH_KEY` (currently hardcoded `rax-bridge-9w2k5j7n`). |
| `chrome.css` | Minimal shared CSS for standalone pages: `reset.html`, `terms.html`, `privacy.html`. Not the main app CSS. |
| `sw.js` | PWA service worker — app-shell cache, offline fallback. |
| `tests/webhook.test.js` | Vitest test suite for Stripe webhook handler (12 tests). Run with `npx vitest`. |
| `migrations/0001_initial.sql` | Full D1 schema snapshot — use to recreate DB from scratch |
| `migrations/0002_parlays.sql` | `parlays`, `parlay_legs`, `payout_queue` tables |
| `migrations/0003_rs_verify.sql` | RS username + verify columns on users |
| `migrations/0004_verified_at.sql` | `verified_at` timestamp on users |
| `migrations/0005_skipped_cards.sql` | `skipped_cards` on payout_queue for card cycling |
| `migrations/0006_free_play.sql` | `free_play_credits`, `parlay_referred_by_id`, `parlay_referral_rewarded` on users; `is_free_play` on parlays |
| `migrations/0007_rs_game_id.sql` | RS game ID storage for slip RS icon |

## Sports Model
| Sport | Key | Free? | Source | Notes |
|---|---|---|---|---|
| NBA | `basketball_nba` | ✅ Free | FD native | |
| NHL | `icehockey_nhl` | ✅ Free | FD native | |
| MLB | `baseball_mlb` | ✅ Free | FD native | Parallelized fetches — was timing out CF's 30s wall clock |
| WNBA | `basketball_wnba` | Pro only | FD native | |
| FC (soccer) | `soccer_fc` | Pro only | DK native | **EV direction inverted** — see below |
| UFC | `mma_mixed_martial_arts` | Pro only | Odds API | Server-side blocked Mon–Fri UTC |

`FREE_PLAN_SPORTS` constant in `real/sync.js` is the authoritative list of free sports.

### FC Tab EV Direction (CRITICAL — inverted from all other sports)
- **All other sports**: users bet at FD. GREEN = RS prob > FD novig (FD underprices vs RS).
- **soccer_fc**: users bet at RS. GREEN = DK novig > RS novig (RS offers longer odds than DK fair = value at RS).
- Formula: `edge = (af - pred)`, `EV = (af/pred * (1-rake)) - 1`
- Always preserve the `currentSport === 'soccer_fc'` checks in all edge/EV paths.

## Deleted / Removed (do not recreate)
- `auction-scanner/` — CF-based auction scanner, removed from git. **The directory still exists on disk** with leftover files (`seen-ids.json`, `auth-state.json`, etc.) but is not tracked or deployed. The `vps-scanner/` on Hetzner handles this now.
- `functions/api/auction/alert.js` — CF relay endpoint for TM script Telegram alerts, deleted with auction-scanner. TM script's ALERT_URL now 404s — alerts go through vps-scanner directly.
- `workers/rs-poster` CF Worker — deleted from Cloudflare dashboard. Local `rs-poster-node/` on Mac is the replacement.
- **Railway** — a Railway service called `edge-dashboard` was connected to the GitHub repo and appears as failing checks on PRs. It was deleted. The 3/4 check status on GitHub is Railway noise — ignore it. Cloudflare Pages is the only real deployment.

## Pricing
- **Monthly**: $4.99/mo (14-day free trial for new users)
- **Annual**: $39/yr (no trial)
- Stripe price IDs: monthly = `env.STRIPE_MONTHLY_PRICE_ID`, annual = `env.STRIPE_ANNUAL_PRICE_ID`
- Trial eligibility: `users.had_free_trial = 0` — set to 1 on first checkout, blocks second trial

## Working With Claude
- **Ask clarifying questions** when a request is ambiguous rather than inferring and acting. User explicitly wants this.
- **Never cite Odds API credits** for FD/DK fetch decisions — those are native calls, zero cost. Only cite Odds API for UFC.
- **Push staging first** (`git push origin main:staging`), then explicitly push main when user says so.

## Deploy Conventions
- **Always push to `origin main:staging` first** — never push directly to `origin/main` without explicit user confirmation.
- Exception: user says "push main" → push to `origin main` directly.
- **`workers/alert-cron`** must be deployed separately: `cd workers/alert-cron && npx wrangler deploy`. A git push alone does NOT deploy it.
- **Never push alert-cron changes to `origin/main`** without explicit instruction — it fires real Telegram messages every minute.
- **`workers/rs-poster`** — local files remain but the CF Worker was deleted from Cloudflare dashboard. Do not redeploy it.

## Auth & Plan Model
- Sessions: `sessions` table, token in cookie (`session=`), 30-day expiry.
- Plans: `users.plan` = `'free'` | `'pro'`. `users.pro_expires_at` (unix) set from Stripe `current_period_end`.
- Promo gate: `FREE_PROMO_END` env var (or hardcoded fallback) in `_middleware.js`, `sync.js`, and `app.js`. Past date = dormant. Update all three + deploy to activate.
- Admin users (`is_admin=1`) bypass all plan gates and the UFC day-of-week block.
- `getSessionOrCron()` in `_lib/auth.js` — used by all endpoints that accept both session cookies AND cron key. Cron key passed as `?_cron_key=` query param matching `env.CRON_SECRET`.

## Stripe Billing Rules
- Only downgrade users on `customer.subscription.deleted` — never on `invoice.payment_failed` (Stripe dunning retries).
- Webhook delivery order not guaranteed — don't rely on `subscription.created` arriving before `checkout.session.completed`.
- Idempotency: `processed_webhook_events` table prevents double-processing.
- Referral rewards: atomic decrement + draft status guard to prevent race conditions.

## Required Cloudflare Env Vars
| Var | Used by |
|---|---|
| `RS_AUTH_TOKEN` | `real/sync.js` — shared RS token for Best EV. If Best EV empty across all sports, check this first. |
| `CRON_SECRET` | `alert-cron`, all `/api/real/sync` and odds cron calls via `?_cron_key=` |
| `TM_PUSH_KEY` | TM token bridge key — currently hardcoded `rax-bridge-9w2k5j7n` in code (audit 2 item to fix) |
| `RS_TOKEN_SECRET` | Admin-only key for `/api/admin/rs-token` GET endpoint |
| `SITE_URL` | `alert-cron` — e.g. `https://raxedge.com` |
| `TELEGRAM_BOT_TOKEN` | `alert-cron` — **main betting alerts bot** (CF Worker). Different from vps-scanner's TG bot. |
| `FREE_PROMO_END` | Optional override for promo window |
| `STRIPE_SECRET_KEY` | Stripe API |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification |
| `STRIPE_ANNUAL_PRICE_ID` | Stripe price ID for $39/yr plan |
| `RESEND_API_KEY` | Email (register, forgot) |
| `STRIPE_MONTHLY_PRICE_ID` | Stripe price ID for $4.99/mo plan |
| `EDGEBOT_AUTH_INFO` | Payout bot RS auth (JSON blob) — `payout.js` |
| `EDGEBOT_SESSION_TOKEN` | Payout bot RS session cookie — expires regularly; rotate from RS DevTools → `npx wrangler pages secret put EDGEBOT_SESSION_TOKEN --project-name=edge-dashboard` |
| `CAPSOLVER_API_KEY` | Captcha solver for `rs-verify-poll.js` and `win-notify.js` |

### Two Telegram Bots
- **Main alerts bot** (`TELEGRAM_BOT_TOKEN` in CF Worker `alert-cron`) — sends bet EV alerts to users who connected Telegram in settings.
- **Auction/VPS bot** (`TG_TOKEN` env var on Hetzner VPS) — sends FC auction alerts via `vps-scanner`. AuctionBot (`@RealSAuctionBot`), token rotated 2026-05-13. Completely separate from the main bot.

### RS Token Flow
RS auth token can be sourced two ways:
1. **TM token bridge** (`tampermonkey-token-bridge.user.js`) — pushes token to `/api/admin/rs-token` every 30s while user has RS open in browser. Stored in D1 as `odds_cache` key `meta:rs_auth_token`.
2. **`RS_AUTH_TOKEN` CF env var** — manual fallback. `real/sync.js` checks D1 first, falls back to env var.

**Hetzner VPS is IP-blocked by RS API** — cannot make RS API calls from the VPS directly. That's why:
- `vps-scanner` only hits the public RS auction (not auth-gated RS API)
- `rs-poster-node` runs on Mac (residential IP), not the VPS

## Coding Conventions
- **XSS**: Always use `escHtml()` for any user data in innerHTML. `escHtml()` encodes `<`, `>`, `&`, `"`, `'`. Use `data-*` attributes for passing values into onclick handlers — never interpolate into JS strings.
- **Confirm dialogs**: Use `showConfirm(msg, onYes)` — never `confirm()`. iOS Safari blocks `confirm()`.
- **Parallel fetches**: Use `Promise.all` + `AbortController` with 5s timeout per request for any multi-game fetch. CF workers have a 30s wall-clock limit — sequential loops with delays will timeout on large game slates.
- **Team logos**: `TEAM_LOGO_URLS` in `app.js` keyed by FD/DK team name string, ESPN CDN URLs. WNBA path is `/wnba/500/`, NBA is `/nba/500/`, etc.
- **Team colors**: `TEAM_COLORS` in `app.js` for gradient headers/left bars. Missing team falls back to HSL hash of name.
- **Shared auth**: Import `getSessionOrCron` from `../../_lib/auth.js` — not the old copy-pasted `getSession` pattern.

## Gotchas
- **"Error fetching MLB data" on refresh**: Sequential event-page fetches were hitting CF's 30s wall-clock limit. Fixed with `Promise.all` + 5s AbortController per game. If this recurs on another sport, apply the same pattern.
- **"No games" on free accounts**: `FREE_PLAN_SPORTS` in `sync.js` defines which sports are free. NBA, NHL, MLB are free. WNBA and FC are pro-only. If pro checks get added to free-sport endpoints accidentally, remove them.
- **UFC odds**: Server-side blocked Mon–Fri (`odds.js`) — only fetches Sat/Sun UTC. Admins bypass.
- **RS auth token**: Shared env var `RS_AUTH_TOKEN`. If Best EV shows empty across all sports, check Cloudflare dashboard → Workers & Pages → edge-db project → Settings → Variables.
- **`index.html` / `app.js` are large**: Search for the specific function/class before editing. `isPro()` is defined around line 6916 of `app.js`.
- **Free promo**: `FREE_PROMO_END` appears in 3 places — `_middleware.js`, `real/sync.js`, `app.js`. Update all three to activate.
- **alert-cron timezone**: Uses `Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York' })` — correctly handles EST/EDT automatically.
- **FD/DK fetches cost nothing**: They are native API calls. Never cite "Odds API credits" as a reason to cache or rate-limit FD or DK endpoints.
- **Telegram bot token**: Stored in `TELEGRAM_BOT_TOKEN` env var. Rotate via BotFather if leaked. `workers/alert-cron` reads from `env.TELEGRAM_BOT_TOKEN`.
- **Stripe webhook**: Uses `===` for signature comparison (not constant-time) — known issue, low exploitability, tracked in audit backlog.
- **MLB slip polling date cap (removed v=779)**: There was a cap that forced `game_date` to today for non-soccer legs when the stored date was in the future. This caused tomorrow's game legs to show today's completed boxscore stats. Removed — polling now uses the stored `game_date` directly. If the date's schedule is all Preview, the slip correctly shows Preview and waits.
- **Soccer auto-settle name mismatch**: DK and ESPN use different player names (e.g. "Axel Ojeda" vs "Agustin Ojeda", "Nicolas Fernandez Mercau" vs "Nicolás Fernández"). `auto-settle.js` has prefix-match + last-name fallback after exact lookup fails. If a soccer leg voids unexpectedly, check name normalization first.
- **Soccer leg void rule**: A player who appeared for ≥1 minute (`appearances > 0 || minutesPlayed > 0` in ESPN stats) cannot void — only win or lose. Void is only valid for DNP (never entered).
- **Free play credits**: `users.free_play_credits` column (migration 0006). Admin can set via D1: `UPDATE users SET free_play_credits=N WHERE id=?`. Frontend reads balance from `my-slips.js` response.

## Debugging Playbook
| Symptom | First thing to check |
|---|---|
| Best EV empty on all sports | `RS_AUTH_TOKEN` env var in Cloudflare dashboard |
| "Error fetching [sport] data" on refresh | CF 30s timeout — is the fetch sequential? Parallelize with Promise.all + AbortController |
| Free user sees no data on free sport | Pro check accidentally added to that endpoint — remove it |
| Telegram alerts not sending | `TELEGRAM_BOT_TOKEN` in alert-cron env, or alert-cron not deployed (`wrangler deploy`) |
| Stripe events not updating plan | Check `processed_webhook_events` for duplicates; confirm `subscription.deleted` event fires |
| D1 schema missing table | Run `npx wrangler d1 execute edge-db --remote --file=migrations/0001_initial.sql` |
| MLB slip shows wrong Final game | `game_date` cap was removed in v=779 — if recurring, check `fetchLiveSlipStats` in app.js around the `gdRaw` / `liveToday` comparison |
| Soccer leg voided despite player playing | Check ESPN name vs DK name in `auto-settle.js` `getSoccerPlayerStats` — prefix/last-name fallback may be missing a case |
| Payout bot not accepting offers | Check `EDGEBOT_SESSION_TOKEN` expiry — rotate from RS DevTools Network tab |

## Parlay Ops

### Payout Queue Status
```sql
SELECT id, rs_username, payout_rax, status, attempts,
       (strftime('%s','now') - last_attempt_at) AS secs_since_attempt, notes
FROM payout_queue ORDER BY id DESC LIMIT 20;
```

### Stuck Entry Debug (replace ? with entry id)
```sql
SELECT id, status, attempts, last_attempt_at,
       (strftime('%s','now') - last_attempt_at) AS secs_since_attempt,
       skipped_cards, notes
FROM payout_queue WHERE id=?;
```

### Payout Pause / Unpause
- Check: `SELECT data FROM odds_cache WHERE cache_key='payout:paused_until'`
- Unpause: `GET /api/parlays/payout?_cron_key=CRON_SECRET&unpause=1`
- Manual pause N hours: `GET /api/parlays/payout?_cron_key=CRON_SECRET&pause_hours=24`

### Edgebot Session Token
- `EDGEBOT_SESSION_TOKEN` CF env var. Expires → deposit-check 401 → no offers accepted.
- Rotate: grab `real-session-token` from RS DevTools Network tab → `npx wrangler pages secret put EDGEBOT_SESSION_TOKEN --project-name=edge-dashboard`

### Debug Card Candidates for a Payout Entry
- `GET /api/parlays/payout?_cron_key=CRON_SECRET&debug_cards=RS_USER_HASH_ID`
- Known RS hash IDs: humanshield = `43QN6pjn`, realblackmamba = `R3XE7eQn`

### Clear Stuck Skipped Cards (if all categories exhausted)
```sql
UPDATE payout_queue SET skipped_cards=NULL WHERE id=?;
```

## Audit 1 — Completed (reference only)
All Audit 1 items are done: rate limiting on login/forgot, hashPassword extracted to `_lib/password.js`, annual plan ($39/yr), trial-ending nudge, PWA service worker, `getSession` extracted to `_lib/session.js`, Stripe helpers to `_lib/stripe.js`, index.html split into app.js + app.css, email plaintext alts, BLOCKED_PREFIXES regex, PostHog error tracking, refresh spinner, empty state for 0 EV lines, referral credit race fix, and more. Do not re-suggest these.

## Open Audit Backlog (Audit 2 — 2026-05-12)
Items without ✅ are unfinished. "whats next" = first uncompleted item.

**Critical**
- [ ] PBKDF2 iterations still 100k — `ITERATIONS = 600000`, keep `LEGACY_ITERATIONS = 100000`, rehash on login
- ✅ `/api/real/public.js` has no auth — already fixed, uses `getSession`
- [ ] Stripe webhook not idempotent for referrer reward (double-reward on retry)
- [ ] Webhook signature compare not constant-time (`===`)

**High**
- ✅ `alert-cron` ET offset hardcoded — fixed with `Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York' })`
- [ ] N+1 queries in `admin/stats.js` (14-day loop) and `admin/users.js` (per-user session count)
- [ ] `admin/users.js` PATCH accepts arbitrary plan values (no validation)
- [ ] DELETE `/api/admin/users` doesn't cascade — orphan rows in 9 tables

**Medium**
- [ ] Polling continues when tab hidden — no `visibilitychange` listener
- [ ] `setInterval` chains can leak across sport switches — need `stopAllPollers()` helper
- [ ] `real/sync.js` has 9 debug modes with no admin gate
- [ ] Stripe customer fallback creates wrong match — should create fresh customer
- [ ] `register.js` `generateCode` doesn't retry on collision
- ✅ Cron-key-vs-session preamble — extracted to `_lib/auth.js` as `getSessionOrCron()`
- [ ] `TM_PUSH_KEY` hardcoded in `rs-token.js` — should be `env.TM_PUSH_KEY`
- [ ] `forgot.js` reset URL hardcoded to `https://raxedge.com` (breaks on staging)
- [ ] Login cookie missing `__Host-` prefix
- [ ] Sessions table never garbage-collected — no cron to delete expired rows

**Low**
- [ ] 4 `alert()` calls still in `app.js`
- [ ] Landing page LIVE badge always shows — not wired to real status
- [ ] Landing page advertises NFL/CFB/CBB but those tabs don't exist in dashboard
- [ ] `_routes.json` doesn't include `/ingest/*` for PostHog proxy
- [ ] `admin/cron-debug.js` returns plain text `'Unauthorized'` instead of JSON

## Feature Ideas (not yet built)
- Live NBA scores/quarter/clock from FD event-page API (zero extra requests — data already in response; start with debug=3 on fd/nbaalts.js)
- RS WebSocket payout API for exact EV (`PredictionMarketGetExpectedPayout`, event `wss://web.realsports.io/socket.io/`) — replaces rake approximation; use REAL_AUTH_TOKEN with $10 stake per market
- Slippage-adjusted EV for large RS bets (~1% shift per 1k Rax at 100k volume; needs more data before building)
- URL deeplinks for sport/tab
- Referral leaderboard
- Default to OS light/dark preference
- Auto-login after password reset
