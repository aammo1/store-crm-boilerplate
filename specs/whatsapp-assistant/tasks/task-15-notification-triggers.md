# Task 15: Notification triggers

## Status

complete

## Wave

3

## Description

This task wires order lifecycle events to the WhatsApp outbox. Each enqueue happens **inside the same DB transaction** as the business change, following the Meta outbox pattern, but inside a nested savepoint wrapped in try/catch. That way a WhatsApp problem can **never** roll back or block a confirmation, submission or outcome.

| Event | Customer message | Admin alert / other |
|---|---|---|
| Confirmed | 1 | Admin alert to every admin phone |
| Parcel submitted with tracking number | 2 | |
| Delivered | 5 | |
| Refused | None | Admin alert, plus a `refused_delivery` strike |
| Cancelled | 7 (optional) | Pending notifications for the order are cancelled |
| `no_answer` ×N, at least 2 h apart | **One** relance | |

The task also cleans WhatsApp rows when an order is deleted or archived.

## Dependencies

**Depends on:** task-05-phone-and-copy.md, task-07-outbox-service.md, task-09-strikes-autoblock.md, task-12-drafts-proposals-requests.md
**Blocks:** None

**Context from dependencies:**
- Task 07 provides `src/lib/services/whatsapp-outbox.ts`:
  - `enqueueOutbox({ dedupeKey, phone, purpose, body, orderId?, conversationId? }): boolean`. It must run inside the caller's transaction, and it silently skips when WhatsApp, the notifications or the phone are disabled, blocked or `no_whatsapp`.
  - `cancelQueuedForOrder(orderId, purposes?)`.
  - Purposes: `notify_confirmed`, `notify_shipped`, `notify_delivered`, `notify_cancelled`, `relance_no_answer`, `admin_alert`.
- Task 05 provides these builders in `src/lib/whatsapp/copy.ts`:
  - `msgConfirmed`, `msgShipped`, `msgDelivered`, `msgCancelled`, `msgRelanceNoAnswer` (ctx `{ locale, storeName, assistantName, firstName, ref, seed, … }`)
  - `msgAdminConfirmed({ ref, itemsSummary, totalMad, cityName, actorName })`, `msgAdminRefused({ ref, totalMad, cityName })`, `msgAdminAutoBlocked({ maskedPhone, reason })`

  And in `src/lib/whatsapp/phone.ts`: `orderRefFromOrderId`, `maskPhone`.
- Task 09 provides `addStrike({ phone, reason: "refused_delivery", orderId })` in `src/lib/services/whatsapp-strikes.ts`, returning a `StrikeDecision` (`blocked` means it was just auto-blocked).
- Task 12 provides `clearDraft(orderId)` in `src/lib/services/whatsapp-staging.ts`.
- Task 04 provides `getWhatsAppSettings()` (`notifyConfirmed`, `notifyShipped`, `notifyDelivered`, `notifyCancelled`, `relanceAfterNoAnswer`, `relanceNoAnswerCount`, `adminAlertsEnabled`, `adminPhones`) and `effectiveAssistantName(settings, storeName)`.
- Existing code:
  - `src/lib/services/confirmation.ts`:
    - `confirmOrder(orderId, input, actor: { id, name? })` runs `db.transaction(...)`. It returns early when already confirmed (no notification in that case). It updates `confirmation_status='confirmed'` and calls `createSubmission()`.
    - `cancelOrder(orderId, { reason }, actor)`.
  - `src/lib/workers/submission.ts` `processOne()` calls `setStatus(id, "submitted", { trackingNumber, … })`.
  - `src/lib/services/delivery-outcomes.ts` `setDeliveryOutcome(orderId, outcome: "delivered"|"refused", actor, source, reason?)` runs in a transaction. Tracking can't override an agent outcome. An admin may change an existing outcome.
  - `src/lib/services/orders.ts` `insertContact(input: { orderId, agentId, channel, outcome, note?, nextCallbackAt? })` inserts into `order_contacts`.
  - `src/lib/services/order-lifecycle.ts` `changeOrderLifecycle()`. Its delete branch removes `meta_events`, `tiktok_events`, `meta_purchases`, `tiktok_purchases`, `manual_order_requests` and `order_contacts` rows before `DELETE FROM orders`.
  - `getCrmOrder(id)` in `orders.ts` returns the order with items, customer name and phone, city and totals. Check the field names. `summarizeItems(items)` builds "2× Produit X (42)"-style text.
  - Store name comes from `getStoreSettings().storeName` (`src/lib/services/store-settings.ts`). Locale comes from `storeConfig.locale` (`@/config`). The public URL is `process.env.CRM_PUBLIC_URL`.

## Files to Create

- `src/lib/whatsapp/notify.ts`: the helpers that build and enqueue each notification. All trigger sites call these.

## Files to Modify

- `src/lib/services/confirmation.ts`: after the confirmed update inside `confirmOrder`, call `notifyOrderConfirmed(orderId, actor)` and `clearDraft(orderId)`. In `cancelOrder`, call `notifyOrderCancelled(orderId)`.
- `src/lib/workers/submission.ts`: wrap the `setStatus(id, "submitted", …)` call and `notifyOrderShipped(orderId, trackingNumber)` in one `getDb().transaction`.
- `src/lib/services/delivery-outcomes.ts`: inside the transaction, after a successful write: delivered calls `notifyOrderDelivered(orderId)`; refused calls `onOrderRefused(orderId)`.
- `src/lib/services/orders.ts`: in `insertContact`, after inserting an outcome `no_answer`, call `maybeEnqueueNoAnswerRelance(orderId)`.
- `src/lib/services/order-lifecycle.ts`:
  - **Delete:** delete `wa_outbox`, `wa_conversation_orders`, `wa_order_drafts` and `wa_proposals` rows where `order_id = id`. Set `wa_requests.order_id = NULL` for that order.
  - **Archive:** `cancelQueuedForOrder(id)`.

## Technical Details

### Safe wrapper

All functions in `notify.ts` use it:

```ts
function safely(label: string, fn: () => void): void {
  try { getDb().transaction(fn)(); } // nested => SAVEPOINT; failure rolls back only WhatsApp writes
  catch (err) { log.error("wa.notify_failed", { label, error: err }); }
}
```

### Locale for customer messages

1. If a `wa_conversations` row exists for the phone with a `language`:
   - `ar` or `darija_arabic` gives `ar`
   - `fr` or `darija_latin` gives `fr`
2. Otherwise use `storeConfig.locale`.

The first name is the first word of `customer_name`, at most 30 characters. `seed = orderId + purpose`.

### Functions

| Function | Dedupe key(s) | Condition / effect |
|---|---|---|
| `notifyOrderConfirmed(orderId, actor)` | Customer: `order:${id}:confirmed`. Admin: `admin:${id}:confirmed:${adminPhone}` | Customer message if `notifyConfirmed`. One admin message per `adminPhones` entry if `adminAlertsEnabled`, with `actorName = actor.name`. City only, never the address. |
| `notifyOrderShipped(orderId, trackingNumber)` | `order:${id}:shipped` | Only if `notifyShipped` and the tracking number is non-empty. `trackUrl = ${CRM_PUBLIC_URL}/suivi?ref=${ref}`. |
| `notifyOrderDelivered(orderId)` | `order:${id}:delivered` | If `notifyDelivered` |
| `onOrderRefused(orderId)` | Admin: `admin:${id}:refused:${phone}` | Admin alerts, no customer message. Then `addStrike({ phone: customer_phone, reason: "refused_delivery", orderId })`. If the decision is `blocked`, also send `msgAdminAutoBlocked` to admins, deduped as `admin:autoblock:${customerPhone}:${date}`. The strike only runs when WhatsApp `enabled` is true. |
| `notifyOrderCancelled(orderId)` | `order:${id}:cancelled` | Always `cancelQueuedForOrder(orderId, ["notify_confirmed","notify_shipped","relance_no_answer"])`. Then a customer message only if `notifyCancelled`. Then the **repeated-cancel strike** (only when WhatsApp `enabled`): count this phone's cancelled orders that had been confirmed, meaning a `courier_submissions` row exists for the order (created at confirmation). If the count is ≥3, call `addStrike({ phone, reason: "repeated_cancel", orderId })`. The unique `(order_id, reason)` index prevents double counting. |
| `maybeEnqueueNoAnswerRelance(orderId)` | `order:${id}:relance` | See below |

`maybeEnqueueNoAnswerRelance(orderId)` enqueues only when **all** of these hold:
- `relanceAfterNoAnswer` is on
- the order status is `new`, `no_answer` or `call_back_later`
- the count of `order_contacts` with `outcome='no_answer'` is at least `relanceNoAnswerCount`
- the time between the first and the latest `no_answer` is at least 2 h
- no `wa_messages` inbound row exists yet for a conversation linked to this order. If the customer already wrote, there's no need for a relance.

The dedupe key guarantees it's sent once, ever.

**Important:** the confirmed hook only runs on the path that newly confirms, not the idempotent early return. The shipped hook only runs on the success path. No hook may throw.

## Acceptance Criteria

- [ ] With WhatsApp disabled (the default), every existing test in `npm run test:crm` passes unchanged, and no `wa_outbox` rows are created.
- [ ] With it enabled in a test DB:
  - confirming creates 1 customer row and 1 row per admin phone
  - confirming twice creates nothing more
  - submission success creates a shipped row
  - delivered creates a delivered row
  - refused creates an admin row and a strike, with no customer row
  - a cancel removes queued confirmed and relance rows
  - two `no_answer` contacts 2 h+ apart create one relance; two within 1 h create none
- [ ] An exception thrown inside the outbox (simulate it by dropping the table in a test) doesn't break `confirmOrder`.
- [ ] Deleting an order removes its WhatsApp rows, and the FK check is clean.
- [ ] Unit or integration test `scripts/unit/whatsapp-notify.test.mjs`. Lint and tsc pass.
