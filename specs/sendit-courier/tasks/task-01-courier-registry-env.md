# Task 01: Courier registry and env selection

## Status

complete

## Wave

1

## Description

Create the single source of truth for which couriers exist and what they can do, and teach runtime env selection about Sendit. Today `DELIVERY_PROVIDER` only knows `mock` and `ozon` (`src/lib/env.ts`), and nothing describes courier capabilities, so the CRM hard-codes Ozon's BL flow. This task adds a browser-safe registry (`src/lib/shipping/couriers.ts`), extends `deliveryProviderName()` to return `sendit` for an exact `sendit`, adds `courierProfile()` (which courier the store *behaves* like, including in mock mode via `MOCK_COURIER_PROFILE`), validates Sendit env in production, and provides a helper for the generic `COURIER_*` worker knobs with `OZON_*` fallback. No behaviour changes for existing Ozon/mock stores.

## Dependencies

**Depends on:** None (Wave 1)
**Blocks:** task-05-neutral-copy-knobs.md, task-06-shipping-core-refactor.md, task-07-wizard-courier-choice.md

**Context from dependencies:** None. Existing code: `src/lib/env.ts` exports `type DeliveryProviderName = "mock" | "ozon"`, `deliveryProviderName(env)` (exact `"mock"` → mock, else `"ozon"`), `validateRuntimeEnv(env)` (production-only, not during `NEXT_PHASE=phase-production-build`; requires `DELIVERY_PROVIDER` exactly `mock` or `ozon`, and `OZON_CLIENT_ID`/`OZON_API_KEY` for ozon) and `runtimeEnvWarnings(env)`. Error messages name variables only, never values. `scripts/unit/env.test.mjs` asserts e.g. `deliveryProviderName({DELIVERY_PROVIDER:"Mock"}) === "ozon"` and `{}` → `"ozon"` — keep those.

## Files to Create

- `src/lib/shipping/couriers.ts` — courier metadata registry (no imports of adapters, DB, env or secrets; safe for client components).

## Files to Modify

- `src/lib/env.ts` — add `sendit`, `courierProfile()`, Sendit validation, `MOCK_COURIER_PROFILE` handling, `courierNumberEnv()` helper.
- `scripts/unit/env.test.mjs` — add cases (keep existing ones passing).

## Technical Details

### `src/lib/shipping/couriers.ts`

```ts
export type CourierName = "ozon" | "sendit";

export interface LabelFormat { id: string; label: string }

export interface CourierCapabilities {
  /** Ozon-style BL: create → attach → save, and handoff requires a saved BL. */
  deliveryNotes: boolean;
  /** Courier can return printable parcel labels for a set of tracking codes. */
  labels: boolean;
  labelFormats: LabelFormat[];
  /** Read-only lookup of an existing parcel by our reference (+ phone). */
  parcelLookup: boolean;
  /** One request can track many codes (Ozon). False = one request per code. */
  bulkTracking: boolean;
  /** Courier requires a merchant pickup district chosen in CRM settings. */
  pickupDistrict: boolean;
}

export interface CourierDefinition {
  name: CourierName;
  /** French display name used in CRM copy ("portail {label}"). */
  label: string;
  portalUrl: string;
  capabilities: CourierCapabilities;
  /** Env vars required when DELIVERY_PROVIDER selects this courier in production. */
  requiredEnv: string[];
  /** Env vars whose values must be redacted anywhere they could leak. */
  secretEnv: string[];
}

export const COURIERS: Record<CourierName, CourierDefinition> = {
  ozon: {
    name: "ozon",
    label: "Ozon Express",
    portalUrl: "https://client.ozoneexpress.ma",
    capabilities: {
      deliveryNotes: true,
      labels: false, // Ozon labels come from the BL PDF formats, not a per-parcel endpoint
      labelFormats: [],
      parcelLookup: false,
      bulkTracking: true,
      pickupDistrict: false,
    },
    requiredEnv: ["OZON_CLIENT_ID", "OZON_API_KEY"],
    secretEnv: ["OZON_CLIENT_ID", "OZON_API_KEY"],
  },
  sendit: {
    name: "sendit",
    label: "Sendit",
    portalUrl: "https://app.sendit.ma",
    capabilities: {
      deliveryNotes: false,
      labels: true,
      labelFormats: [{ id: "10x10", label: "Étiquettes 10×10" }],
      parcelLookup: true,
      bulkTracking: false,
      pickupDistrict: true,
    },
    requiredEnv: ["SENDIT_PUBLIC_KEY", "SENDIT_SECRET_KEY"],
    secretEnv: ["SENDIT_PUBLIC_KEY", "SENDIT_SECRET_KEY"],
  },
};

export const COURIER_NAMES = Object.keys(COURIERS) as CourierName[];

export function courierDefinition(name: CourierName): CourierDefinition {
  return COURIERS[name];
}
```

Keep the exported shape exactly; later tasks import `COURIERS`, `CourierName`, `CourierCapabilities`, `courierDefinition`, `COURIER_NAMES`. `scripts/new-store/couriers.mjs` (task 07) mirrors names/labels/requiredEnv and a unit test checks they match.

### `src/lib/env.ts` changes

```ts
import { COURIERS, type CourierName } from "./shipping/couriers";

export type DeliveryProviderName = "mock" | CourierName; // "mock" | "ozon" | "sendit"

export function deliveryProviderName(env = process.env): DeliveryProviderName {
  if (env.DELIVERY_PROVIDER === "mock") return "mock";
  if (env.DELIVERY_PROVIDER === "sendit") return "sendit";
  return "ozon"; // unset or any other value keeps Ozon (AGENTS.md rule)
}

/** Courier the store behaves like. In mock mode: exact MOCK_COURIER_PROFILE=sendit → sendit, else ozon. */
export function courierProfile(env = process.env): CourierName {
  const provider = deliveryProviderName(env);
  if (provider !== "mock") return provider;
  return env.MOCK_COURIER_PROFILE === "sendit" ? "sendit" : "ozon";
}

/** Generic courier worker knob with legacy OZON_* fallback. Returns undefined when neither is set/valid. */
export function courierNumberEnv(suffix: "SUBMIT_INTERVAL_SEC" | "POLL_INTERVAL_MIN" | "TRACK_BATCH", env = process.env): number | undefined {
  for (const key of [`COURIER_${suffix}`, `OZON_${suffix}`]) {
    const raw = env[key];
    if (raw === undefined || raw.trim() === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
```

- `validateRuntimeEnv`: accept exactly `mock`, `ozon` or `sendit` (message: `DELIVERY_PROVIDER doit valoir "mock", "ozon" ou "sendit"`). For a real courier, push `"<VAR> manquant"` for each blank `COURIERS[name].requiredEnv`. If `MOCK_COURIER_PROFILE` is set and not `ozon`/`sendit`, push `MOCK_COURIER_PROFILE doit valoir "ozon" ou "sendit"`.
- `runtimeEnvWarnings`: unchanged mock warning; no new warnings.
- Do **not** import anything server-only into `couriers.ts`; `env.ts` importing `couriers.ts` is fine (pure data).
- Do not change callers of `deliveryProviderName()` in this task; widening the union is type-compatible except for exhaustive switches — run `npx tsc --noEmit` and fix any narrowing error minimally (e.g. `src/app/api/health/route.ts` just prints it).

### Environment Variables

- `DELIVERY_PROVIDER` — `mock` | `ozon` | `sendit`.
- `MOCK_COURIER_PROFILE` — `ozon` (default) | `sendit`; only read when `DELIVERY_PROVIDER=mock`.
- `SENDIT_PUBLIC_KEY`, `SENDIT_SECRET_KEY` — required when `DELIVERY_PROVIDER=sendit` in production.
- `COURIER_SUBMIT_INTERVAL_SEC`, `COURIER_POLL_INTERVAL_MIN`, `COURIER_TRACK_BATCH` — generic knobs (consumers switched in task 05); `OZON_*` remain fallbacks.

### Tests (`scripts/unit/env.test.mjs`)

Add: `sendit` → `"sendit"`; `"Sendit"` → `"ozon"`; production `sendit` without keys reports both `SENDIT_*` names and never their values; production `sendit` with keys passes; `courierProfile({DELIVERY_PROVIDER:"mock", MOCK_COURIER_PROFILE:"sendit"})` → `"sendit"`, without profile → `"ozon"`, `{DELIVERY_PROVIDER:"sendit"}` → `"sendit"`; invalid `MOCK_COURIER_PROFILE` in production is reported; `courierNumberEnv("POLL_INTERVAL_MIN", {OZON_POLL_INTERVAL_MIN:"30"})` → 30 and `COURIER_` wins over `OZON_`.

## Acceptance Criteria

- [ ] `src/lib/shipping/couriers.ts` exists with the exact exports above and no server-only imports.
- [ ] `deliveryProviderName`, `courierProfile`, `courierNumberEnv` behave as specified; existing env tests still pass.
- [ ] Production validation accepts `sendit` with keys and rejects it without, naming variables only.
- [ ] `npm run test:unit`, `npm run lint`, `npx tsc --noEmit` pass.
