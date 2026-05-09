# One Piece TCG Backend

Node + TypeScript scraper, Express API, and HTML dashboard for tracking One Piece TCGplayer sales/listings/prices. The companion frontend app lives in `/Users/evanzecher/one-piece-tcg-app` (Expo + React Native, deployed to Vercel).

## Stack

- **Runtime**: Node 22, ES modules
- **TS**: 5.7, `tsx` for dev, `tsc` for build
- **DB**: PostgreSQL only — accessed via `pg` and the helpers in `src/db/postgres.ts` (`pgGet*`, `pgSave*`, etc.). No SQLite. `DATABASE_URL` is required.
- **Browser automation**: Playwright (Chromium, headless in prod)
- **Server**: Express 5 — single file at `src/server/index.ts`, JWT auth, serves the static dashboard at `src/server/public/index.html`

## Deployments (all on Railway)

Four separate services share this repo, each with its own Dockerfile:

| Service | Dockerfile | Entry |
|---|---|---|
| Dashboard (web UI + API) | `Dockerfile` | `node dist/server/index.js` |
| Sales cron | `Dockerfile.sales` | `scripts/daily-sales.sh` → `update-sales` |
| Listings cron | `Dockerfile.listings` | `scripts/daily-listings.sh` → `refresh-listings` |
| Prices cron | `Dockerfile.prices` | `scripts/daily-prices.sh` → `discover-by-price` |

`railway.toml` uses `Dockerfile` (the dashboard). The crons are configured per-service in Railway's UI to use their respective Dockerfiles. **Don't add SQLite build deps back** — they were removed when SQLite was dropped.

## Frontend on Vercel

`/Users/evanzecher/one-piece-tcg-app` is the Expo app. It targets web via `react-native-web` and is deployed to Vercel. It calls this backend at `https://one-piece-tcg-production.up.railway.app` (see frontend's `src/config.ts`).

## CLI commands (`src/index.ts`)

Run via `npm run dev <cmd>` (tsx) or `node dist/index.js <cmd>` (built). Surviving commands after the audit cleanup:

- **Live data updates**: `update-sales`, `refresh-listings`, `refresh-prices`, `discover-by-price`, `verify-deals`
- **Auth**: `login`, `tcg-login`, `tcg-test-cookies`
- **Queries**: `db:status`, `list-cards`, `card-sales <id>`, `deals`
- **Maintenance**: `db:fix-names`, `suspicious`, `stale-cards`

Anything not in this list was deleted as vestigial. SQLite-era commands (`db:init`, `update-products`, `scrape-top-cards`, `collection-*`, `stats`, `volume`, etc.) are gone — the dashboard handles user collections per-account via Postgres.

## TCGplayer cookies

Logged-in cookie sessions return ~20 sales per card vs ~5 unauthed.

- Local: `tcgplayer-cookies.json` (gitignored — never commit)
- Prod: Railway env var `TCGPLAYER_COOKIES` = base64 of the JSON
- Refresh flow: change TCGplayer password → `npm run dev tcg-login` → `base64 -i tcgplayer-cookies.json` → paste into all 4 Railway services' env vars

Cookies typically last ~3 months. Symptom of expiry: sales scraper returns ~5/card instead of ~20.

## DB layer

`src/db/postgres.ts` is the single source of truth. Schema is migrated by `pgInit*` functions on startup. Decimal columns return strings — convert with `parseFloat(String(x))` (see existing patterns).

## Common edits

- **Add a new CLI command**: append a `program.command(...)` in `src/index.ts`. Wrap action body in `try { await initPostgres(); ... } finally { await closePool(); }`.
- **Add a new query helper**: `src/db/postgres.ts`, export a `pgGet*` function that returns typed rows.
- **Dashboard API**: `src/server/index.ts` — add an `app.get/post(...)` handler. JWT-protected routes use `requireAuth` middleware.
- **Dashboard UI**: single-file `src/server/public/index.html`, vanilla JS + chart.js. Render functions follow `renderX(data)` naming.

## Don't do

- Don't add `better-sqlite3` back. Production never uses it.
- Don't put secrets in query params (admin auth uses `x-admin-key` header).
- Don't commit `tcgplayer-cookies.json` or `cookies-base64.txt` (gitignored — was a public-repo leak in May 2026, scrubbed via filter-repo).
- Don't hardcode local paths. Use `process.env.X ?? <default>` (see `CHROME_USER_DATA` in `src/jobs/updateSales.ts`).

## Verification before pushing

```bash
npm run build                                  # tsc clean
node dist/index.js --help                      # CLI loads
node dist/index.js db:status                   # Postgres connects
docker build -t tcg-test -f Dockerfile .       # Dashboard image builds
```
