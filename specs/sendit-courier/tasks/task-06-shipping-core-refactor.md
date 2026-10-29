# Task 06: Shipping core — ParcelRequest, capabilities, shared city sync, mock profiles

## Status

pending

## Wave

2

## Description

Turn the Ozon-shaped shipping core into a courier-neutral one so Sendit (task 08) can plug in. Concretely: (1) the `DeliveryProvider` interface takes a neutral `ParcelRequest` and exposes `name`, `profile` and `capabilities`, plus optional label/lookup/test methods; (2) the frozen payload snapshot gains a per-store courier reference `"<store-slug>-<orderId>"` so stores sharing one courier account never collide; (3) city sync moves out of `ozon.ts` into a shared module that records `cities.provider`, Sendit's Arabic names / pickup flag, and pre-fills missing tariffs from courier prices; (4) the mock courier gains a **Sendit profile** (`MOCK_COURIER_PROFILE=sendit`) so local dev and tests of a Sendit store show Sendit behaviour; (5) `toOzonPhone` becomes `toLocalPhone`. Ozon's wire format and all Ozon/mock behaviour stay byte-for-byte identical.

## Dependencies

**Depends on:** task-01-courier-registry-env.md, task-02-migration-provider-columns.md
**Blocks:** task-08, task-09, task-10, task-11, task-12

**Context from dependencies:**
- Task 01: `src/lib/shipping/couriers.ts` exports `CourierName = "ozon"|"sendit"`, `CourierCapabilities {deliveryNotes, labels, labelFormats, parcelLookup, bulkTracking, pickupDistrict}`, `COURIERS` (Ozon: deliveryNotes true, labels false, bulkTracking true; Sendit: deliveryNotes false, labels true with format `{id:"10x10"}`, parcelLookup true, bulkTracking false, pickupDistrict true). `src/lib/env.ts` exports `deliveryProviderName()` → `"mock"|"ozon"|"sendit"` and `courierProfile()` → `"ozon"|"sendit"` (mock honours `MOCK_COURIER_PROFILE`).
- Task 02: migration 029 added `cities.provider TEXT NOT NULL DEFAULT 'ozon'`, `cities.arabic_name TEXT`, `cities.is_pickup INTEGER NOT NULL DEFAULT 0`, and `courier_submissions.provider` (set on insert by `submissions.ts`).
- Existing code you will change:
  - `src/lib/shipping/provider.ts` — `City {id,name}`, Ozon-shaped `CreateParcelInput {receiver, phone(06…), cityId, address, priceMad, declaredValueMad?, note?, nature?, stock:0|1, open?:1|2, fragile?, replace?, products?, customTrackingCode?}`, `DeliveryProvider {isConfigured?, listCities, createParcel, getParcelInfo, track, createDeliveryNote, addParcelsToDeliveryNote, saveDeliveryNote, deliveryNotePdfUrl}`, `PdfFormat = "standard"|"a4"|"tickets10x10"`.
  - `src/lib/shipping/parcel-payload.ts` — `ParcelPayloadSnapshot {order_id, customer_name, customer_phone(+212…), address, city_id, city_name, total, items}`, `buildSnapshotObject`, `buildPayloadSnapshot`, `buildCreateParcelInput(submission, order)` returning `{receiver, phone: toOzonPhone(...), cityId: city_id ?? 0, address, priceMad: total, nature: shipmentDescription(items), stock: 0}`.
  - `src/lib/shipping/ozon.ts` — `OzonExpressAdapter` with `buildParcelFields(input)` (validates receiver/address/cityId/price/phone, throws `ProviderError("permanent")` before network) and `syncCities(provider?)` at lines ~572–585 (upserts `cities (id,name,updated_at)` ON CONFLICT(id)).
  - `src/lib/shipping/mock.ts` — `createMockProvider({trackingStatuses?})` + `setTrackingStatus`; 5 cities ids 1–5 (Casablanca, Rabat, Marrakech, Fès, Agadir); codes `OZEMOCK${bootId}${seq9}`, BL refs `BLMOCK${bootId}${seq6}`; `track()` treats codes starting `OZEMOCK` as found, default status `"MOCK_CREATED"`; `deliveryNotePdfUrl` → `mock://pdf/{format}/{ref}`.
  - `src/lib/shipping/index.ts` — `getProvider()`: exact mock → shared `globalThis.__crmMockProvider`, else `createOzonProvider()`.
  - `syncCities` is imported by `src/lib/workers/index.ts:3`, `src/app/api/crm/cities/sync/route.ts:3`, `scripts/mock-flow.test.mjs`, `scripts/catalog-agent.test.mjs`.
  - `toOzonPhone` in `src/lib/phone.ts` (used by `parcel-payload.ts`, `src/lib/services/order-export.ts:3,138`).
  - `src/lib/workers/submission.ts` calls `provider.createParcel(buildCreateParcelInput(submission, order))` — **do not edit submission.ts** (task 05 owns it this wave); keep the function name `buildCreateParcelInput`.
  - `src/lib/services/delivery-notes.ts` calls the BL methods — **do not edit it**; BL methods stay required on the interface.

## Files to Create

- `src/lib/shipping/city-sync.ts` — shared, provider-aware city sync + tariff pre-fill.

## Files to Modify

- `src/lib/shipping/provider.ts` — neutral types (below).
- `src/lib/shipping/parcel-payload.ts` — courier reference, `ParcelRequest` builder, `toLocalPhone`.
- `src/lib/shipping/ozon.ts` — implement new interface, map `ParcelRequest` → identical Ozon form fields; remove `syncCities`.
- `src/lib/shipping/mock.ts` — profiles `ozon` (unchanged) and `sendit`.
- `src/lib/shipping/index.ts` — profile-aware mock; `sendit` placeholder.
- `src/lib/workers/index.ts`, `src/app/api/crm/cities/sync/route.ts` — import `syncCities` from `@/lib/shipping/city-sync`.
- `src/lib/phone.ts`, `src/lib/services/order-export.ts` — rename `toOzonPhone` → `toLocalPhone` (accept `+212[5-7]…`).
- `scripts/mock-flow.test.mjs`, `scripts/catalog-agent.test.mjs`, `scripts/unit/phone.test.mjs` (if it references the old name) — update imports; add Sendit-profile mock coverage in `mock-flow.test.mjs`.

## Technical Details

### `provider.ts`

```ts
import type { CourierCapabilities, CourierName } from "./couriers";

export interface City {
  id: number;
  name: string;
  arabicName?: string | null;
  /** Courier allows this city/district as merchant pickup (Sendit). */
  pickup?: boolean;
  /** Courier's own delivery price, integer MAD, when the courier publishes it. */
  priceMad?: number | null;
}

export interface ParcelItem { name: string; options: { name: string; value: string }[]; quantity: number; sku: string | null }

/** Courier-neutral parcel request built from the frozen payload snapshot. */
export interface ParcelRequest {
  /** Per-store unique reference "<slug>-<orderId>" — stable across retries. */
  reference: string;
  orderId: string;
  receiver: string;
  /** Local Moroccan format 0[5-7]XXXXXXXX. Adapters re-validate. */
  phoneLocal: string;
  cityId: number;
  cityName: string | null;
  address: string;
  /** Final COD amount, integer MAD. */
  codAmountMad: number;
  /** Human shipment description (shipmentDescription(items)). */
  description: string;
  items: ParcelItem[];
}

export interface LabelsPdf { url: string } // https URL fetched server-side, or mock:// placeholder

export interface ParcelLookupResult {
  /** false = search could not finish; absence proves nothing. */
  complete: boolean;
  parcel: { trackingNumber: string; rawStatus: string | null } | null;
}

export interface DeliveryProvider {
  readonly name: "mock" | CourierName;
  /** Courier behaviour this instance emulates/implements. */
  readonly profile: CourierName;
  readonly capabilities: CourierCapabilities;
  isConfigured?(): boolean;
  /** French reasons why jobs cannot be sent yet (missing keys, pickup district…). */
  configurationIssues?(): string[];
  listCities(): Promise<City[]>;
  createParcel(input: ParcelRequest): Promise<CreateParcelResult>;
  getParcelInfo(trackingNumber: string): Promise<ParcelInfoResult>;
  track(trackingNumbers: string[]): Promise<TrackingResult[]>;
  // BL (capabilities.deliveryNotes). Couriers without BL throw ProviderError("permanent", "BL non pris en charge par ce transporteur").
  createDeliveryNote(): Promise<DeliveryNoteHandles>;
  addParcelsToDeliveryNote(ref: string, codes: string[]): Promise<void>;
  saveDeliveryNote(ref: string): Promise<void>;
  deliveryNotePdfUrl(ref: string, format: PdfFormat): string;
  /** capabilities.labels */
  getLabelsPdf?(trackingNumbers: string[], format: string): Promise<LabelsPdf>;
  /** capabilities.parcelLookup — read-only. */
  findParcelByReference?(reference: string, phoneLocal: string): Promise<ParcelLookupResult>;
  /** Cheap authenticated call for the health card; throws ProviderError on failure. */
  testConnection?(): Promise<void>;
}
```

Keep `CreateParcelResult`, `ParcelInfoResult`, `TrackingResult`, `DeliveryNoteHandles`, `PdfFormat` unchanged. Delete `CreateParcelInput` from the public interface; if Ozon needs its old field set internally, move a private equivalent into `ozon.ts`.

### `parcel-payload.ts`

```ts
import rawStoreConfig from "../../../store.config"; // same pattern as src/lib/services/store-settings.ts (raw import keeps node tests loadable)

export function courierReference(orderId: string): string {
  const slug = String(rawStoreConfig.slug ?? "store").replace(/[^A-Za-z0-9_-]/g, "");
  return `${slug}-${orderId}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}
```

- `ParcelPayloadSnapshot` gains `courier_reference?: string` (optional so old snapshots still parse). `buildSnapshotObject` sets it with `courierReference(order.id)`.
- `buildCreateParcelInput(submission, order): ParcelRequest` → `{ reference: snapshot.courier_reference ?? courierReference(snapshot.order_id), orderId: snapshot.order_id, receiver: customer_name, phoneLocal: toLocalPhone(customer_phone), cityId: city_id ?? 0, cityName: city_name, address: address ?? "", codAmountMad: total, description: shipmentDescription(items), items: items.map(i => ({ name: i.name, options: i.options.map(o => ({ name: o.name, value: o.value })), quantity: i.quantity, sku: i.sku ?? null })) }`. Check the option field names on `CommerceOrderItem` in `src/lib/commerce-types.ts` and adapt.

### `ozon.ts`

- `name = "ozon"`, `profile = "ozon"`, `capabilities = COURIERS.ozon.capabilities`.
- `createParcel(input: ParcelRequest)` must send **exactly the same form fields as today**: `parcel-receiver`=receiver, `parcel-phone`=phoneLocal, `parcel-city`=cityId, `parcel-address`=address, `parcel-price`=codAmountMad, `parcel-nature`=description, `parcel-stock`=0; no `products`, no declared value, no open/fragile/replace (they were never set by the builder); `tracking-number` only when `OZON_USE_CUSTOM_TRACKING=1` (keep the existing behaviour, using `reference` only if the existing code used a custom code — otherwise leave unchanged). Keep all pre-network validation.
- Remove `syncCities` (moved). Keep `listCities` parsing unchanged (Ozon returns no Arabic/pickup/price → leave undefined).

### `city-sync.ts`

```ts
import { getDb } from "@/lib/db";
import { getProvider } from "./index";
import type { DeliveryProvider } from "./provider";

export async function syncCities(provider: DeliveryProvider = getProvider()): Promise<number> {
  const cities = await provider.listCities();
  const now = new Date().toISOString();
  const db = getDb();
  const upsert = db.prepare(`INSERT INTO cities (id, name, updated_at, provider, arabic_name, is_pickup)
    VALUES (@id, @name, @now, @provider, @arabic, @pickup)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at,
      provider = excluded.provider, arabic_name = excluded.arabic_name, is_pickup = excluded.is_pickup`);
  const prefill = db.prepare(`INSERT INTO city_tariffs (city_id, courier_cost, override_ignores_free_threshold, updated_by, updated_at)
    VALUES (?, ?, 0, NULL, ?) ON CONFLICT(city_id) DO NOTHING`);
  db.transaction(() => {
    for (const c of cities) {
      upsert.run({ id: c.id, name: c.name, now, provider: provider.name, arabic: c.arabicName ?? null, pickup: c.pickup ? 1 : 0 });
      if (typeof c.priceMad === "number" && Number.isInteger(c.priceMad) && c.priceMad >= 0) prefill.run(c.id, c.priceMad, now);
    }
  })();
  return cities.length;
}
```

Never overwrite an existing tariff. Don't delete cities. Check `city_tariffs` columns in `migrations/026_city_tariffs.sql` (`city_id PK, courier_cost, customer_fee_override, override_ignores_free_threshold, updated_by REFERENCES users(id), updated_at`) — `updated_by` NULL is allowed. Avoid a circular import problem: `index.ts` must not import `city-sync.ts`.

### `mock.ts`

`createMockProvider({ profile = "ozon", trackingStatuses? })`:
- Common: `name = "mock"`, `profile`, `capabilities = COURIERS[profile].capabilities`, same 5 city ids/names.
- `ozon` profile: **unchanged** behaviour (codes `OZEMOCK…`, BL refs `BLMOCK…`, default status `MOCK_CREATED`, cities with no extras).
- `sendit` profile: codes `SNDMOCK${bootId}${seq9}`; BL methods throw `ProviderError("permanent", "BL non pris en charge par ce transporteur")`; `deliveryNotePdfUrl` returns `mock://pdf/unsupported`; default tracking status `"PENDING"`; cities include `arabicName` (الدار البيضاء, الرباط, مراكش, فاس, أكادير), `pickup: true` only for Casablanca, `priceMad` 20/35/35/35/40; `getLabelsPdf(codes, format)` → `{ url: \`mock://labels/${format}/${codes.length}\` }`; `findParcelByReference(reference)` → `{complete:true, parcel}` from an in-memory `reference → code` map filled by `createParcel`, else `{complete:true, parcel:null}`; `testConnection()` resolves; `isConfigured()` true; `configurationIssues()` → `[]`.
- `track()`: found when the code starts with `OZEMOCK` **or** `SNDMOCK`; status from `trackingStatuses`/`setTrackingStatus`, else the profile default.

### `index.ts`

```ts
export function getProvider(): DeliveryProvider {
  const name = deliveryProviderName();
  if (name === "mock") {
    const profile = courierProfile();
    const g = globalThis as { __crmMockProviders?: Partial<Record<CourierName, MockProvider>> };
    g.__crmMockProviders ??= {};
    return (g.__crmMockProviders[profile] ??= createMockProvider({ profile }));
  }
  if (name === "sendit") throw new ProviderError("permanent", "Adaptateur Sendit indisponible"); // replaced in task 08
  return createOzonProvider();
}
```

Keep any existing test helper that reads `globalThis.__crmMockProvider` working: search scripts for `__crmMockProvider` and update them to the new map (`__crmMockProviders.ozon`).

### Tests

- Update `syncCities` imports to `@/lib/shipping/city-sync`.
- `mock-flow.test.mjs`: keep every existing assertion; add a block with `MOCK_COURIER_PROFILE=sendit` (set env before calling `getProvider()`, restore after) asserting: `SNDMOCK` codes, BL methods reject with kind `permanent`, `capabilities.deliveryNotes === false`, `syncCities` writes `provider='mock'`, `arabic_name`, `is_pickup=1` for Casablanca, and pre-fills `city_tariffs` for cities without a row but keeps an existing tariff unchanged; `buildCreateParcelInput` returns `reference` starting with the store slug and `phoneLocal` `06…`.

## Acceptance Criteria

- [ ] Ozon form fields for `add-parcel` are identical to before (verify by reading the diff of `buildParcelFields`).
- [ ] With no `MOCK_COURIER_PROFILE`, all existing suites pass unchanged (`test:crm`, `test:unit`, `test:catalog-agent`, `test:assistant`, `test:security`).
- [ ] Sendit-profile mock behaves as specified; city sync records provider, Arabic name, pickup flag and pre-fills only missing tariffs.
- [ ] Snapshots store `courier_reference`; old snapshots without it still build a request.
- [ ] No `toOzonPhone` references remain; `npm run lint`, `npx tsc --noEmit` pass.
