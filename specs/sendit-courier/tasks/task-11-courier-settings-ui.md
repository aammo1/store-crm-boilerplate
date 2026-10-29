# Task 11: Sendit settings UI

## Status

pending

## Wave

3

## Description

Give the admin a "Transporteur Sendit" section in CRM → Paramètres to choose the merchant **pickup district** (required before any Sendit parcel is sent) and the default "Autoriser l'ouverture" / "Autoriser l'essayage" flags. The section is shown only when the store behaves like Sendit (real Sendit or mock with `MOCK_COURIER_PROFILE=sendit`). Ozon stores see no change.

## Dependencies

**Depends on:** task-03-courier-settings-service.md, task-06-shipping-core-refactor.md
**Blocks:** task-17-docs-policy.md

**Context from dependencies:**
- Task 03: `GET /api/crm/courier-settings` (admin) → `{ settings: { senditPickupDistrictId: number|null, senditAllowOpen: boolean, senditAllowTry: boolean }, pickupDistricts: {id, name}[] }`; `PUT` same path with a partial body → `{ settings }` or `{ error }` (400 for unknown/non-pickup district, 403 bad origin). Service functions `getCourierSettings()` and `listPickupDistricts(provider)` exist in `@/lib/services/courier-settings`.
- Task 06: city sync stores `cities.is_pickup` (Sendit pickup-capable districts) and `cities.provider`. Sync is triggered at boot/daily and via the existing "sync cities" button (`POST /api/crm/cities/sync`).
- `src/lib/env.ts`: `courierProfile()` ("ozon"|"sendit"), `deliveryProviderName()`.
- Existing page `src/app/(admin)/crm/parametres/page.tsx` (admin) renders store settings (`store-settings-form.tsx`), blocklist and "Tarifs par ville" (`CityTariffsManager`). Follow `src/components/crm/store-settings-form.tsx` for form patterns, toasts/errors and UI primitives.

## Files to Create

- `src/components/crm/courier-settings-form.tsx` — client form.

## Files to Modify

- `src/app/(admin)/crm/parametres/page.tsx` — render the section when `courierProfile() === "sendit"`, passing initial settings and pickup districts from the services (server-side, no extra fetch on load).

## Technical Details

- Section title "Transporteur Sendit"; intro: "Ces réglages s'appliquent aux nouveaux colis. Les clés API restent dans les variables d'environnement."
- Pickup select: searchable if > 30 options (reuse `CityCombobox` from `src/components/crm/city-combobox.tsx` with `cities={pickupDistricts}`), placeholder "Choisir le district de ramassage…". If `pickupDistricts` is empty: warning "Aucun district de ramassage — synchronisez les villes (bouton « Synchroniser les villes » à la confirmation d'une commande, ou redémarrage) puis revenez ici." plus a "Synchroniser les villes" button that POSTs `/api/crm/cities/sync` then `router.refresh()`.
- Two switches/checkboxes: "Autoriser l'ouverture du colis" (default on), "Autoriser l'essayage" (default off).
- Save → `PUT /api/crm/courier-settings` with changed fields; show server error text; success toast "Réglages Sendit enregistrés.".
- When `senditPickupDistrictId` is null, show a red badge "Requis — aucun colis Sendit ne partira avant ce choix."
- Mobile-friendly layout consistent with the page.

## Acceptance Criteria

- [ ] Section visible only for Sendit-profile stores; hidden for Ozon.
- [ ] Admin can pick a pickup district, toggle flags, and see validation errors from the API.
- [ ] `npm run lint`, `npx tsc --noEmit`, `DELIVERY_PROVIDER=mock npm run build` pass.
