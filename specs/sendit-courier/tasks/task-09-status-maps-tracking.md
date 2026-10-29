# Task 09: Per-courier status maps and tracking filter

## Status

complete

## Wave

3

## Description

Tracking statuses differ per courier. Today there is one global `STATUS_MAP` (empty on purpose for Ozon, so every Ozon status is `unknown` and delivered/refused are recorded manually). This task makes status maps per courier, fills the Sendit map from Sendit's vendor-published status list (so Sendit stores get automatic delivered/refused outcomes from day one), adds two normalized statuses (`awaiting_pickup`, `delivery_issue`), and makes the poller track only submissions of the active provider. The Ozon map stays empty and existing tests that patch it keep working.

## Dependencies

**Depends on:** task-05-neutral-copy-knobs.md, task-06-shipping-core-refactor.md
**Blocks:** task-14-courier-health.md, task-15-courier-contract-tests.md

**Context from dependencies:**
- Task 06: every provider exposes `profile: "ozon"|"sendit"`; the mock's `sendit` profile reports Sendit-style raw statuses (default `PENDING`), its `ozon` profile `MOCK_CREATED`. `courier_submissions.provider` holds `mock|ozon|sendit` (migration 029).
- Task 05 already switched `pollIntervalMin()`/`trackBatchSize()` in `src/lib/services/tracking.ts` to `courierNumberEnv`; don't revert.
- Task 01: `courierProfile()` and `deliveryProviderName()` in `src/lib/env.ts`.
- Existing `src/lib/shipping/status-map.ts`: `TRACKING_STATUSES = ["delivered","refused","cancelled","return_in_transit","in_transit","at_facility","out_for_delivery","unknown"] as const`, `STATUS_MAP: Record<string, NormalizedTrackingStatus> = {}`, `normalizeStatus(raw)` (empty → unknown; exact match; then case/separator-insensitive match; else unknown). Used by `services/tracking.ts:~344` and the list by `assistant-tools.ts:46`, `services/order-export.ts:97`, `services/orders.ts:472`.
- `services/tracking.ts` `pollOnce(provider?)` selects `submitted` rows with a tracking number (skips delivered/cancelled older than 45 days), groups codes, calls `p.track(slice)` per batch of `trackBatchSize()`, then `processResult` → `normalizeStatus` → `persistObservation` and `applySideEffects` (`delivered` → `recoverMissedDispatch` + `setDeliveryOutcome(…,'tracking')`; `refused`/`return_in_transit` → `ensureReturn`, refused also sets outcome; `cancelled` → log; others stored only).
- `scripts/tracking-workflow.test.mjs:~23` asserts `Object.keys(STATUS_MAP)` is `[]` and temporarily patches `STATUS_MAP` with `T_DELIVERED/T_TRANSIT/T_REFUSED` while running with the Ozon-profile mock.
- French labels for normalized statuses live in `src/app/(admin)/crm/orders/page.tsx` (~line 99) and `src/app/(admin)/crm/page.tsx` (~line 38; task 14 owns that file — don't edit it here).

## Files to Create

- None.

## Files to Modify

- `src/lib/shipping/status-map.ts` — per-courier maps, aliases, new statuses.
- `src/lib/services/tracking.ts` — normalize with the active courier; filter by provider; adapter-driven batching.
- `scripts/tracking-workflow.test.mjs` — keep Ozon assertions; add Sendit-profile cases.
- `src/app/(admin)/crm/orders/page.tsx` — labels for the two new statuses only.

## Technical Details

### `status-map.ts`

```ts
export const TRACKING_STATUSES = [
  "delivered", "refused", "cancelled", "return_in_transit",
  "in_transit", "at_facility", "out_for_delivery",
  "awaiting_pickup", "delivery_issue",
  "unknown",
] as const;

/** Ozon: empty until live verification (unchanged policy). Mutable for tests. */
export const OZON_STATUS_MAP: Record<string, NormalizedTrackingStatus> = {};
/** Backward-compatible alias used by existing tests. */
export const STATUS_MAP = OZON_STATUS_MAP;

/** Source: Sendit official WooCommerce plugin (sendit-ma-integration v2.2.x), GET /all-status-deliveries. */
export const SENDIT_STATUS_MAP: Record<string, NormalizedTrackingStatus> = {
  PENDING: "awaiting_pickup", TO_PREPARE: "awaiting_pickup", TOPICKUP: "awaiting_pickup",
  PICKEDUP: "in_transit", TRANSIT: "in_transit",
  WAREHOUSE: "at_facility", DISTRIBUTED: "at_facility",
  DELIVERING: "out_for_delivery",
  UNREACHABLE: "delivery_issue", POSTPONED: "delivery_issue", NEW_DESTINATION: "delivery_issue",
  DELIVERED: "delivered",
  REJECTED: "refused",
  RETURNED: "return_in_transit",
  CANCELED: "cancelled",
};
const SENDIT_ALIASES: Record<string, string> = {
  TO_PICKUP: "TOPICKUP", PICKED_UP: "PICKEDUP", CANCELLED: "CANCELED",
  IN_TRANSIT: "TRANSIT", RETOUR: "RETURNED", RETURN: "RETURNED",
};

export const STATUS_MAPS: Record<CourierName, Record<string, NormalizedTrackingStatus>> = {
  ozon: OZON_STATUS_MAP, sendit: SENDIT_STATUS_MAP,
};

export function normalizeStatus(raw: string | null | undefined, courier: CourierName = "ozon"): NormalizedTrackingStatus
```

For `sendit`: uppercase+trim, apply alias, exact lookup, else `unknown`. For `ozon`: keep today's algorithm on `OZON_STATUS_MAP` exactly. Default param `"ozon"` keeps old call sites compiling.

Also export `SENDIT_STATUS_LABELS` (French): PENDING "En attente", TO_PREPARE "À préparer", NEW_DESTINATION "À changer", TOPICKUP "Ramassage en cours", PICKEDUP "Ramassé", WAREHOUSE "Entrepôt", TRANSIT "En transit", DISTRIBUTED "Distribué", UNREACHABLE "Injoignable", POSTPONED "Reporté", DELIVERING "En cours de livraison", DELIVERED "Livré", CANCELED "Annulé", REJECTED "Refusé", RETURNED "Retourné" (used by task 13/14 UI).

### `services/tracking.ts`

- `normalizeStatus(rawStatus, provider.profile)` where `provider` is the one passed to/created by `pollOnce` (`p.profile`).
- Poll query adds `AND cs.provider = ?` bound to `deliveryProviderName()` (mock in tests). Old rows default `'ozon'`, so live Ozon stores are unaffected.
- Batching: if `p.capabilities.bulkTracking` is false, still call `p.track(slice)` with the same batches (the adapter limits its own concurrency) — no change needed beyond making sure a result with `rawStatus: null` just touches `last_sync_at` (existing behaviour).
- `delivery_issue` and `awaiting_pickup` have **no side effects** (stored only), like `in_transit`.
- Sticky/stale ordering logic unchanged.

### Labels (`crm/orders/page.tsx`)

Add `awaiting_pickup: "En attente de ramassage"`, `delivery_issue: "Colis à problème"` to the existing map. If TypeScript requires exhaustive maps elsewhere (`grep -rn "out_for_delivery" src`), add the two labels there too **except** `src/app/(admin)/crm/page.tsx` (task 14) — if that file fails to compile because of a `Record<NormalizedTrackingStatus,…>`, add only the two keys there and mention it in your summary.

### Tests (`scripts/tracking-workflow.test.mjs`)

Keep existing Ozon assertions (map empty, patched-map side effects). Add a Sendit block (set `MOCK_COURIER_PROFILE=sendit`, fresh mock provider via `createMockProvider({profile:"sendit"})` passed to `pollOnce`): `DELIVERED` → delivered outcome + dispatch recovery, `REJECTED` → return + refused, `UNREACHABLE` → `delivery_issue` with no outcome, `picked_up` alias → `in_transit`, unknown code → `unknown`. Also assert a submission whose `provider` differs from the active provider is not polled.

## Acceptance Criteria

- [ ] Ozon map remains empty; existing tracking tests pass unchanged in meaning.
- [ ] Sendit statuses normalize per the table, aliases included; side effects fire only for delivered/refused/return/cancelled.
- [ ] Poller ignores other providers' submissions.
- [ ] `npm run test:crm`, `npm run test:unit`, `npm run lint`, `npx tsc --noEmit` pass.
