# Task 22: CRM inbox UI

## Status

complete

## Wave

4

## Description

This task builds the `/crm/whatsapp` page, where agents and admins read and answer customer WhatsApp conversations:
- a conversation list with badges and filters
- a chat view with text bubbles, an audio player plus transcript, and images
- the "Prendre la main" / "Rendre à l'IA" controls
- a reply box
- block and unblock (admin)
- linking an order
- uncertain sends to resolve (admin)

It also adds a nav entry with a badge for conversations waiting for a human, and a disconnected banner. The UI is French and mobile-first, following existing CRM components.

## Dependencies

**Depends on:** task-18-inbox-api.md
**Blocks:** None

**Context from dependencies:** Task 18 created these routes. All are JSON, session-authenticated, with French `{ error }` on failure.

| Route | Purpose |
|---|---|
| `GET /api/crm/whatsapp/conversations?view=todo\|mine\|all&q=&cursor=&limit=` | `{ items: WaConversation[], nextCursor }`. `WaConversation` has `id`, `phone`, `displayName`, `language`, `mode: "ai"\|"human"`, `needsHuman`, `handoffReason`, `takenOverBy`, `aiPausedUntil`, `noWhatsapp`, `lastInboundAt`, `lastPreview`, `unreadCount`, `blocked`, `strikePoints`, `orders: [{ orderId, ref, access, status }]`, `updatedAt` |
| `GET /api/crm/whatsapp/conversations/[id]` | `{ conversation, messages: WaMessageView[], strikes: [...] }`. `WaMessageView` has `id`, `direction`, `author: customer\|ai\|agent\|system`, `authorName?`, `kind: text\|audio\|image\|other`, `body`, `transcript`, `mediaUrl` (`/api/crm/whatsapp/media/<id>`, or null if none or deleted), `mediaExpired`, `createdAt`, `status?` (outbox status for outbound) |
| `POST …/[id]/reply { text }` | 202. 409 `WhatsApp désactivé`, 403 `Numéro bloqué` |
| `POST …/[id]/takeover`, `DELETE …/[id]/takeover` | Take over / release |
| `POST …/[id]/read` | Mark read |
| `POST …/[id]/block { reason }`, `DELETE …/[id]/block` | Admin |
| `POST …/[id]/link-order { orderRef }` | Link an order |
| `GET /api/crm/whatsapp/outbox`, `POST /api/crm/whatsapp/outbox/[id]/resolve { resolution: "sent"\|"not_sent_requeue"\|"cancel" }` | Admin |
| `GET /api/crm/whatsapp/summary` | `{ todo, uncertain, pendingProposals, openRequests, connection: { state, updatedAt } }` |

If the exact field names differ in task 18's implementation, follow the implementation.

Existing UI:
- `src/components/crm/crm-nav.tsx`: `links` array `{ href, label, adminOnly? }`. Add after "Commandes".
- `src/components/crm/crm-mobile-nav.tsx`: same idea for mobile.
- CRM pages live in `src/app/(admin)/crm/*/page.tsx` and use `requireUser()` in the server component.
- UI primitives are in `src/components/ui`, toasts via `sonner`, dates via `formatCasablanca` in `src/lib/services/orders.ts` (server) or `Intl` with `Africa/Casablanca` on the client.

## Files to Create

- `src/app/(admin)/crm/whatsapp/page.tsx`: server component that calls `requireUser()` and renders the workspace with `role` and `userId`.
- `src/components/crm/whatsapp/inbox-workspace.tsx`: client component, list and chat layout.
- `src/components/crm/whatsapp/conversation-list.tsx`
- `src/components/crm/whatsapp/chat-view.tsx`
- `src/components/crm/whatsapp/uncertain-sends.tsx`: admin panel.

## Files to Modify

- `src/components/crm/crm-nav.tsx`: add `{ href: "/crm/whatsapp", label: "WhatsApp" }` with a small badge showing `summary.todo` when it's above 0. Fetch the summary on mount and every 60 s, and only on CRM pages.
- `src/components/crm/crm-mobile-nav.tsx`: the same entry.

## Technical Details

### Layout

- **Desktop:** list on the left (≈340 px), chat on the right.
- **Mobile:** the list is the full screen. Tapping a conversation opens the chat full screen with a back button. Use the `?c=<id>` URL search param for the selected conversation.

**Header:**
- Tabs: "À traiter (n)", "Mes conversations", "Toutes".
- Search box: phone digits or name, debounced 300 ms.
- **Banner** when `connection.state !== "open"`: "WhatsApp déconnecté — reconnectez le numéro (QR) dans Evolution." Only show it if it's known.
- Admin: a "Envois incertains (n)" button that opens `uncertain-sends`.

**List item:**
- Name or masked phone, last preview, relative time, unread dot.
- Badges: `🤖 IA` (mode ai) or `🙋 Humain`, `À traiter` (needsHuman), `⚠️ n pts` (strikePoints > 0), `⛔ Bloqué`, `Pas de WhatsApp`, order refs (`#A1B2C3D4`).

**Chat view:**
- Header: name, masked phone (admins see the full phone), order chips linking to `/crm/orders/<id>`, the handoff reason if any, and buttons:
  - "Prendre la main" or "Rendre à l'IA"
  - "Lier une commande" (a small dialog with a ref input)
  - admin: "Bloquer" (reason dialog) or "Débloquer"
- Bubbles: customer on the left; AI, agent and system on the right, with an author label ("IA", agent name, "Système") and a status icon for outbound (queued ⏳, sent ✓, uncertain ⚠️, failed ✕).
  - Audio: `<audio controls preload="none" src={mediaUrl}>` plus the transcript in italics underneath.
  - Image: `<img loading="lazy">` thumbnail opening full size in a new tab.
  - Expired media shows "Média supprimé (rétention)".
- Reply box: textarea (2000 characters) and a Send button, disabled when blocked or no WhatsApp. Ctrl/Cmd+Enter sends. The help text says: "Votre réponse met l'IA en pause pour cette conversation."
- Polling: refresh the open conversation every 10 s and the list every 20 s while the tab is visible (`document.visibilityState`). No websockets.
- Opening a conversation calls `POST /read`.

**Uncertain sends panel (admin):**
- A table with: purpose (French label), masked phone, created time, last error.
- Actions: "Marquer envoyé" (after checking on the phone), "Renvoyer" (requeue), "Annuler".
- Warning text: "Vérifiez d'abord sur le téléphone si le message est parti, pour éviter un doublon."

### Accessibility and style

- Keyboard-navigable list. `aria-live="polite"` for new messages.
- Use existing Tailwind tokens and dark-mode classes (the CRM has a theme toggle).

## Acceptance Criteria

- [ ] Agents and admins can open `/crm/whatsapp`. Agents see only allowed conversations; the server enforces this.
- [ ] Sending a reply shows a queued bubble that turns sent after the worker sends it (or stays queued when the worker is off).
- [ ] Takeover and release toggle the badge. Block and unblock work for admins and are hidden for agents.
- [ ] Mobile (375 px) layout works with list → chat → back.
- [ ] The nav badge shows the to-do count. The disconnected banner shows when the state is `close`.
- [ ] `npm run test:e2e-crm` still passes. Lint, tsc and `DELIVERY_PROVIDER=mock npm run build` pass.
