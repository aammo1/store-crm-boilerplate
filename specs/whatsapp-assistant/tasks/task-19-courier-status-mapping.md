# Task 19: Courier raw-status mapping

## Status

pending

## Wave

3

## Description

`src/lib/shipping/status-map.ts` has `STATUS_MAP = {}`, so every Ozon raw status normalizes to `unknown`, and AGENTS.md forbids inventing verified mappings. This task adds an **owner-maintained mapping that feeds notifications only**:
- The tracking poller records every raw status it sees, per provider, in `carrier_status_mappings`.
- Admins open a "Statuts transporteur" screen and assign each raw status a notification category: `in_transit`, `out_for_delivery`, `delivery_issue` or `ignore`.
- When a parcel's new observation has a raw status mapped to `out_for_delivery` or `delivery_issue`, the customer gets notification 3 or 4, at most once per order per day for each category.

Mappings **never** change stock, delivery outcomes, returns or `normalized_status`. Those still come only from the code `STATUS_MAP` and agent actions.

## Dependencies

**Depends on:** task-07-outbox-service.md (task-02, task-05 indirectly)
**Blocks:** None

**Context from dependencies:**
- Task 02 created `carrier_status_mappings(provider, raw_status, notify_category NULL|in_transit|out_for_delivery|delivery_issue|ignore, sample_count, first_seen_at, last_seen_at, mapped_by, mapped_at, PK(provider, raw_status))`. `courier_submissions.provider DEFAULT 'ozon'` comes from `specs/sendit-courier` task 02 (`migrations/029_courier_providers.sql`) — that task must be complete before this one. Note: the Sendit spec also adds a normalized `delivery_issue` status and a Sendit status map in `src/lib/shipping/status-map.ts`; owner notification mappings here stay separate and never change stock.
- Task 07 provides `enqueueOutbox({ dedupeKey, phone, purpose: "notify_out_for_delivery"|"notify_delivery_issue", body, orderId })`, which must run inside a transaction and skips when disabled.
- Task 05 provides `msgOutForDelivery(ctx & { totalMad })` and `msgDeliveryIssue(ctx)` in `src/lib/whatsapp/copy.ts`, plus `orderRefFromOrderId` in `src/lib/whatsapp/phone.ts`.
- Task 04 provides `getWhatsAppSettings()`, with `notifyOutForDelivery` and `notifyDeliveryIssue`.
- Task 14 already modified `src/app/(admin)/crm/parametres/page.tsx` to add the WhatsApp section. Add this section **after** it.
- Existing `src/lib/services/tracking.ts`:
  - `pollOnce(provider?)` fetches `track()` results and calls a `persistObservation(...)` function. It returns `applied` when a new `tracking_events` row is inserted (`UNIQUE(submission_id, raw_status, observed_at)`), then `applySideEffects()` runs for delivered and refused.
  - Read the file to find where `raw_status` and the submission or order are available after a new observation is applied, and hook in there, inside the same transaction if one exists.
- `deliveryProviderName()` in `src/lib/env.ts` returns `"mock" | "ozon"`. Customer locale logic: the conversation `language` (`ar`/`darija_arabic` → ar, otherwise fr) if a `wa_conversations` row exists for the phone, else `storeConfig.locale`.

## Files to Create

- `src/lib/services/carrier-status-map.ts`: `recordRawStatus`, `notifyCategoryFor`, `listRawStatuses`, `setNotifyCategory`.
- `src/app/api/crm/carrier-statuses/route.ts`: GET list (admin) / PUT `{ provider, rawStatus, category }` (admin).
- `src/components/crm/carrier-status-mapping.tsx`: client table.

## Files to Modify

- `src/lib/services/tracking.ts`: after each new observation, call `recordRawStatus(provider, raw)`. If the observation was newly applied, call `maybeNotifyFromRawStatus(orderId, submissionId, raw)`.
- `src/app/(admin)/crm/parametres/page.tsx`: add a section "Statuts transporteur (notifications)" that mounts the component.

## Technical Details

```ts
export function recordRawStatus(provider: string, rawStatus: string, now?: Date): void;
// trim, collapse spaces, max 200 chars; ignore empty; UPSERT sample_count+1, last_seen_at; first_seen_at on insert.
export function notifyCategoryFor(provider: string, rawStatus: string): NotifyCategory | null;
export function listRawStatuses(provider?: string): Array<{ provider; rawStatus; category; sampleCount; firstSeenAt; lastSeenAt; mappedBy; mappedAt }>; // unmapped first, then by last_seen desc
export function setNotifyCategory(provider: string, rawStatus: string, category: NotifyCategory | null, userId: string): void;
export function maybeNotifyFromRawStatus(orderId: string, submissionId: string, rawStatus: string, provider: string, now?: Date): void;
```

`maybeNotifyFromRawStatus`:
- Look up the category. Only `out_for_delivery` or `delivery_issue` trigger anything.
- Skip if the matching setting is off, if `orders.delivery_outcome` is not null, or if the order is cancelled.
- Purposes:
  - `out_for_delivery` uses `notify_out_for_delivery`, `msgOutForDelivery({ …, totalMad: order total })`, dedupe `order:${orderId}:ofd:${casablancaDate}`.
  - `delivery_issue` uses `notify_delivery_issue`, `msgDeliveryIssue`, dedupe `order:${orderId}:issue:${casablancaDate}`.
- Wrap it in a nested transaction plus try/catch that logs `wa.notify_failed`. It must never break the poller.

The provider name comes from `courier_submissions.provider` for that submission, falling back to `deliveryProviderName()`.

### UI

French, admin only.
- A table with columns: Transporteur, Statut brut, Vu (n fois), Dernière fois, Catégorie (select: "— non mappé —", "En transit", "En cours de livraison", "Problème / reporté", "Ignorer"), Mappé par.
- An explanatory note: "Ces correspondances servent uniquement aux notifications WhatsApp ; elles ne modifient jamais le stock ni les statuts de livraison."
- Unmapped rows are highlighted.
- Saving uses PUT for each row change.

## Acceptance Criteria

- [ ] In a mock-provider test, `setTrackingStatus()` on the mock (`src/lib/shipping/mock.ts`) followed by `pollOnce()` records the raw status.
- [ ] Mapping it to `out_for_delivery` and polling a new observation enqueues exactly one notification per order per day. An unmapped status enqueues nothing.
- [ ] Stock, `normalized_status`, delivery outcome and returns are unchanged by mappings. Existing `scripts/tracking-workflow.test.mjs` passes.
- [ ] Agents get 403 on the API.
- [ ] Unit test `scripts/unit/carrier-status-map.test.mjs`. Lint and tsc pass.
