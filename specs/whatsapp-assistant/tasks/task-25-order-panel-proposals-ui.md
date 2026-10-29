# Task 25: Order page panel, proposals and requests UI

## Status

pending

## Wave

5

## Description

This brings WhatsApp into the agent's normal order workflow:
1. A **WhatsApp panel** on `/crm/orders/[id]` showing:
   - the linked conversation's last messages, with a link to the inbox
   - the AI **draft** (address, city, "prêt à confirmer" badge), with a button that pre-fills the existing Confirm form
   - pending **proposals** (edit or cancel), with Approve and Reject
   - WhatsApp notifications sent for this order (purpose, status, time)
2. **WhatsApp requests** (pre-sales buyers who refused the link) listed in `/crm/paniers` next to abandoned leads, with "Créer la commande", which opens the manual order form pre-filled, and "Ignorer".
3. A "prêt à confirmer" badge in the orders list.

## Dependencies

**Depends on:** task-18-inbox-api.md, task-12-drafts-proposals-requests.md
**Blocks:** None

**Context from dependencies:**
- Task 18 created:
  - `GET /api/crm/orders/[id]/whatsapp`, returning `{ conversation: { id, mode, needsHuman, blocked, strikePoints } | null, messages: WaMessageView[] (last 20), draft: { address, cityId, cityName, note, readyToConfirm, updatedAt } | null, proposals: [{ id, kind, summary, status, createdAt, resultNote }], outbox: [{ purpose, status, sentAt, createdAt }] }`
  - `POST /api/crm/whatsapp/proposals/[id] { action: "approve"|"reject", note? }`, where approve applies through `editOrder`/`cancelOrder` on the server and can return 409 with a French message
  - `GET /api/crm/whatsapp/requests`, returning `[{ id, conversationId, phone, customerName, items: [{ variantId, qty, label }], cityName, address, createdAt }]`
  - `POST /api/crm/whatsapp/requests/[id] { action: "convert", orderId } | { action: "dismiss" }`
- Task 12: the draft lives in `wa_order_drafts` (`getDraft(orderId)` in `src/lib/services/whatsapp-staging.ts`).
- Existing UI:
  - `src/app/(admin)/crm/orders/[id]/page.tsx` (order detail, server component) renders `ConfirmOrder` (`src/components/crm/confirm-order.tsx`), `CancelOrder`, `EditOrder` and the customer history. Read how `ConfirmOrder` receives its initial address and city. Pass the draft values as initial values when the order has none yet, and only if the agent clicks "Utiliser le brouillon WhatsApp" (don't auto-fill silently).
  - `src/components/crm/orders-table.tsx` renders badges per order row. `listOrders()` in `src/lib/services/orders.ts` builds the rows. To add a `waReady` flag, compute it in the page (one extra query: `SELECT order_id FROM wa_order_drafts WHERE ready_to_confirm=1 AND order_id IN (...)`) rather than editing `orders.ts` (a hot file).
  - `src/app/(admin)/crm/paniers/page.tsx` plus `src/components/crm/leads-workspace.tsx` show abandoned checkout leads.
  - Manual orders: `src/app/(admin)/crm/orders/new` with `src/components/crm/manual-order-form.tsx`. Check whether it accepts initial values through search params. If not, add optional `searchParams` pre-fill (`name`, `phone`, `city`, `address`, `items=variantId:qty,…`) and a `waRequest=<id>` param. After the manual order is created, the form calls the convert endpoint with the new order ID.

## Files to Create

- `src/components/crm/whatsapp/order-whatsapp-panel.tsx`: client panel. Fetch on mount and every 30 s.
- `src/components/crm/whatsapp/whatsapp-requests.tsx`: list for `/crm/paniers`.

## Files to Modify

- `src/app/(admin)/crm/orders/[id]/page.tsx`: mount the panel (only when the order exists). Pass the draft to `ConfirmOrder` through a "use draft" control.
- `src/components/crm/confirm-order.tsx`: accept an optional `draft` prop. Show a "Brouillon WhatsApp : {address}, {city} — Utiliser" button that fills the address and city fields. Never submit automatically.
- `src/app/(admin)/crm/paniers/page.tsx`: add a "Demandes WhatsApp" section above the leads.
- `src/components/crm/manual-order-form.tsx` and `src/app/(admin)/crm/orders/new/page.tsx`: optional pre-fill from search params plus the convert call after success.
- `src/app/(admin)/crm/orders/page.tsx` and `src/components/crm/orders-table.tsx`: a `Prêt (WhatsApp)` badge for orders whose draft has `ready_to_confirm=1`.

## Technical Details

### Panel (French)

- Title "WhatsApp".
- No conversation: show "Aucune conversation WhatsApp" with a hint that the customer can write using the order ref.
- Status chips: mode (IA or Humain), À traiter, points, Bloqué. Link: "Ouvrir dans la boîte WhatsApp" goes to `/crm/whatsapp?c=<id>`.
- Draft card: address, city (with a "ville non reconnue" warning if `cityId` is null) and the "Prêt à confirmer" badge.
- Proposals: each shows its summary. Approve shows a confirm dialog that states the effect ("La commande sera modifiée et recalculée par le serveur"). Reject takes an optional note. Show errors with toasts. After approving, refresh the page data with `router.refresh()`.
- Notifications list: French labels.

| Purpose | Label |
|---|---|
| `notify_confirmed` | Confirmation |
| `notify_shipped` | Expédition |
| `notify_delivered` | Livraison |
| `notify_out_for_delivery` | En cours de livraison |
| `notify_delivery_issue` | Problème livraison |
| `notify_cancelled` | Annulation |
| `relance_no_answer` | Relance |
| `admin_alert` | Alerte admin |

Statuses: queued = "En attente", sent = "Envoyé", uncertain = "Incertain", failed = "Échec", cancelled = "Annulé".

### Requests list

- Each request shows its items (labels × qty), city, address, masked phone and time, with the actions "Créer la commande" and "Ignorer".
- "Créer la commande" links to `/crm/orders/new?waRequest=<id>&name=…&phone=…&city=…&address=…&items=…`. Use URL-encoded values. The phone is acceptable in a CRM URL because it's session-protected, but don't log it. The prices come from the server as usual.

### Permissions

The same as the order page and the leads page. Approve, reject and convert are allowed for agents and admins.

## Acceptance Criteria

- [ ] An order with a linked conversation shows messages, the draft, proposals and notifications. Without one, it shows the empty state.
- [ ] "Utiliser le brouillon" fills the Confirm form fields, and confirmation still needs the agent's click.
- [ ] Approving an edit proposal changes the order lines through the server. A stale order shows the 409 message.
- [ ] Requests show in `/crm/paniers`. Creating the order from a request marks it converted. Ignore dismisses it.
- [ ] The `Prêt (WhatsApp)` badge appears in the orders list.
- [ ] `npm run test:crm` and `npm run test:e2e-crm` pass. Lint, tsc and the build pass.
