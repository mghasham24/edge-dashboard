# RaxEdge

Real-time expected value calculator for Rax (Real Sports) bettors. Compares FanDuel and DraftKings odds against Real Sports market prices to surface +EV edges across 7 sports.

## Stack

| Layer | Technology |
|---|---|
| Frontend | Cloudflare Pages — `index.html` shell + `app.css` + `app.js` |
| API | Cloudflare Pages Functions (`functions/api/`) |
| Database | Cloudflare D1 SQLite (`edge-db`) |
| Billing | Stripe subscriptions + webhooks |
| Email | Resend |
| Alerts | Cloudflare Worker (`workers/alert-cron/`) — Telegram bot, runs every 60s |
| Auth | Session cookie (`session=`), 30-day expiry, PBKDF2-100k hashing |

## Environment Variables

Set in Cloudflare Pages → Settings → Variables:

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe API key |
| `STRIPE_PRICE_ID` | Monthly plan price ID |
| `STRIPE_ANNUAL_PRICE_ID` | Annual plan price ID |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `RESEND_API_KEY` | Resend email API key |
| `RECAPTCHA_SECRET` | Google reCAPTCHA v3 secret |
| `RS_AUTH_TOKEN` | Real Sports auth token (shared, refresh from RS console) |

## Deploy

```bash
# Frontend + API — push to GitHub, Cloudflare Pages auto-deploys
git push origin main:staging   # staging first (default)
git push origin main           # promote to production

# Alert cron worker (separate deploy)
cd workers/alert-cron
npx wrangler deploy
```

## Local Development

Cloudflare Pages Functions require `wrangler` for local dev:

```bash
npx wrangler pages dev . --d1=DB=<local-db-id>
```

## Tests

```bash
npm test   # runs vitest (webhook handler unit tests)
```

## Key Files

| Path | Purpose |
|---|---|
| `index.html` | HTML shell — auth gate, dashboard, sport tabs |
| `app.css` | All styles |
| `app.js` | All client-side JavaScript |
| `functions/api/_middleware.js` | Auth + plan enforcement |
| `functions/api/stripe/webhook.js` | Stripe billing event handler |
| `functions/api/auth/` | Login, register, forgot, reset |
| `functions/_lib/session.js` | Shared session resolver |
| `functions/_lib/stripe.js` | Shared Stripe API helpers |
| `functions/_lib/password.js` | PBKDF2 password hash/verify |
| `workers/alert-cron/index.js` | Telegram alert cron |
| `sw.js` | PWA service worker |

## Plans

- **Free** — live FD/DK odds, no-vig fair value, edge calculator
- **Pro** ($4.99/mo or $39/yr) — RS sync, Best EV tab, all sports including WNBA + UFC, alerts
- 14-day free trial for monthly; annual is immediate payment, no trial
