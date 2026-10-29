# AGENTS.md — Store CRM Boilerplate

Single-store Moroccan COD template: storefront + CRM in one Next.js app and one
SQLite DB, one copy per niche. Storefront locale is `fr` or `ar` (RTL) from
`store.config.ts`; CRM UI is always French; prices integer MAD.
Specs: `specs/store-crm-boilerplate/requirements.md`,
`specs/storefront-boilerplate/requirements.md`. Work only in this repository;
the extraction source and its env/data are read-only and must never be loaded.
Each generated store owns its repo, deployment, SQLite, media, users, stock and
secrets. No shared multi-tenant state or automatic template updates.

## Commands

- `npm install` (Node 22+ for native better-sqlite3)
- `npm run dev` — http://localhost:3000
- `npm run lint` and `npx tsc --noEmit` — required before finishing each task
- `DELIVERY_PROVIDER=mock npm run build` — standalone output, no DB/seed at build
- `DELIVERY_PROVIDER=mock npm run start` — local production verification
- Docker runs `node server.js` from standalone with static/public/migrations included
- `npm run test:unit` — fast unit suites in `scripts/unit/*.test.mjs`
- `npm run test:bootstrap`, `npm run test:crm`, `npm run test:catalog-agent`,
  `npm run test:security`, `npm run test:meta`, `npm run test:assistant`
- `node --test examples/nextjs/verify.test.mjs` — typed client and public Next proxy
- Release integration: `npm run test:integration` (built host standalone, system
  Chromium), `npm run test:release-tree`, `npm run test:fresh-install` (offline
  install/build of intended public files), `npm run test:e2e-crm` (team/theme/nav).
  Browser override: `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`.
  For verification, preload `scripts/block-external-network.mjs` through
  `NODE_OPTIONS=--import=<absolute-path>`; permits only loopback real sockets.
- `node scripts/create-user.mjs <email> <password> <name> <admin|agent>` — explicit
  create/update, 12–128 character password; existing email reactivates and bumps
  session version. Run from repo root, scripts do not load `.env.local`.
- `npm run new-store` — new-niche wizard
- `npm run sendit:verify` — live Sendit connection/district/status check (use `--live --yes`)
- `npm run perf-budget` — storefront first-load JS budget, run after build
- `npm run backup` — online SQLite snapshot + uploads + manifest; in image use `node scripts/backup-db.mjs`
- `npm run backup:verify` — restore check of a snapshot on a temp copy; in image `node scripts/verify-backup.mjs`

## Ownership and integration boundaries

- `migrations/`: runtime SQL recorded in `_migrations`; never rewrite applied SQL.
  Fresh database lineage, not a migration of the extraction source’s live database.
- `src/lib/commerce-types.ts`: shared browser-safe generic DTOs. Options are strings;
  no required color or numeric size. Optionless product has one default variant.
- `src/lib/services/inventory.ts`: **sole writer** of physical/reserved/quarantine
  stock and ledger, including catalog initial stock through its supported path.
- `src/lib/services/`: catalog, settings, orders/receipts, confirmation, team,
  edits/history/lifecycle, fulfillment, returns, dashboard and optional integrations;
  also `delivery-outcomes`, `customers` (blocklist/history), `ad-spend`,
  `cod-remittances`, `city-tariffs`, `assignment`, `kpis` and `checkout-leads`.
- `src/lib/shipping/`: couriers.ts registry, city-sync.ts, mock/Ozon/Sendit adapters,
  redaction, mapping and submission policy.
- `src/lib/workers/`: parcel submission, tracking, optional Meta, via instrumentation.
- `src/app/(admin)/`: login, `/admin` catalog and `/crm` operations/team/settings.
- `src/app/api/storefront/v1/`: Bearer-authenticated server integration only.
  This key grants no Auth.js/admin session or catalog-agent access; no browser CORS.
- `integrations/storefront-client.ts`: independent copyable server-only client.
- `examples/nextjs/`: copyable public proxy with encrypted order-bound cookie,
  stable session-scoped keys, strict origin/body validation and bounded limiter.
- `store.config.ts` (repo root) + `src/config/`: the single source of per-niche
  branding, copy, locale, nav, pixel IDs and custom-section mapping. Validated with
  zod at import, so an invalid config fails the build. `src/config/i18n.ts` holds
  the fixed UI strings for fr and ar.
- `src/app/(storefront)/`: public pages. They read data **only** via
  `src/lib/storefront/data.ts` (cached loaders tagged `storefront`). They never call
  `cookies()`, `headers()`, `auth()` or `connection()`, and never import `@/lib/db`
  or services directly.
- `src/lib/storefront/revalidate.ts`: `revalidateStorefront()` must be called by
  every route that changes catalog, prices, packs, settings or availability (admin
  products, stock, catalog-agent, settings, confirm, cancel, returns inspect, order
  edit).
- `src/app/api/store/`: same-origin browser checkout and upsell. These routes call
  the order service in-process and are protected by origin checks, budgets and an
  httpOnly order cookie.
- `src/components/storefront/`: storefront UI. Funnel overlays are loaded with
  `next/dynamic` only when they are opened.
- `src/custom/`: hand-made per-product marketing sections registered in
  `src/custom/index.ts` and mapped by slug in `store.config.ts`.
- `scripts/new-store.mjs`: the new-niche wizard.
- `docs/storefront-integration.md`: definitive API/client/agent contract.
  `docs/operations.md`: deployment/backup/live onboarding.
  `docs/template-upgrades.md`: deliberate per-copy upgrades.

The CRM owns catalog IDs/SKUs, variants, images, prices, packs, shipping, offers,
stock and orders. The in-repo storefront owns presentation, cart and customer
interaction. It reads the catalog only through the cached storefront loaders and
places orders only through `/api/store/*`. External storefronts (optional) still use
v1 from their server and must never import CRM DB/services. Never trust a client
price or send one in checkout. Keep secrets in runtime server env, never
`NEXT_PUBLIC_*`. Pixel IDs are public and live in `store.config.ts`; access tokens
are env-only. Never put secrets in URLs, logs, browser JSON or props.

## Invariants

- Recompute prices on server; persist orders, request receipts and applicable
  durable side effects transactionally before success. Stable attempt keys survive
  timeout/retry; never delete receipts or rotate keys to bypass an uncertain result.
- Checkout exactly name and Moroccan phone plus variant IDs/quantities. Agents
  collect address/city. Zero availability does not reject an active variant at
  checkout; confirmation is the stock gate.
- Confirmation atomically closes pending upsells, checks/reserves stock and queues
  parcel submission. Contact logs never reopen confirmed/cancelled orders.
- Variant IDs/SKUs and inventory/history references survive edits/archive/restore.
  Historical lines retain name/options/price snapshots. Never recreate IDs on edit.
- Discount pricing comes only from (a) the upsell (stored rules/offer/deadline) and
  (b) product quantity packs, which the server applies automatically from the
  persisted pack table and snapshots onto the order. Never accept a pack price or
  discount from the client. Never extend a deadline on replay. Agent confirmation
  may close the offer early.
- Parcel creation only by submission worker, tracking only by poller. BL/handoff
  are explicit agent actions with durable claims. Uncertain BL steps require
  recorded portal reconciliation; no blind retry or automatic lease takeover.
- Redact all Ozon credential-bearing URLs and Sendit secrets. Unknown/unverified tracking statuses
  never automatically change stock; Sendit's map comes from the vendor-published status list,
  Ozon's stays empty until verified.
- Preserve admin/agent permissions, team controls and mobile CRM usability.
- CRM/admin copy French. Storefront copy comes from `store.config.ts` and
  `src/config/i18n.ts` in the configured locale (fr or ar). Currency integer MAD,
  timezone Africa/Casablanca.
- The build never opens SQLite. Storefront loaders return empty data during
  `NEXT_PHASE=phase-production-build`, and a boot warm-up revalidates after start.
- Storefront client bundles must not include zod, libphonenumber-js, DB or service
  modules. First-load JS budget is ≤ 120 KiB (122,880 B) gzip-9 on product and landing pages
  (`scripts/perf-budget.mjs`).
- Reference code may be read from the zehri and hellobaby repos for porting; never
  read their env/data/DB and never modify them.
- Never reintroduce Google Sheets or webhook automation.
- No boot-time product/user/order seeds. Local paths `data/crm.db`, `data/uploads`;
  containers persist `/app/data`, nonroot UID/GID 1001. One process owner per DB.
- Every verification uses `DELIVERY_PROVIDER=mock` (optional `MOCK_COURIER_PROFILE=ozon|sendit`),
  temporary DB/media and ephemeral credentials. Never load another store’s env or call live couriers.
  Only exact `mock` selects mock in runtime code; exact `sendit` selects Sendit; unset/other values select Ozon.
- Optional assistant/catalog/Meta remain disabled when unconfigured. No paid keys
  or production credentials required for fresh empty startup.
- Set exact `SECURITY_ALLOWED_ORIGINS` for CRM browser mutations. Never trust Host
  to grant access. Opt into forwarded client IPs only behind a verified proxy.
- Keep AUTH_SECRET stable for derived order tokens/replays. No transparent keyring
  rotation; coordinate maintenance/reconciliation. Next example cookie is absolute
  1h, one active order binding/browser; lost session cannot safely recreate an
  uncertain checkout with a new key. Memory limiter requires shared replacement
  before distributed/serverless storefront deployment.

## Ready prompt for a storefront coding agent

Only for an optional external storefront; the default is the in-repo storefront.

> Read `docs/storefront-integration.md`, `integrations/storefront-client.ts` and
> `examples/nextjs/README.md` in this CRM. Copy the typed server-only client and
> adapt the Next examples in the storefront repository. Keep CRM_BASE_URL and
> CRM_STOREFRONT_KEY private server env; configure STOREFRONT_ORIGIN and an independent
> STOREFRONT_SESSION_SECRET for the example. Preserve the store design, generic
> variants and CRM-authoritative MAD prices. Checkout has only name/phone, sends
> variant IDs/quantities without prices, and leaves address/city to agents. Await
> session bootstrap; persist the same attempt JSON/UUID across retries, bind upsell
> to the encrypted session and never auto-resubmit an uncertain checkout after
> session loss. Respect deadlines, 409, Retry-After, consent and original attribution.
> Add exact media remotePatterns and empty/error states. Account for the example’s
> one-hour/one-funnel and single-process limiter constraints. Verify with an isolated
> mock CRM, ephemeral secrets and no source data or live courier calls.

Do not publish, commit or mark spec tasks complete unless explicitly requested.
Do not sync to extraction source or global skills. Preserve task ownership and
concurrent user/agent work; upgrades are deliberate per-copy reviews.
