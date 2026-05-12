# RaxEdge — Claude Context

## Project Type
Cloudflare Pages (static frontend) + Cloudflare Functions (API) + D1 (SQLite) + Workers (cron).

## Stack
- **Frontend**: Single-file SPA — `index.html` (~10k lines). All JS, CSS, and HTML in one file.
- **API**: `functions/api/` — Cloudflare Pages Functions (ES modules, `onRequest` export).
- **Database**: Cloudflare D1 (`edge-db`, id `ff9b93f1-81f8-4370-bd57-f634e0300443`).
- **Billing**: Stripe subscriptions via `functions/api/stripe/webhook.js`.
- **Email**: Resend (`functions/api/auth/register.js`, `forgot.js`).
- **Alerts**: Telegram bot via `workers/alert-cron/` — separate Cloudflare Worker, deployed independently with `npx wrangler deploy` from that directory.
- **Odds**: Native FD/DK API fetches for most sports; Odds API (`api.the-odds-api.com`) only for UFC and fallback cases.

## Key Files
| Path | Purpose |
|---|---|
| `index.html` | Entire SPA — auth gate, dashboard, Best EV, all sport tabs |
| `functions/api/_middleware.js` | Auth + plan enforcement on all `/api/` routes |
| `functions/api/real/sync.js` | RS native sync — fetches Real Sports market probabilities |
| `functions/api/odds.js` | Odds API proxy with D1 caching and dynamic TTL |
| `functions/api/stripe/webhook.js` | All Stripe billing state changes (subscription created/updated/deleted) |
| `functions/api/auth/` | Login, register, forgot-password, reset |
| `workers/alert-cron/index.js` | Telegram bet alert cron — runs every 60s on Cloudflare |

## Deploy Conventions
- **Always commit to local `main`, push to `origin main:staging` first** — never push directly to `origin/main` without explicit user confirmation.
- Exception: pure cost-saving or non-user-facing changes (e.g. server-side blocks) can go to main when user confirms.
- **`workers/alert-cron`** must be deployed separately: `cd workers/alert-cron && npx wrangler deploy`. A git push alone does NOT deploy it.
- **Never push alert-cron changes to `origin/main`** without explicit instruction — it fires real Telegram messages every minute.

## Auth & Plan Model
- Sessions: `sessions` table, token in cookie (`session=`), 30-day expiry.
- Plans: `users.plan` = `'free'` | `'pro'`. `users.pro_expires_at` (unix) set from Stripe `current_period_end`.
- Promo gate: `FREE_PROMO_END` date constant in `_middleware.js`, `sync.js`, and `index.html`. Past date = dormant. Update all three + deploy to activate.
- Admin users (`is_admin=1`) bypass all plan gates and the UFC day-of-week block.

## Gotchas
- **UFC odds**: Server-side blocked Mon–Fri (`odds.js`) — only fetches on Sat/Sun UTC to save Odds API credits. Admins bypass.
- **Odds API credits**: UFC costs ~1 credit per fight per fetch. Live TTL = 30s (expensive during events). Native FD/DK fetches cost zero credits.
- **RS auth token**: Shared Cloudflare env var (`RS_AUTH_TOKEN`), not per-user. If Best EV shows empty across all sports, check this token first in Cloudflare dashboard → Workers & Pages → edge-db project → Settings → Variables.
- **Stripe webhook order**: Cloudflare makes no delivery-order guarantee. Don't rely on `subscription.created` arriving before `checkout.session.completed`.
- **`invoice.payment_failed` should NOT downgrade users** — Stripe's dunning retries. Only downgrade on `customer.subscription.deleted`.
- **`index.html` is huge**: edits near one feature can break another. Search for the specific function/class before editing. `isPro()` is defined around line 6916.
- **Free promo**: To activate, update `FREE_PROMO_END` in all 3 files to a future UTC date and deploy.

## Prioritized Feature Backlog (from audit)
1. Don't drop to free on `invoice.payment_failed` — wait for `customer.subscription.deleted`
2. Rate-limit `/api/auth/login` and `/api/auth/forgot` (brute-force + Resend cost risk)
3. Replace `prompt()` forgot-password with inline gate UI
4. Bump PBKDF2 from 100k → 600k iterations; rehash on login
5. Annual plan ($50/yr toggle in upgrade modal)
6. Trial-ending banner (≤3 days remaining, using `pro_expires_at`)
7. Onboarding checklist on first login (RS connect → unit size → alerts → referral)
8. Pause `setInterval` pollers when tab is hidden (`visibilitychange`)
9. Auto-login after password reset
10. PWA service worker (manifest.json already exists)
11. Extract `getSession` shared helper (copy-pasted ~15 times across functions)
12. Extract `hashPassword` before bumping iterations
