# RaxEdge — Claude Context

## Project Type
Cloudflare Pages (static frontend) + Cloudflare Functions (API) + D1 (SQLite) + Workers (cron).

## Stack
- **Frontend**: Three-file SPA — `index.html` (shell + script tags), `app.js` (~7.4k lines, all JS), `app.css` (~2.3k lines, all CSS).
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
| `functions/api/fd/fc.js` | DK soccer alt handicap odds for FC tab (subcat 13170) |
| `functions/api/fd/rfi.js` | FD RFI (run first innings) odds |
| `functions/api/dk/nbaalts.js` | DK NBA alt lines |
| `functions/api/dk/nhalalts.js` | DK NHL alt lines |
| `functions/api/odds.js` | Odds API proxy — UFC only, with D1 caching and day-of-week block |
| `functions/api/stripe/webhook.js` | All Stripe billing events |
| `functions/api/stripe/checkout.js` | Stripe checkout session creation |
| `functions/api/stripe/portal.js` | Stripe billing portal |
| `functions/api/auth/` | Login, register, forgot-password, reset |
| `functions/api/admin/users.js` | Admin user management |
| `functions/api/admin/stats.js` | Admin dashboard stats |
| `functions/api/bets/taken.js` | Track bets taken by user (capped at 1000) |
| `functions/api/alerts/settings.js` | Telegram alert preferences |
| `functions/api/alerts/connect.js` | Telegram connection/verify |
| `workers/alert-cron/index.js` | Telegram bet alert cron — runs every 60s on Cloudflare |
| `workers/rs-poster/` | Dead CF Worker (DO NOT redeploy — was firing blank 401s every minute) |
| `migrations/0001_initial.sql` | Full D1 schema snapshot — use to recreate DB from scratch |

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
| `CRON_SECRET` | `alert-cron`, all `/api/real/sync` and odds cron calls |
| `SITE_URL` | `alert-cron` — e.g. `https://raxedge.com` |
| `TELEGRAM_BOT_TOKEN` | `alert-cron` — main alerts bot |
| `FREE_PROMO_END` | Optional override for promo window |
| `STRIPE_SECRET_KEY` | Stripe API |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification |
| `RESEND_API_KEY` | Email (register, forgot) |

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

## Debugging Playbook
| Symptom | First thing to check |
|---|---|
| Best EV empty on all sports | `RS_AUTH_TOKEN` env var in Cloudflare dashboard |
| "Error fetching [sport] data" on refresh | CF 30s timeout — is the fetch sequential? Parallelize with Promise.all + AbortController |
| Free user sees no data on free sport | Pro check accidentally added to that endpoint — remove it |
| Telegram alerts not sending | `TELEGRAM_BOT_TOKEN` in alert-cron env, or alert-cron not deployed (`wrangler deploy`) |
| Stripe events not updating plan | Check `processed_webhook_events` for duplicates; confirm `subscription.deleted` event fires |
| D1 schema missing table | Run `npx wrangler d1 execute edge-db --remote --file=migrations/0001_initial.sql` |

## Open Audit Backlog (Audit 2 — 2026-05-12)
Items without ✅ are unfinished. "whats next" = first uncompleted item.

**Critical**
- [ ] PBKDF2 iterations still 100k — `ITERATIONS = 600000`, keep `LEGACY_ITERATIONS = 100000`, rehash on login
- [ ] `/api/real/public.js` has no auth — open RS API relay
- [ ] Stripe webhook not idempotent for referrer reward (double-reward on retry)
- [ ] Webhook signature compare not constant-time (`===`)

**High**
- [ ] `alert-cron` ET offset was hardcoded — confirm Intl fix is live
- [ ] N+1 queries in `admin/stats.js` (14-day loop) and `admin/users.js` (per-user session count)
- [ ] `admin/users.js` PATCH accepts arbitrary plan values (no validation)
- [ ] DELETE `/api/admin/users` doesn't cascade — orphan rows in 9 tables

**Medium**
- [ ] Polling continues when tab hidden — no `visibilitychange` listener
- [ ] `setInterval` chains can leak across sport switches — need `stopAllPollers()` helper
- [ ] `real/sync.js` has 9 debug modes with no admin gate
- [ ] Stripe customer fallback creates wrong match — should create fresh customer
- [ ] `register.js` `generateCode` doesn't retry on collision
- [ ] `TM_PUSH_KEY` hardcoded in two server files — should be `env.TM_PUSH_KEY`
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
- Live NBA scores/quarter/clock from FD event-page API (zero extra requests — data already in response)
- RS WebSocket payout API for exact EV (`PredictionMarketGetExpectedPayout`) — replaces rake approximation
- Slippage-adjusted EV for large RS bets (~1% shift per 1k Rax at 100k volume)
- URL deeplinks for sport/tab
- Referral leaderboard
- Default to OS light/dark preference
- Annual plan toggle in upgrade modal
- Auto-login after password reset
