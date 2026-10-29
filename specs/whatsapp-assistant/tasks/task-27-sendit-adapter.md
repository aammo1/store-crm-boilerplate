# Task 27: Sendit adapter (BLOCKED)

## Status

superseded — replaced by `specs/sendit-courier/` (Sendit API documented from the official plugin; no longer blocked). Do not implement.

## Wave

6

## Description

This adds Sendit as a second courier, selected per store copy with `DELIVERY_PROVIDER=sendit`. Each store uses exactly one courier, and Ozon stays the default. The adapter implements the existing `DeliveryProvider` interface: create parcel, track, list cities, and the pickup/"bon de ramassage" flow that replaces Ozon's BL. Status mapping follows the same rules as Ozon:
- code `STATUS_MAP` entries only from verified live samples
- owner notification mappings through the "Statuts transporteur" screen (task 19), which records Sendit raw statuses automatically

**Don't start this task until** the owner provides a Sendit account with API access, an API key, endpoint documentation (auth, create parcel, tracking, districts/cities, pickup) and a few real tracking status samples.

## Dependencies

**Depends on:** task-20-courier-provider-groundwork.md
**Blocks:** None

**Context from dependencies:**
- Task 20 made every `courier_submissions` row and every synced `cities` row record a `provider` (`ozon`/`mock` today). Existing rows default to `ozon`.
- Task 19 records raw statuses per provider in `carrier_status_mappings` and lets admins map them for notifications only.
- Existing:
  - `src/lib/shipping/provider.ts` (`DeliveryProvider`: `isConfigured?`, `listCities`, `createParcel(CreateParcelInput)`, `getParcelInfo`, `track(tns)` returning `TrackingResult{trackingNumber, rawStatus, raw, found}`, plus the delivery-note methods).
  - `src/lib/shipping/index.ts` `getProvider()`: exact `mock`, otherwise Ozon.
  - `src/lib/env.ts`: `deliveryProviderName()` and `validateRuntimeEnv()`, which currently accepts only `mock`/`ozon`.
  - `src/lib/shipping/ozon.ts`: a reference adapter with defensive parsing and `syncCities`.
  - `src/lib/shipping/errors.ts`: `ProviderError(kind)`.
  - `src/lib/shipping/redact.ts`: redaction patterns.
  - `src/lib/shipping/status-map.ts`.
  - `src/lib/shipping/POLICY.md`: the submission policy. Never re-create parcels automatically; an uncertain result goes to `needs_review`.
  - `CreateParcelInput` is Ozon-shaped (`stock`, `open`, numeric `cityId`, phone `06…`).
  - BL flows: `src/lib/services/delivery-notes.ts`, `expeditions.ts`, `bl_operations`.

## Files to Create

- `src/lib/shipping/sendit.ts`: `createSenditProvider()` and `syncSenditCities()`.
- `migrations/029_sendit.sql`: only if needed. For example, if Sendit district IDs can collide with Ozon city IDs, add a separate `provider_city_id` mapping table. Decide once the docs are available.
- A focused unit test with mocked HTTP.

## Files to Modify

- `src/lib/env.ts`: accept `DELIVERY_PROVIDER=sendit` and validate the `SENDIT_*` env vars (names come from the docs, e.g. `SENDIT_API_KEY`, `SENDIT_BASE_URL`).
- `src/lib/shipping/index.ts`: return the Sendit provider for exact `sendit`.
- `src/lib/services/tracking.ts`: poll only submissions whose `provider` equals the active provider.
- `src/lib/shipping/redact.ts`: Sendit credential patterns.
- `src/lib/workers/index.ts`: the city sync calls the provider-specific sync.
- Delivery-note and expedition flows: adapt them or hide the BL UI when the provider has no BL concept, then add the Sendit pickup equivalent.
- `docs/operations.md`, `docs/whatsapp.md` (courier section) and `.env.example`.

## Technical Details

To be completed when the docs arrive. Constraints already decided:
- One courier per store. No routing between couriers within a store.
- The submission policy stays identical: an uncertain create goes to `needs_review`, with no blind retry.
- Never guess `STATUS_MAP` entries. WhatsApp notifications 3 and 4 work through the owner mappings.
- Mocked HTTP in tests. Never call live Sendit in tests.

## Acceptance Criteria

- [ ] Blocked until credentials and docs exist. Then: a parcel is created and tracked in a mocked test, cities sync, uncertain results go to `needs_review`, Ozon behaviour is unchanged, and lint, tsc, `test:crm` and the build pass.
