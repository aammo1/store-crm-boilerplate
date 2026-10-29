# Task 08: Sendit adapter

## Status

pending

## Wave

3

## Description

Implement the Sendit courier adapter (`src/lib/shipping/sendit.ts`) against Sendit's public API, wire it into `getProvider()` for `DELIVERY_PROVIDER=sendit`, and make sure Sendit secrets and tokens are redacted everywhere. The adapter logs in with the store's public/secret keys, caches the Bearer token in memory, syncs districts (with Arabic names, pickup flag and price), creates parcels with the per-store reference, tracks parcels one by one with bounded concurrency, generates 10×10 label PDFs, and offers a read-only lookup by reference. It follows the existing submission policy exactly: only outcomes that guarantee nothing was created are retried; uncertain ones become `needs_review`.

## Dependencies

**Depends on:** task-03-courier-settings-service.md, task-05-neutral-copy-knobs.md, task-06-shipping-core-refactor.md
**Blocks:** task-13, task-14, task-15, task-16

**Context from dependencies:**
- Task 06 defined in `src/lib/shipping/provider.ts`: `DeliveryProvider { readonly name; readonly profile; readonly capabilities; isConfigured?(); configurationIssues?(): string[]; listCities(): Promise<City[]>; createParcel(ParcelRequest): Promise<{trackingNumber, raw}>; getParcelInfo(tn): Promise<{raw, trackingNumber?}>; track(tns): Promise<TrackingResult[]> /* {trackingNumber, rawStatus, raw, found} */; createDeliveryNote/addParcelsToDeliveryNote/saveDeliveryNote/deliveryNotePdfUrl (required; non-BL couriers throw ProviderError("permanent","BL non pris en charge par ce transporteur")); getLabelsPdf?(codes, format): Promise<{url}>; findParcelByReference?(reference, phoneLocal): Promise<{complete, parcel: {trackingNumber, rawStatus}|null}>; testConnection?(): Promise<void> }`. `City {id, name, arabicName?, pickup?, priceMad?}`. `ParcelRequest {reference ("<slug>-<orderId>"), orderId, receiver, phoneLocal (0[5-7]XXXXXXXX), cityId, cityName, address, codAmountMad, description, items: {name, options:{name,value}[], quantity, sku}[]}`. `src/lib/shipping/index.ts` `getProvider()` currently throws for `sendit` (placeholder to replace). City sync (`src/lib/shipping/city-sync.ts`) stores `arabicName`, `pickup`, and pre-fills tariffs from integer `priceMad`.
- Task 05: `ProviderError(kind, message, {cause?, retryAfterSec?})` with kinds `retryable | permanent | unknown | throttled`. Worker semantics after the request was sent: `permanent` → `failed`; `throttled` → requeue (nothing created); `retryable`/`unknown` → `needs_review` (never re-created automatically). Before sending, invalid input must throw `permanent` without any network call.
- Task 03: `getCourierSettings()` from `@/lib/services/courier-settings` → `{ senditPickupDistrictId: number|null, senditAllowOpen: boolean, senditAllowTry: boolean }`.
- Task 01: `COURIERS.sendit` (label "Sendit", capabilities, `secretEnv: ["SENDIT_PUBLIC_KEY","SENDIT_SECRET_KEY"]`); `deliveryProviderName()` returns `"sendit"` for exact `sendit`.
- Reference adapter: `src/lib/shipping/ozon.ts` (15 s timeout via AbortController, defensive parsing, `previewOf` with redaction, `ProviderError` classification).
- Redaction: `src/lib/shipping/redact.ts` (`redactUrl`/`redactText`, `CUSTOMER_PATH_RE`, `QUERY_SECRET_RE` masking query params like `token`, `redactSecrets(text, secrets[])`); explicit secret lists in `src/lib/services/delivery-notes.ts:~61` and `src/lib/services/assistant-data.ts:~114` (currently `OZON_CLIENT_ID`/`OZON_API_KEY`). `src/lib/log.ts` passes every string through `redactText`.

## Files to Create

- `src/lib/shipping/sendit.ts` — `createSenditProvider(deps?)`.

## Files to Modify

- `src/lib/shipping/index.ts` — return the Sendit provider for `sendit`.
- `src/lib/shipping/redact.ts` — Bearer/JWT and `public_key`/`secret_key` patterns.
- `src/lib/services/delivery-notes.ts` — add `SENDIT_*` to the redacted secrets list (line ~61) only.
- `src/lib/services/assistant-data.ts` — same (line ~114) only.
- `scripts/unit/observability.test.mjs` — assert Bearer tokens and `secret_key` JSON values are redacted.

## Technical Details

### API (base `https://app.sendit.ma/api/v1`, override `SENDIT_BASE_URL` for tests only; JSON; `Accept: application/json`)

| Method | Call | Notes |
|---|---|---|
| login | `POST /login` `{"public_key","secret_key"}` → `data.token` | Cache `{token, account: sha256(public_key), expiresAt: now+55min}` in a module-level variable (memory only, never DB/logs). Re-login when keys change (fingerprint mismatch) or expired. |
| request helper | Bearer call | On 401/403 **with a cached token**: drop token, login, retry once (auth-refused request created nothing, safe even for create). 15 s timeout (labels 20 s, districts 25 s). |
| listCities | `GET /districts?page=N` until `last_page` (cap 50) | Map `{id:Number(id), name, arabicName, pickup, priceMad}`. `arabicName`: strip U+0640, collapse spaces, keep only if `/\p{Script=Arabic}/u` matches. `pickup = pickup_district == 1 || ville === "Casablanca"`. `priceMad`: `Number(price)` if integer ≥ 0 else `null`. Skip rows without `id`/`name`. No rows → `ProviderError("unknown", "Aucun district Sendit reçu")`. |
| createParcel | `POST /deliveries` | Body below. Classification below. |
| getParcelInfo / single track | `GET /deliveries/{encodeURIComponent(code)}` | Status = `data.status` string or `data.status.code`, `toUpperCase().trim()`. 404 → `found:false`. |
| track(codes) | one GET per code, **max 3 concurrent** | A 429 stops the batch: remaining codes return `{found:true, rawStatus:null}` (poller just touches `last_sync_at`) and log once. Network/5xx for one code → `rawStatus:null` for it. |
| getLabelsPdf(codes, "10x10") | `POST /deliveries/getlabels` `{"codesToPrint": codes.join(","), "printFormat": 1}` | URL candidates in order: `data.fileUrl, data.file_url, data.url, data.pdf, data.link, data.path, data (string), fileUrl, file_url, url`. Accept only `https:` + host `app.sendit.ma` (compare `new URL(base).host`). Else `ProviderError("unknown", "Lien d'étiquettes Sendit invalide")`. Max 100 codes. |
| findParcelByReference(ref, phone) | `GET /deliveries?querystring=<phone>&page=N`, N ≤ 3 | Rows = entries of `data` (or `data.data`) with integer keys whose value is an object. Exact `String(row.reference).trim() === ref`; skip dead statuses `CANCELED, CANCELLED, REJECTED, RETURNED, DELETED`. Found → `{complete:true, parcel:{trackingNumber: row.code, rawStatus}}`; reached `last_page` → `{complete:true, parcel:null}`; error or > 3 pages → `{complete:false, parcel:null}`. Read-only. |
| testConnection | login only (force fresh token) | Throws `ProviderError` on failure. |
| BL methods | — | throw `ProviderError("permanent", "BL non pris en charge par ce transporteur")`; `deliveryNotePdfUrl` returns `""`. |

### Create body

```ts
{
  reference: input.reference,
  name: input.receiver,
  amount: input.codAmountMad,
  phone: input.phoneLocal,
  address: input.cityName ? `${input.address}, ${input.cityName}` : input.address,
  pickup_district_id: settings.senditPickupDistrictId,
  district_id: input.cityId,
  comment: `Commande ${input.reference}`,
  allow_open: settings.senditAllowOpen ? 1 : 0,
  allow_try: settings.senditAllowTry ? 1 : 0,
  products: productsString(input.items),
}
```

`productsString`: each item → `clean(name)` + (options ? ` (${options.map(o => `${clean(o.name)}: ${clean(o.value)}`).join(", ")})` : "") + ` x${quantity}`, joined with ` | `. `clean`: collapse whitespace, replace `|`→`/`, `;`→`,`, `:`→` -`, trim. Fallback to `input.description` if items empty.

Pre-network validation (throw `permanent`, no fetch): empty receiver/address; `cityId` not a positive integer; amount not an integer ≥ 0; phone not matching `/^0[5-7]\d{8}$/`; pickup district not set (`"District de ramassage Sendit non configuré — CRM → Paramètres."`); missing keys (`"Sendit non configuré"`).

### Create classification

- Fetch threw / aborted (timeout) → `ProviderError("unknown", "Pas de réponse de Sendit …")` (uncertain).
- HTTP 200 + `success === true` + non-empty string `data.code` → `{trackingNumber: data.code, raw: redacted body}`.
- HTTP 429 → `ProviderError("throttled", msg, {retryAfterSec: Number(header Retry-After) || undefined})`.
- HTTP 200 + `success === false` → `permanent` (refused).
- HTTP 200 otherwise (no code) or 0 or ≥ 500 → `unknown` (uncertain).
- 401/403 after the one re-login → `permanent` ("Clés Sendit refusées").
- Other 4xx → `permanent`.
- Message: `Échec (HTTP ${status}): ${message}` + ` Détails: ${flattened errors}`, strip tags, ≤ 500 chars, then `redactSecrets(redactText(msg), [publicKey, secretKey, token])`.

### Config / factory

```ts
export function createSenditProvider(deps: {
  env?: NodeJS.ProcessEnv;
  getSettings?: () => CourierSettings; // default getCourierSettings
  fetchImpl?: typeof fetch;            // default globalThis.fetch (tests stub)
} = {}): DeliveryProvider
```

- `name = "sendit"`, `profile = "sendit"`, `capabilities = COURIERS.sendit.capabilities`.
- `isConfigured()` → keys present **and** pickup district set. `configurationIssues()` → French reasons: `"Clés Sendit manquantes (SENDIT_PUBLIC_KEY, SENDIT_SECRET_KEY)"`, `"District de ramassage Sendit non choisi (CRM → Paramètres)"`. The existing submission worker leaves jobs queued and logs once when `isConfigured()` is false — no worker change needed.
- Read keys and settings at call time (no module-level caching of keys).
- Provide `__resetSenditTokenCache()` export for tests.

### `index.ts`

`if (name === "sendit") return createSenditProvider();` (replace the placeholder throw).

### Redaction

- `redact.ts`: add `BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi` → `$1***`; JSON key patterns `/("(?:public_key|secret_key|token|access_token)"\s*:\s*")[^"]*"/gi` → `$1***"`; add `public_key, secret_key` to the query-param list. Apply inside `redactUrl`/`redactText` so `log.ts` benefits.
- `delivery-notes.ts` and `assistant-data.ts`: extend the explicit secret arrays with `process.env.SENDIT_PUBLIC_KEY`, `process.env.SENDIT_SECRET_KEY` (filter empty).

## Acceptance Criteria

- [ ] `DELIVERY_PROVIDER=sendit` returns the Sendit adapter; Ozon/mock paths unchanged.
- [ ] Create outcomes are classified exactly as specified (success / permanent / throttled / unknown), with one silent re-login on 401/403.
- [ ] Districts paginate, keep only real Arabic names, compute pickup, integer prices.
- [ ] Labels accept only `https://app.sendit.ma` URLs; lookup is read-only and honours dead statuses and the 3-page cap.
- [ ] No key or token appears in any thrown message, log or `raw` value.
- [ ] `npm run test:unit`, `npm run test:crm`, `npm run lint`, `npx tsc --noEmit` pass (fake-HTTP adapter tests are task 15, but sanity-check locally with a stubbed fetch).
