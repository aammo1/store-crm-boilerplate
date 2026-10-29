# Task 03: Courier settings service and API

## Status

complete

## Wave

1

## Description

Sendit needs per-store settings that are not secrets and must be editable by the admin after cities have synced: the merchant's **pickup district** (required on every Sendit parcel), and the default "allow opening" / "allow try-on" flags. They live in the CRM (CRM → Paramètres, UI in task 11), not in the wizard or env, because the district list only exists after a live sync. This task adds the zod schema, the DB service (stored as one JSON object in `app_state`) and an admin-only API. The Sendit adapter (task 08) reads these settings; no parcel is sent while the pickup district is unset.

## Dependencies

**Depends on:** None (Wave 1)
**Blocks:** task-08-sendit-adapter.md, task-11-courier-settings-ui.md

**Context from dependencies:** None. Follow the existing store-settings pattern:
- `src/lib/services/store-settings.ts` reads/writes `app_state` via `getAppState(key)` / `setAppState(key, value)` from `@/lib/services/app-state`, parses with zod, fails closed on corrupt state, and serializes updates with `getDb().transaction(() => …).immediate()`.
- `src/app/api/crm/settings/route.ts`: `requireAdmin()` from `@/lib/auth-guards`, `browserMutationAllowed(request)` from `@/lib/browser-mutation` (403 "Origine non autorisée."), `readLimitedJson(request, 4096)` from `@/lib/request-body`, JSON with `Cache-Control: no-store`, `AuthGuardError`/`RequestBodyError` mapped to their status.
- Zod comes from `@/lib/validation` (`import { z } from "@/lib/validation"`).
- The `cities` table will have `provider TEXT`, `arabic_name TEXT`, `is_pickup INTEGER` after migration 029 (task 02, same wave; only SQL strings depend on it).

## Files to Create

- `src/lib/courier-settings-schema.ts` — zod schemas + defaults (browser-safe).
- `src/lib/services/courier-settings.ts` — get/update + pickup district list.
- `src/app/api/crm/courier-settings/route.ts` — `GET` / `PUT`, admin only.
- `scripts/unit/courier-settings.test.mjs` — service unit test (temp DB).

## Files to Modify

- None.

## Technical Details

### Schema (`src/lib/courier-settings-schema.ts`)

```ts
import { z } from "@/lib/validation";

export const courierSettingsSchema = z.object({
  senditPickupDistrictId: z.number().int().positive().nullable(),
  senditAllowOpen: z.boolean(),
  senditAllowTry: z.boolean(),
}).strict();

export type CourierSettings = z.infer<typeof courierSettingsSchema>;

export const DEFAULT_COURIER_SETTINGS: CourierSettings = {
  senditPickupDistrictId: null,
  senditAllowOpen: true,
  senditAllowTry: false,
};

export const courierSettingsUpdateSchema = courierSettingsSchema.partial().strict();
```

### Service (`src/lib/services/courier-settings.ts`)

```ts
export const COURIER_SETTINGS_KEY = "courier_settings";
export function getCourierSettings(): CourierSettings;          // defaults when missing; zod-parse, fail closed
export function updateCourierSettings(input: unknown): CourierSettings; // partial merge in an immediate transaction
export function listPickupDistricts(provider: string): Array<{ id: number; name: string }>;
// SELECT id, name FROM cities WHERE provider = ? AND is_pickup = 1 ORDER BY name
```

Validation inside `updateCourierSettings`: when `senditPickupDistrictId` is a number, it must exist in `cities` with `is_pickup = 1` for the provider `deliveryProviderName()` (from `@/lib/env`). Otherwise throw an error with `status = 400` and message `District de ramassage inconnu — synchronisez les villes puis choisissez un district de ramassage.` (follow the existing service error pattern, e.g. a small `CourierSettingsError extends Error { status }`).

No boot-time writes: missing state returns defaults without writing.

### API (`src/app/api/crm/courier-settings/route.ts`)

- `export const runtime = "nodejs"`.
- `GET` → `requireAdmin()`, returns `{ settings, pickupDistricts: listPickupDistricts(deliveryProviderName()) }`.
- `PUT` → `requireAdmin()`, `browserMutationAllowed`, `readLimitedJson(request, 4096)`, `courierSettingsUpdateSchema.safeParse` (400 "Paramètres invalides."), `updateCourierSettings`, return `{ settings }`. Map `CourierSettingsError` to its status. No `revalidateStorefront()` (storefront unaffected).

### Test (`scripts/unit/courier-settings.test.mjs`)

Temp `DB_PATH`, `DELIVERY_PROVIDER=mock`, `AUTH_SECRET="x".repeat(40)`, `loadSource("@/lib/db")` then the service. Insert cities `(id, name, updated_at, provider, is_pickup)` with provider `mock`. Assert defaults, partial update merge, unknown/non-pickup district → status 400, valid pickup district saved, corrupt JSON in `app_state` throws.

## Acceptance Criteria

- [ ] Defaults returned without writing; updates merge and persist in `app_state.courier_settings`.
- [ ] Only pickup-capable districts of the active provider are accepted.
- [ ] API is admin-only and origin-checked for `PUT`.
- [ ] `npm run test:unit`, `npm run lint`, `npx tsc --noEmit` pass.
