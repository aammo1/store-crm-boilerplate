# Task 10: Expeditions by capability, labels, bulk handoff

## Status

pending

## Wave

3

## Description

The Expéditions page and the handoff rules are built around Ozon's BL (bon de livraison): handoff is refused unless the parcel is on a saved BL with a completed BL operation. Sendit has no BL — the merchant prints 10×10 labels and hands parcels to the driver. This task makes the page and the handoff gate follow the active courier's capabilities: **Ozon (deliveryNotes) stays exactly as today**; **Sendit (labels, no deliveryNotes)** gets a "labels board": select ready parcels → "Imprimer les étiquettes" (server-fetched PDF) → "Remis au livreur" per parcel or for the selection. Handoff stays an explicit agent action recorded through the existing `recordDispatch` (consumes reservations exactly once).

## Dependencies

**Depends on:** task-06-shipping-core-refactor.md
**Blocks:** task-14-courier-health.md

**Context from dependencies:**
- Task 06: `getProvider()` returns a provider with `capabilities` (`deliveryNotes`, `labels`, `labelFormats: {id,label}[]`, …) and optional `getLabelsPdf(trackingNumbers, format): Promise<{url}>`. In mock mode, `MOCK_COURIER_PROFILE=sendit` gives a Sendit-like mock (`deliveryNotes:false`, `labels:true`, format `10x10`, labels URL `mock://labels/…`, codes `SNDMOCK…`); default mock is Ozon-like and unchanged. The Sendit adapter itself (task 08, same wave) returns an `https://app.sendit.ma/...` PDF URL.
- `src/lib/env.ts` exports `courierProfile()`; `src/lib/shipping/couriers.ts` exports `COURIERS[profile]` with `label` and `capabilities` (browser-safe).
- Existing `src/lib/services/expeditions.ts`: `getShipmentBoard()` → `{ ready: readyParcels(), operations: pendingBlOperations(), savedNotes, dispatched }`; `handoffParcel(parcelId, actor)` (line ~384) requires confirmed order, `status='submitted'`, tracking number **and** a saved BL with completed operation (`saved_bl`), else 409 "Colis non transmis ou BL non enregistré…"; `handoffBl(blId, actor)`; `recordDispatch(orderId, actor)` returns `{orderId, alreadyDispatched, dispatchedAt}` and is idempotent; `HandoffError(status, message)`; `HandoffOutcome {submissionId, orderId, ok, alreadyDispatched, dispatchedAt, error?}`.
- Existing UI: `src/app/(admin)/crm/expeditions/page.tsx` renders `<BlBuilder ready operations savedNotes dispatched assistantEnabled/>` and `<BlDocumentArchive/>`; `src/components/crm/bl-print-actions.tsx` hard-codes Ozon formats.
- Existing route `src/app/api/crm/parcels/[id]/handoff/route.ts` (`requireUser`, `readLimitedJson`, `parcelHandoffSchema`, `handoffParcel(id, user.email ?? user.id)`, `HandoffError` → status). `src/app/api/crm/bl/[id]/pdf/route.ts` contains `placeholderPdf(ref)` (mock PDF bytes), a 20 s fetch with content-type check, and `redactText`.
- `browserMutationAllowed(request)` from `@/lib/browser-mutation` must guard new POST routes (CRM browser mutations).

## Files to Create

- `src/lib/pdf-placeholder.ts` — move `placeholderPdf` here (parameterised title/lines) and reuse it.
- `src/components/crm/label-shipping-board.tsx` — Sendit-style board (client).
- `src/app/api/crm/labels/pdf/route.ts` — `GET ?ids=<submissionId,…>&format=10x10`.
- `src/app/api/crm/parcels/handoff/route.ts` — bulk `POST { parcelIds: string[] }`.

## Files to Modify

- `src/lib/services/expeditions.ts` — capability-aware handoff gate; `handoffParcels(ids, actor)`; ready list for label couriers.
- `src/app/(admin)/crm/expeditions/page.tsx` — choose board by capability; copy.
- `src/app/api/crm/bl/[id]/pdf/route.ts` — import placeholder from `@/lib/pdf-placeholder` (no behaviour change).
- `src/components/crm/bl-print-actions.tsx` — no functional change for Ozon; only if it needs the shared helper.
- `src/lib/api-schemas.ts` — `parcelsHandoffSchema = z.object({ parcelIds: z.array(z.string().trim().min(1).max(64)).min(1).max(100) })`.

## Technical Details

### Handoff gate

```ts
function requiresSavedBl(): boolean { return getProvider().capabilities.deliveryNotes; }
```
- `handoffParcel`: keep the query; condition becomes `row.status !== "submitted" || !row.tracking_number || (requiresSavedBl() && !row.saved_bl)`. Label-courier message when not ready: `"Colis non transmis (pas de numéro de suivi) — remise au livreur impossible."`. Ozon message unchanged.
- `handoffParcels(ids, actor): { results: HandoffOutcome[] }` — dedupe ids, loop `handoffParcel` per id, catch `HandoffError` per item into `{ok:false, error}` (same shape as `handoffBl`). Reject with 409 when `requiresSavedBl()` is true (Ozon keeps BL handoff): `"Remise groupée réservée aux transporteurs sans BL — utilisez la remise par BL."`.
- `readyParcels()`: for label couriers, ready = confirmed order, `status='submitted'`, tracking number present, not dispatched (reuse the existing dispatch guard), **no BL condition**. For BL couriers, unchanged. Read the existing query and branch minimally.

### Labels route `GET /api/crm/labels/pdf`

- `requireUser()`; `ids` = comma-separated submission ids (1–100, each ≤ 64 chars, `[A-Za-z0-9_-]`); `format` must be one of `provider.capabilities.labelFormats[].id` (400 otherwise); 409 if `!capabilities.labels || !provider.getLabelsPdf`.
- Load `tracking_number` for each id where `status='submitted'` and tracking number not null; 404 if none; ignore others but report count in header `X-Labels-Skipped`.
- `const { url } = await provider.getLabelsPdf(codes, format)`. Non-http(s) URL (mock) → `placeholderPdf({ title: "Etiquettes - Mode test", lines: [\`${codes.length} colis\`] })`. Otherwise fetch server-side with 20 s timeout, require `content-type` containing `pdf`, stream with `Content-Type: application/pdf`, `Content-Disposition: inline; filename="etiquettes.pdf"`, `Cache-Control: no-store`. Never return or log the upstream URL. Errors → 502 JSON with neutral copy `"Étiquettes indisponibles — réessayez ou imprimez-les depuis le portail ${COURIERS[courierProfile()].label}."` and `redactText` for any detail.
- It's a GET with an external call: acceptable (read-only, authenticated); no state change.

### Bulk handoff route `POST /api/crm/parcels/handoff`

`requireUser()`, `browserMutationAllowed` (403 "Origine non autorisée."), `readLimitedJson(request, 32*1024)`, `parcelsHandoffSchema`, `handoffParcels(ids, user.email ?? user.id)`, map `HandoffError` → status. Response `{ results }`.

### Page

```tsx
const provider = getProvider(); // server component
const caps = provider.capabilities;
const label = COURIERS[courierProfile()].label;
```
- `caps.deliveryNotes` → current UI (BlBuilder + BlDocumentArchive), current copy.
- else → `<LabelShippingBoard ready={board.ready} dispatched={board.dispatched} formats={caps.labelFormats} courierLabel={label} />` and copy: "Imprimez les étiquettes {label} des colis prêts, collez-les, puis déclarez la remise au livreur." No BL archive.
- Wrap `getProvider()` in try/catch: if it throws (misconfigured), render the BL UI only when profile is ozon, otherwise the label board with a warning banner "Transporteur non configuré — voir le tableau de bord."

### `LabelShippingBoard` (client, mobile-friendly, French)

- Table/list of ready parcels (customer, city, total MAD, tracking code) with checkboxes + "Tout sélectionner".
- "Imprimer les étiquettes" → `window.open('/api/crm/labels/pdf?ids=…&format=10x10', '_blank')` (format from first `formats` entry; selector if > 1).
- "Remis au livreur" (selection) → `POST /api/crm/parcels/handoff`, show per-parcel result, `router.refresh()`. Per-row "Remis" button → existing `POST /api/crm/parcels/{id}/handoff`.
- Confirm dialog before bulk handoff: "Confirmer la remise de N colis au livreur ? Le stock sera sorti." Reuse existing UI primitives (`@/components/ui/*`) used by `bl-builder.tsx`.
- "Récemment remis" list from `dispatched`.

## Acceptance Criteria

- [ ] Ozon (default mock profile) Expéditions page and BL handoff behave exactly as before; `scripts/bl-workflow.test.mjs` passes unchanged.
- [ ] With `MOCK_COURIER_PROFILE=sendit`: ready parcels show without BL; labels route returns a PDF (placeholder); single and bulk handoff dispatch once (idempotent on repeat).
- [ ] Bulk handoff is refused for BL couriers; labels route refused when the courier has no labels capability.
- [ ] No courier URL or secret reaches the browser.
- [ ] `npm run test:crm`, `npm run lint`, `npx tsc --noEmit`, `DELIVERY_PROVIDER=mock npm run build` pass.
