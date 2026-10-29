# Task 15: Courier contract tests

## Status

pending

## Wave

4

## Description

Add one shared, offline "courier contract" test suite that runs the same behavioural checks against every adapter — mock (both profiles), Ozon and Sendit — using a stubbed `fetch` (no network). It locks in the submission-safety classification (success / permanent / throttled / uncertain), parsing robustness, and secret redaction, and fills an existing gap: the Ozon adapter has no mocked-HTTP tests today. Adding a future courier then means adding one fixture block. (Explicitly requested by the owner.)

## Dependencies

**Depends on:** task-08-sendit-adapter.md, task-09-status-maps-tracking.md
**Blocks:** task-17-docs-policy.md

**Context from dependencies:**
- Adapters: `createSenditProvider({ env, getSettings, fetchImpl })` and `__resetSenditTokenCache()` in `src/lib/shipping/sendit.ts`; `createOzonProvider()` / `OzonExpressAdapter` in `src/lib/shipping/ozon.ts` (reads `OZON_CLIENT_ID`, `OZON_API_KEY`, `OZON_BASE_URL` from `process.env` at call time; uses global `fetch`; credentials in path `/customers/{id}/{key}/…`; FormData bodies; tracking JSON; 15 s timeout); `createMockProvider({ profile })` in `src/lib/shipping/mock.ts`.
- `ProviderError(kind)` kinds: `retryable | permanent | unknown | throttled` (`src/lib/shipping/errors.ts`).
- Interface: `createParcel(ParcelRequest)`, `track(codes)`, `listCities()`, optional `getLabelsPdf`, `findParcelByReference`, `testConnection`; `capabilities`.
- `normalizeStatus(raw, courier)` and maps in `src/lib/shipping/status-map.ts`.
- Sendit API facts (base `https://app.sendit.ma/api/v1`): `POST /login` → `{data:{token}}`; `GET /districts?page=N` → `{data:[{id,name,arabic_name,ville,price,pickup_district}], last_page}`; `POST /deliveries` → 200 `{success:true, data:{code}}`, 200 `{success:false,message}` refused, 429 throttled, 5xx/200-no-code uncertain; `GET /deliveries/{code}` → `{success:true,data:{status:"DELIVERED"|{code}}}`; `GET /deliveries?querystring=…&page=N` → `{data:{0:{code,reference,status},…, packaging_fee:…}, last_page}` (or nested `data.data`); `POST /deliveries/getlabels` → URL under various keys, must be `https://app.sendit.ma/…`.
- Test conventions: `scripts/unit/*.test.mjs`, `node:test`, `import { loadSource } from "../test-source.mjs"` (handles `@/` aliases and TS), temp `DB_PATH` if a module touches the DB, `DELIVERY_PROVIDER=mock`, `AUTH_SECRET` ephemeral. `npm run test:unit` runs `scripts/unit/*.test.mjs`; run it with `NODE_OPTIONS=--import=$PWD/scripts/block-external-network.mjs`.

## Files to Create

- `scripts/unit/courier-contract.test.mjs` — the suite.
- `scripts/unit/fixtures/fake-courier-http.mjs` — tiny router-based `fetch` stub (`route(method, pathRegex, handler)`, records calls, returns `Response` objects, can throw to simulate network errors/timeouts).

## Files to Modify

- None (the unit glob picks the new file up).

## Technical Details

Shared contract (each adapter gets a fixture describing how to make the fake server answer):

1. `createParcel` success returns the courier code; the request carries no client price other than the snapshot amount.
2. Invalid input (bad phone, empty address, cityId 0) throws `permanent` **without any fetch call**.
3. Network error / abort → kind `unknown` or `retryable` (never `permanent`, never `throttled`).
4. HTTP 500 → not `permanent`, not `throttled`.
5. Error messages never contain the configured secrets (use distinctive fake values like `SECRET-XYZ-123`) nor `Bearer <token>`.
6. `listCities` parses the fixture into `{id:number, name}`.
7. `track` returns one result per requested code with `found` semantics.
8. `capabilities` matches `COURIERS[profile].capabilities`.

Sendit-specific:
- 429 on create → `throttled` with `retryAfterSec` from `Retry-After`.
- 200 `success:false` → `permanent`; 200 without `data.code` → `unknown`.
- First call 401 with cached token → exactly one re-login then success; second 401 → `permanent`.
- Token reused across calls (one login for several requests) and refreshed when the public key changes.
- Districts: two pages; tatweel-only/Latin `arabic_name` dropped; Casablanca non-flagged district marked pickup; decimal price → `null`.
- Create body: `pickup_district_id` from settings, `allow_open`/`allow_try` 1/0, `products` string format `Name (Taille: M) x2 | Other x1`, `reference` passed through.
- Missing pickup district → `permanent`, no fetch; `isConfigured()` false and `configurationIssues()` lists it.
- Labels: picks URL from `data.file_url`; rejects `https://evil.example/x.pdf` and `http://app.sendit.ma/x.pdf`.
- Lookup: exact reference match only, skips `CANCELED` rows, ignores non-integer keys, `complete:false` after 3 full pages.
- Tracking: status object `{code:"picked_up"}` → raw `PICKED_UP`… then `normalizeStatus(raw,"sendit")` → `in_transit`; 429 mid-batch yields `rawStatus:null` for the rest; never more than 3 concurrent requests (track in-flight count in the stub).

Ozon-specific (behaviour lock, no change to adapter):
- `add-parcel` form fields exactly: `parcel-receiver, parcel-phone, parcel-city, parcel-address, parcel-price, parcel-nature, parcel-stock=0`.
- `{result:"ERROR", message}` without tracking number → `permanent`; 429 → `retryable` (unchanged); tracking parse of the `TRACKING-LIST` container shape; error text has `/customers/***/***` and no raw key.

Mock: both profiles satisfy the shared contract; Sendit profile BL methods reject `permanent`.

## Acceptance Criteria

- [ ] Suite passes offline under `block-external-network.mjs`.
- [ ] Every item above has at least one assertion.
- [ ] No adapter source changes were needed (if a test exposes a real bug, fix it minimally and report it).
- [ ] `npm run test:unit`, `npm run lint` pass.
