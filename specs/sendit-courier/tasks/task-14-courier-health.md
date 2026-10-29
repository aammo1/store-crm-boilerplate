# Task 14: Courier health card and /api/health

## Status

pending

## Wave

4

## Description

A misconfigured courier silently leaves parcels queued (missing keys, no pickup district, cities never synced). Add a "Transporteur" health card on the CRM dashboard and courier details in `/api/health` (details mode only), so the owner sees immediately which courier is active, whether it is live or mock, what blocks submissions, and when cities/tracking last synced. Admins get a "Tester la connexion" button (one cheap authenticated call). Also surface the new `delivery_issue` tracking status as a "Colis à problème" alert and make the dashboard's BL card follow the courier's capabilities.

## Dependencies

**Depends on:** task-08-sendit-adapter.md, task-09-status-maps-tracking.md, task-10-expeditions-capabilities.md
**Blocks:** task-17-docs-policy.md

**Context from dependencies:**
- Providers (tasks 06/08): `name` (`mock|ozon|sendit`), `profile`, `capabilities`, `isConfigured?()`, `configurationIssues?(): string[]` (French reasons; Sendit: missing keys, pickup district not chosen), `testConnection?()` (Sendit: fresh login; mock: resolves). Ozon has no `configurationIssues`/`testConnection` — derive "Clés Ozon manquantes (OZON_CLIENT_ID, OZON_API_KEY)" from `isConfigured()` false.
- `COURIERS[profile].label` from `src/lib/shipping/couriers.ts`; `deliveryProviderName()`, `courierProfile()` from `src/lib/env.ts`.
- Task 09: normalized statuses now include `awaiting_pickup` and `delivery_issue` (UNREACHABLE/POSTPONED/NEW_DESTINATION for Sendit). Task 10: Sendit stores have no BL; label couriers' "ready" parcels are submitted + tracking number + not dispatched.
- `cities.provider` column; `app_state` key `tracking_last_sync` (`TRACKING_LAST_SYNC_KEY` in `src/lib/services/tracking.ts`), `getTrackingHealth()` in the same file.
- Existing `src/app/api/health/route.ts`: public response `{status, time}`; with `Authorization: Bearer HEALTH_DETAILS_TOKEN` adds `{db, provider: deliveryProviderName(), warnings, lease, workers, queues}`.
- Existing `src/lib/services/dashboard.ts` (~453 "Villes" health via `MAX(updated_at) FROM cities`; transit/unknown cards via `normalized_status`) and `src/app/(admin)/crm/page.tsx` ("À expédier (BL)" card ~454–462, BL ref on rows ~240, "Santé synchronisation" ~565–615, status label map ~38).

## Files to Create

- `src/lib/services/courier-health.ts` — `getCourierHealth()`.
- `src/components/crm/courier-health-card.tsx` — card + test button (client part only for the button).
- `src/app/api/crm/courier/test/route.ts` — `POST`, admin only.

## Files to Modify

- `src/app/api/health/route.ts` — add `courier` block in details mode.
- `src/lib/services/dashboard.ts` — cities health scoped to active provider; `delivery_issue` count.
- `src/app/(admin)/crm/page.tsx` — render the card; "Colis à problème" alert; BL card wording by capability; labels for `awaiting_pickup`/`delivery_issue` if not already added.

## Technical Details

### `getCourierHealth()`

```ts
export interface CourierHealth {
  courier: "ozon" | "sendit";   // profile
  label: string;
  mode: "live" | "mock";
  configured: boolean;
  issues: string[];              // French
  citiesCount: number;           // cities WHERE provider = deliveryProviderName()
  pickupDistrictSet: boolean | null; // null when capability absent
  lastCitiesSyncAt: string | null;   // MAX(updated_at) for provider
  lastTrackingSyncAt: string | null;
  queuedBlocked: number;         // queued jobs when !configured, else 0
  needsReview: number;
  deliveryIssues: number;        // submitted parcels with normalized_status = 'delivery_issue'
}
```
- Never throws: wrap `getProvider()`; on throw → `configured:false`, issue `"Transporteur indisponible : vérifiez DELIVERY_PROVIDER et les clés."` (no values).
- `citiesCount === 0` adds issue `"Aucune ville synchronisée — lancez la synchronisation."`.
- No network calls.

### Test route `POST /api/crm/courier/test`

`requireAdmin()`, `browserMutationAllowed`; if `testConnection` missing → `{ ok: true, skipped: true }` for mock, `{ ok:false, error:"Test non disponible pour ce transporteur." }` otherwise; call with try/catch → `{ ok: true }` or `{ ok: false, error: redactText(message) }`. Simple in-memory throttle: max 1 call per 10 s per process (429 otherwise).

### `/api/health` (details only)

Add `courier: { name: provider, profile, configured, issues, citiesCount, lastCitiesSyncAt, lastTrackingSyncAt }`. Public response unchanged.

### Dashboard

- Card "Transporteur : {label}" with badge Live/Mode test, list of issues (red) or "Prêt" (green), counts (villes, en attente bloqués, à résoudre, colis à problème), last syncs formatted Africa/Casablanca, admin-only "Tester la connexion" button (shows result inline).
- Alert row "Colis à problème : N (injoignable, reporté, adresse à changer)" linking to the orders list filtered by tracking status if such a filter exists (check `crm/orders/page.tsx` query params; otherwise no link).
- "À expédier (BL)" card: title "À expédier (BL)" for BL couriers, "À expédier (étiquettes)" for label couriers; BL ref on rows only for BL couriers.
- "Villes" sync health uses the active provider's rows.

## Acceptance Criteria

- [ ] Card shows correct state for: Ozon mock, Sendit-profile mock, Sendit without pickup district (issue listed, jobs blocked count), no cities.
- [ ] `/api/health` public output unchanged; details include `courier` without any secret.
- [ ] Test button admin-only, throttled, redacted errors.
- [ ] `npm run test:crm`, `npm run test:unit`, `npm run lint`, `npx tsc --noEmit`, `DELIVERY_PROVIDER=mock npm run build` pass.
