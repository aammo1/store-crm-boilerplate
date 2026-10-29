# Task 18: Inbox API routes

## Status

pending

## Wave

3

## Description

These are the authenticated CRM API routes behind the WhatsApp inbox (task 22) and the order-page panel (task 25). They cover:
- listing and reading conversations
- replying as an agent, which goes through the paced outbox
- taking over from the AI and releasing back to it
- marking a conversation read
- blocking and unblocking
- linking an order
- serving stored media securely
- resolving uncertain sends
- approving or rejecting AI proposals
- handling WhatsApp purchase requests
- a small summary for nav badges

They all live under `/api/crm/whatsapp/*`, so the middleware applies the browser-origin check to mutations.

## Dependencies

**Depends on:** task-07-outbox-service.md, task-08-conversations-service.md, task-09-strikes-autoblock.md, task-12-drafts-proposals-requests.md
**Blocks:** task-22-inbox-ui, task-25-order-panel-proposals-ui

**Context from dependencies:**
- Task 08 provides `listConversations({ view: "todo"|"mine"|"all", userId, role, q?, cursor?, limit? })`, `getConversation`, `canAccessConversation(id, userId, role)`, `listMessages(id, { before?, limit? })`, `takeOver`, `releaseToAi`, `markRead`, `noteAgentReply`, `linkOrderByAgent` and `logOrderContact(orderId, agentId, note)`.
- Task 07 provides `enqueueOutbox({ dedupeKey, phone, purpose: "agent_reply", body, conversationId, authorUserId })`, `resolveUncertain(id, userId, "sent"|"not_sent_requeue"|"cancel")` and `outboxStats()`. Agent replies bypass the window and the cap, but still respect the global gap.
- Task 09 provides `listStrikes(phone)`, `activePoints(phone)` and `clearStrikes(phone)`. `src/lib/services/customers.ts` has `blockPhone(raw, reason, userId)` and `unblockPhone(raw)`.
- Task 12 provides `listProposals(orderId)`, `listPendingProposals()`, `approveProposal(id, actor)`, `rejectProposal(id, actor, note?)`, `getDraft(orderId)`, `listOpenRequests()`, `getRequest`, `convertRequest(id, orderId, userId)`, `dismissRequest(id, userId)` and `StagingError(status, message)`.
- Task 16 provides `absoluteMediaPath(relPath)` in `src/lib/whatsapp/media.ts`. It's in the same wave; if it isn't merged yet, resolve the path inline with the same uploads root from `src/lib/uploads.ts` and a traversal check.
- Existing helpers:
  - `src/lib/auth-guards.ts`: `requireUser()` / `requireAdmin()`, which throw `AuthGuardError` with `.toResponse()`.
  - `src/lib/request-body.ts`: `readLimitedJson`.
  - Validation uses zod from `src/lib/validation`.
  - Errors are French JSON `{ error }`.
  - The user object has `id`, `role` and `name`.

## Files to Create

- `src/app/api/crm/whatsapp/conversations/route.ts`: GET list.
- `src/app/api/crm/whatsapp/conversations/[id]/route.ts`: GET detail.
- `src/app/api/crm/whatsapp/conversations/[id]/reply/route.ts`: POST.
- `src/app/api/crm/whatsapp/conversations/[id]/takeover/route.ts`: POST (take) / DELETE (release).
- `src/app/api/crm/whatsapp/conversations/[id]/read/route.ts`: POST.
- `src/app/api/crm/whatsapp/conversations/[id]/block/route.ts`: POST (block) / DELETE (unblock and clear strikes), admin only.
- `src/app/api/crm/whatsapp/conversations/[id]/link-order/route.ts`: POST.
- `src/app/api/crm/whatsapp/media/[messageId]/route.ts`: GET.
- `src/app/api/crm/whatsapp/outbox/route.ts`: GET uncertain and failed rows, admin.
- `src/app/api/crm/whatsapp/outbox/[id]/resolve/route.ts`: POST, admin.
- `src/app/api/crm/whatsapp/proposals/[id]/route.ts`: POST `{ action: "approve"|"reject", note? }`.
- `src/app/api/crm/whatsapp/requests/route.ts`: GET open requests.
- `src/app/api/crm/whatsapp/requests/[id]/route.ts`: POST `{ action: "convert", orderId } | { action: "dismiss" }`.
- `src/app/api/crm/whatsapp/summary/route.ts`: GET `{ todo, uncertain, pendingProposals, openRequests, connection }`.
- `src/app/api/crm/orders/[id]/whatsapp/route.ts`: GET panel data for an order: `{ conversation | null, messages(last 20), draft, proposals, outbox rows for order (purpose, status, sent_at) }`.

## Files to Modify

- None.

## Technical Details

### Access rules

- Every route calls `requireUser()` (or `requireAdmin()` where stated). Conversation routes check `canAccessConversation(id, user.id, user.role)` and return 404 when access is denied, so existence isn't revealed.
- Media: load the message, then its conversation, then check access. Stream the file with these headers:
  - `Content-Type: media_mime`
  - `X-Content-Type-Options: nosniff`
  - `Content-Disposition: inline`
  - `Cache-Control: private, max-age=300`

  If `media_deleted_at` is set, return 410 `Média expiré (rétention)`.
- Order panel: an agent may see it only if the order is assigned to them or unassigned, or if they're an admin. Mirror the existing order-page access logic in `src/app/(admin)/crm/orders/[id]/page.tsx`.

### Reply

- Body `{ text }`, 1–2000 characters, trimmed. Capped at 8 KB.
- The conversation must not be blocked (403 `Numéro bloqué`) or flagged `no_whatsapp` (409).
- In one transaction:
  1. `takeOver(id, user.id)`
  2. `enqueueOutbox({ dedupeKey: \`agent:${user.id}:${crypto.randomUUID()}\`, phone, purpose: "agent_reply", body: text, conversationId: id, authorUserId: user.id })`
  3. `noteAgentReply(id, now)`
  4. for each linked full-access order, `logOrderContact(orderId, user.id, "WhatsApp : réponse agent")` (dedupe per day is acceptable)
- If WhatsApp is disabled, `enqueueOutbox` returns false: respond 409 `WhatsApp désactivé`.
- Success returns `202 { queued: true }`.

### Block

- `POST { reason }` (3–200 characters) calls `blockPhone(phone, reason, user.id)`.
- `DELETE` calls `unblockPhone(phone)` and `clearStrikes(phone)`.
- Admin only.

### Link order

- `POST { orderRef }` (8 characters) or `{ orderId }`. Find the order and call `linkOrderByAgent`. Any agent may link, because an agent verifies identity by phone call.

### Proposals

- Approve or reject with `actor = { id: user.id, name: user.name }`.
- Map `StagingError` to its status code.
- Approving an edit may fail with 409 when the order changed; return the message as is.

### Requests

- `convert` requires an existing order ID created by the agent through the manual order form. Task 25 pre-fills that form.

### Pagination and limits

- List: `limit` max 100.
- Messages: `before` cursor, limit max 200.
- Validate every query parameter with zod.

## Acceptance Criteria

- [ ] An agent can't read a conversation linked only to another agent's orders (404). An admin can.
- [ ] Reply enqueues an `agent_reply` row with `author_user_id`, takes over the conversation, and returns 409 when WhatsApp is disabled.
- [ ] Media returns 404 without access and 410 when expired. The content type is set correctly.
- [ ] Approve and reject work and map errors. Resolving an uncertain row works for admins only.
- [ ] Integration test `scripts/unit/whatsapp-inbox-api.test.mjs` imports the handlers with mocked auth. Check how existing CRM route tests mock auth, e.g. in `scripts/security-workflow.test.mjs`.
- [ ] Lint and tsc pass.
