# Task 13: "Chercher chez Sendit" lookup

## Status

complete

## Wave

4

## Description

When a parcel creation is uncertain (timeout, 5xx, 200 without code), the submission goes to `needs_review` and an agent must check the courier portal, then resolve it ("parcel exists" with its tracking number, or "no parcel" to requeue). For couriers that support it (Sendit), add a **read-only** "Chercher chez {courier}" button in the resolution form: it searches the courier by the customer's phone and matches our exact per-store reference. A match pre-fills the tracking number and evidence; the agent still submits the resolution. It never changes state by itself, preserving the "no blind retry" policy.

## Dependencies

**Depends on:** task-08-sendit-adapter.md
**Blocks:** task-17-docs-policy.md

**Context from dependencies:**
- Task 08 / 06: providers with `capabilities.parcelLookup` implement `findParcelByReference(reference, phoneLocal): Promise<{ complete: boolean; parcel: { trackingNumber: string; rawStatus: string|null } | null }>` (Sendit: phone search, exact reference, ignores dead statuses, ≤ 3 pages; mock Sendit profile: in-memory). `complete:false` means the search couldn't finish — absence proves nothing.
- The payload snapshot (`courier_submissions.payload_json`) contains `courier_reference` ("<slug>-<orderId>") and `customer_phone` (+212…); `courierReference(orderId)` and `buildCreateParcelInput` live in `src/lib/shipping/parcel-payload.ts`; `toLocalPhone` in `src/lib/phone.ts`.
- `SENDIT_STATUS_LABELS` (French labels per raw code) is exported from `src/lib/shipping/status-map.ts` (task 09).
- Existing resolution: `src/lib/services/submission-resolution.ts` (only `needs_review`/`failed` jobs; outcomes `parcel_exists` with tracking number → submitted, `no_parcel` → queued; evidence ≥ 10 chars); route `POST /api/crm/submissions/[id]/resolve`; UI `src/components/crm/submission-resolve-form.tsx` mounted on `src/app/(admin)/crm/orders/[id]/page.tsx`. Task 05 made its copy courier-neutral.
- Auth: `requireUser()` from `@/lib/auth-guards`; `browserMutationAllowed(request)`.

## Files to Create

- `src/lib/services/courier-lookup.ts` — `lookupSubmissionAtCourier(submissionId)`.
- `src/app/api/crm/submissions/[id]/lookup/route.ts` — `POST`.

## Files to Modify

- `src/components/crm/submission-resolve-form.tsx` — optional lookup button + result panel.
- `src/app/(admin)/crm/orders/[id]/page.tsx` — pass `lookupCourierLabel` (string) when `getProvider().capabilities.parcelLookup`, else nothing.

## Technical Details

### Service

```ts
export type LookupResult =
  | { status: "found"; trackingNumber: string; rawStatus: string | null; statusLabel: string | null; reference: string }
  | { status: "not_found"; reference: string }      // complete search, nothing
  | { status: "inconclusive"; reference: string; message: string };

export async function lookupSubmissionAtCourier(submissionId: string): Promise<LookupResult>
```
- Load the submission + order; only `needs_review` or `failed` (409 otherwise, `LookupError(status, message)`).
- `provider = getProvider()`; 409 if no `parcelLookup` capability.
- `reference = snapshot.courier_reference ?? courierReference(order_id)`; `phone = toLocalPhone(snapshot.customer_phone)`.
- Call `findParcelByReference`; map: parcel → `found` (label via `SENDIT_STATUS_LABELS[rawStatus]` when profile is sendit); `complete && !parcel` → `not_found`; else → `inconclusive` ("Recherche incomplète — vérifiez sur le portail."). `ProviderError` → `inconclusive` with redacted message.
- **No DB writes.** Log `courier.lookup` with submission id and result status only (no phone).

### Route

`POST /api/crm/submissions/[id]/lookup`: `requireUser()`, `browserMutationAllowed` (403), call service, return JSON result; `LookupError` → status. Runtime nodejs, `Cache-Control: no-store`.

### UI

- Prop `lookupCourierLabel?: string`. When set, show button "Chercher chez {label}" above the outcome choice.
- found → green panel "Colis trouvé : {trackingNumber} ({statusLabel ?? rawStatus ?? "statut inconnu"}) — référence {reference}". Button "Utiliser ce résultat" selects outcome `parcel_exists`, fills tracking number, fills evidence `Recherche API {label} le {date Africa/Casablanca} : colis {trackingNumber}, référence {reference}.` (agent can edit).
- not_found → neutral panel "Aucun colis actif avec la référence {reference} chez {label}." + button "Utiliser ce résultat" pre-selecting `no_parcel` with evidence `Recherche API {label} le {date} : aucun colis actif pour la référence {reference}.` Warn: "Vérifiez aussi le portail si un doute subsiste."
- inconclusive → amber panel with the message; nothing pre-filled.
- Submission still goes through the existing resolve endpoint.

## Acceptance Criteria

- [ ] Button appears only for couriers with `parcelLookup` (Sendit / Sendit-profile mock) on `needs_review`/`failed` submissions.
- [ ] Lookup never writes to the DB; resolution still requires the agent's submit.
- [ ] Found / not found / inconclusive render and pre-fill as specified.
- [ ] `npm run test:crm`, `npm run lint`, `npx tsc --noEmit` pass.
