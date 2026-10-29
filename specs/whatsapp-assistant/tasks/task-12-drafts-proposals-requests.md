# Task 12: Drafts, proposals and WhatsApp requests

## Status

complete

## Wave

2

## Description

The AI never mutates orders. It writes into three staging areas that humans act on:
1. **Order drafts** (`wa_order_drafts`): the address, city and note the AI collected for an unconfirmed order, plus a `ready_to_confirm` flag. The agent's Confirm form is pre-filled from it. The agent still clicks Confirm, which reserves stock and queues the parcel.
2. **Proposals** (`wa_proposals`): order **edits** (variant, size, quantity) or a **cancel** request. An agent approves them, and approval applies through the existing `editOrder()` / `cancelOrder()` services, which re-price on the server. A rejection just records the decision.
3. **WhatsApp requests** (`wa_requests`): pre-sales buyers who refuse to use the checkout link. The AI records name, items, city and address, and an agent converts the request into a manual order.

## Dependencies

**Depends on:** task-02-migration-whatsapp.md
**Blocks:** task-17-ai-agent, task-18-inbox-api, task-25-order-panel-proposals-ui

**Context from dependencies:**
- Task 02 created these tables:
  - `wa_order_drafts(order_id PK, conversation_id, address ≤500, city_id, city_name, note, ready_to_confirm, updated_at)`
  - `wa_proposals(id, order_id, conversation_id, kind edit|cancel, payload_json, summary, status pending|approved|rejected|superseded|failed, decided_by, decided_at, result_note, created_at)`
  - `wa_requests(id, conversation_id, phone, customer_name, items_json, city_name, address, status open|converted|dismissed, order_id, handled_by, created_at, updated_at)`
- Existing services:
  - `src/lib/services/order-edits.ts`:
    - `getOrderEditState(orderId)` returns `{ revision: string(64 hex), editable: boolean, snapshot }`. It's `editable` only when the order isn't archived, its status is `new`/`no_answer`/`call_back_later`, and it has no fulfillment history.
    - `editOrder(orderId, body, actor: { id, name? })` validates `body` with `orderEditSchema` from `src/lib/order-edit-schema.ts`:

```ts
{ revision: string(64), lines: Array<{ variantId: string; qty: 1..10; upsellIndex?: number }>, discountMode?: "pack"|"manual",
  discountType: "none"|"fixed"|"percent", discountValue: int, shippingMode: "auto"|"free"|"paid", applyCityFee?: boolean, reason: string(3..1000) }
```

    It throws `OrderEditError(status, message)`. Read `readState()` in that file to see the snapshot's field names: items with `variant_id`, `quantity`, `unit_price`, plus `upsellItems`, `discountMode`, discount type and value, and `shipping_mode`.
  - `src/lib/services/confirmation.ts`: `cancelOrder(orderId, { reason }, actor: { id, name? })` throws `ConfirmationError(status, message)`.
  - `src/lib/services/orders.ts`: `listCities(): CityOption[]` (check the shape: id and name) and `getCrmOrder(id)`.
  - `src/lib/services/catalog.ts`: `getVariantById(id)`.

## Files to Create

- `src/lib/services/whatsapp-staging.ts`

## Files to Modify

- None.

## Technical Details

```ts
// Drafts
export function getDraft(orderId: string): OrderDraft | null;
export function upsertDraft(orderId: string, conversationId: string | null, patch: { address?: string; cityName?: string; note?: string }): OrderDraft;
// Rejects (throws StagingError 409 "Commande déjà confirmée ou annulée") unless order status in new|no_answer|call_back_later and not archived.
// address: trim, 5..500 chars. cityName: trim ≤80; resolve city_id by matching normalized names against listCities()
// (normalize: lowercase, strip accents/diacritics, collapse spaces/hyphens; also strip leading "ville de"). Exact normalized match -> city_id; else city_id NULL, keep city_name.
export function markReadyToConfirm(orderId: string): { ok: true } | { ok: false; missing: Array<"address" | "city"> }; // requires address AND city_id
export function clearDraft(orderId: string): void;

// Proposals
export function createProposal(input: { orderId: string; conversationId: string | null; kind: "edit" | "cancel"; lines?: Array<{ variantId: string; qty: number }>; reason?: string; summary: string }): WaProposal;
// edit: requires getOrderEditState(orderId).editable; validate each variantId exists & active via getVariantById; qty 1..10; ≤10 lines.
// Any previous pending proposal of same kind for the order -> status 'superseded'.
// cancel: order not already cancelled; reason required (customer's words summarized, ≤300).
export function listProposals(orderId: string, status?: string): WaProposal[];
export function listPendingProposals(): WaProposal[];
export function approveProposal(id: string, actor: { id: string; name?: string | null }): WaProposal;
export function rejectProposal(id: string, actor: { id: string; name?: string | null }, note?: string): WaProposal;
```

**`approveProposal` for `edit`:**
1. Read `getOrderEditState(orderId)`.
2. Build the body:
   - `revision` from the state
   - `lines` from the proposal (no `upsellIndex`)
   - `discountMode: "pack"` if the snapshot has a pack snapshot, else keep the snapshot's discount mode
   - `discountType`/`discountValue` from the snapshot (manual) or `"none"`/0 in pack mode
   - `shippingMode` from the snapshot
   - `reason: "Proposition WhatsApp approuvée"`
3. Call `editOrder(orderId, body, actor)`.
4. On success, set status `approved`. On `OrderEditError`, set status `failed` with `result_note = error.message` and rethrow as `StagingError(409, message)`.

Pricing always comes from `editOrder`. The proposal holds no prices.

**`approveProposal` for `cancel`:** call `cancelOrder(orderId, { reason: "Demande client WhatsApp : " + reason }, actor)` and handle errors the same way.

```ts
// Requests
export function createRequest(input: { conversationId: string; phone: string; customerName?: string; items: Array<{ variantId: string; qty: number; label: string }>; cityName?: string; address?: string }): WaRequest;
// items 1..10, each variant must exist & be active; label is the AI's human-readable "Produit X — 42" (≤120).
// At most one 'open' request per conversation: update it instead of inserting.
export function listOpenRequests(): WaRequest[];
export function getRequest(id: string): WaRequest | null;
export function convertRequest(id: string, orderId: string, userId: string): void; // status converted, order_id
export function dismissRequest(id: string, userId: string): void;
export class StagingError extends Error { constructor(readonly status: 400 | 404 | 409, message: string) }
```

All copy is French. Run each mutation in a transaction.

## Acceptance Criteria

- [ ] Unit test `scripts/unit/whatsapp-staging.test.mjs` (temp DB, seeded product and order) covers:
  - a draft on a confirmed order is rejected
  - city name resolution with accents ("Fès" matches "Fes")
  - `markReadyToConfirm` reports missing fields
  - an edit proposal approve applies through `editOrder` and changes the lines, with the price recomputed on the server
  - a stale revision gives a failed status
  - a new proposal supersedes the old one
  - a cancel proposal approve cancels the order
  - a request upserts per conversation
- [ ] Lint and tsc pass.
