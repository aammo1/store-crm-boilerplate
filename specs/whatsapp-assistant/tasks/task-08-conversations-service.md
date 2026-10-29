# Task 08: Conversations, messages and identity

## Status

pending

## Wave

2

## Description

This is the DB service for WhatsApp conversations, which are keyed by normalized phone. It covers:
- conversation and message storage
- linking conversations to orders, with the **identity and privacy rules** that decide how much of each order the AI may reveal
- human takeover and release
- language detection storage
- agent visibility scoping
- logging into `order_contacts`

It's used by the inbound processor (task 21), the AI tools (task 17) and the inbox API (task 18).

## Dependencies

**Depends on:** task-02-migration-whatsapp.md, task-05-phone-and-copy.md
**Blocks:** task-17, task-18, task-21

**Context from dependencies:**
- Task 02 created these tables:
  - `wa_conversations`: `id`, `phone UNIQUE`, `jid`, `display_name`, `language` (`fr`|`ar`|`darija_latin`|`darija_arabic`|null), `mode` (`ai`|`human`), `needs_human`, `handoff_reason`, `taken_over_by`, `taken_over_at`, `ai_paused_until`, `identity_failures`, `identity_locked_until`, `no_whatsapp`, `last_inbound_at`, `last_outbound_at`, `last_agent_reply_at`, `last_preview`, `unread_count`, timestamps.
  - `wa_conversation_orders`: `conversation_id`, `order_id`, `access` (`full`|`status_only`), `linked_via` (`phone`|`ref_message`|`ref_last4`|`agent`).
  - `wa_messages`: `id`, `conversation_id`, `direction`, `author`, `author_user_id`, `wa_message_id UNIQUE`, `kind`, `body`, `transcript`, `media_*`, `outbox_id`, `created_at`.
- Task 05 created `src/lib/whatsapp/phone.ts`: `extractOrderRefs(text)`, `extractLast4(text)`, `orderRefFromOrderId(id)`, `maskPhone`.
- Existing: `orders(id, customer_phone, customer_name, confirmation_status, assigned_to, archived_at, …)`.
- `insertContact(input)` in `src/lib/services/orders.ts` validates outcomes (`no_answer` only from certain statuses). **Don't use it** for WhatsApp logging; insert directly into `order_contacts(id, order_id, agent_id, channel, outcome, note, next_callback_at, created_at)` with `channel='whatsapp'`, `outcome='note'`. `agent_id` may be NULL for AI or system entries.

## Files to Create

- `src/lib/services/whatsapp-conversations.ts`

## Files to Modify

- None.

## Technical Details

```ts
export interface WaConversation { id; phone; jid; displayName; language; mode: "ai"|"human"; needsHuman: boolean; handoffReason: string|null; takenOverBy: string|null; aiPausedUntil: string|null; identityLockedUntil: string|null; noWhatsapp: boolean; lastInboundAt; lastOutboundAt; lastPreview; unreadCount; blocked: boolean; strikePoints?: number; orders: Array<{ orderId: string; ref: string; access: "full"|"status_only"; status: string }>; updatedAt }

export function getOrCreateConversation(phone: string, jid: string | null, displayName: string | null): WaConversation; // also auto-links phone-owned orders (see below)
export function getConversation(id: string): WaConversation | null;
export function getConversationByPhone(phone: string): WaConversation | null;
export function insertInboundMessage(input: { conversationId; waMessageId; kind; body?; mediaPath?; mediaMime?; mediaSha256?; mediaBytes?; createdAt }): { id: string; duplicate: boolean }; // INSERT OR IGNORE on wa_message_id; bumps unread_count, last_inbound_at, last_preview (first 80 chars or "🎤 Audio"/"📷 Image")
export function setMessageTranscript(messageId: string, transcript: string): void;
export function listMessages(conversationId: string, opts?: { before?: string; limit?: number }): WaMessageView[]; // newest-last, limit default 50, max 200
export function recentContext(conversationId: string, maxMessages = 20): Array<{ role: "user"|"assistant"; text: string; at: string }>; // text = body ?? transcript ?? "[image]"; agent+ai+system -> assistant
export function setLanguage(conversationId: string, language: WaLanguage): void;
export function takeOver(conversationId: string, userId: string): void;   // mode=human, taken_over_by, taken_over_at, needs_human=0
export function releaseToAi(conversationId: string): void;               // mode=ai, clear taken_over_*
export function flagHandoff(conversationId: string, reason: string): void; // needs_human=1, handoff_reason; keeps mode (AI stops replying on handoff: set mode='human' too, taken_over_by NULL)
export function autoReleaseStale(hours: number, now?: Date): number;      // mode=human AND last_agent_reply_at (or taken_over_at) older than hours AND not needs_human -> releaseToAi
export function pauseAi(conversationId: string, untilIso: string): void;
export function markRead(conversationId: string): void;
export function markNoWhatsapp(phone: string): void;                      // upsert conversation row with no_whatsapp=1
export function noteAgentReply(conversationId: string, at: string): void;
export function logOrderContact(orderId: string, agentId: string | null, note: string): void; // channel whatsapp, outcome note, note max 500 chars

// Identity
export type LinkResult = { linked: Array<{ orderId: string; access: "full"|"status_only" }>; failed: boolean; locked: boolean };
export function linkOrdersFromMessage(conversationId: string, text: string, now?: Date): LinkResult;
export function orderAccess(conversationId: string, orderId: string): "full" | "status_only" | null;
export function linkOrderByAgent(conversationId: string, orderId: string): void; // access full, linked_via agent

// Inbox
export interface ListFilter { view: "todo" | "mine" | "all"; userId: string; role: "admin"|"agent"; q?: string; cursor?: string; limit?: number }
export function listConversations(filter: ListFilter): { items: WaConversation[]; nextCursor: string | null };
export function canAccessConversation(conversationId: string, userId: string, role: "admin"|"agent"): boolean;
```

### Identity rules

`getOrCreateConversation` **auto-links** every non-archived order whose `customer_phone = phone`, with `access='full'` and `linked_via='phone'`. Re-run the auto-link on each call, using `INSERT OR IGNORE`, so new orders get picked up.

`linkOrdersFromMessage(text)`:
1. If `identity_locked_until > now`, return `{locked:true}` without querying.
2. Pull refs out with `extractOrderRefs(text)`. With no refs, return `{linked:[], failed:false}`.
3. For each ref, find the order with `upper(id) LIKE ref || '%'` (ref is 8 characters) that isn't archived:
   - Order phone = conversation phone: link with `full` (`linked_via='ref_message'`).
   - Different phone, and `extractLast4(text)` equals the last 4 digits of the order phone: link with `status_only` (`ref_last4`).
   - Otherwise it's a failure. Never reveal whether the ref exists.
4. Track failures: `identity_failures += 1` for each message that has refs and no successful link. At ≥3, set `identity_locked_until = now + 24h`, reset the counter and return `{failed:true, locked:true}`. Task 21 adds the `ref_guessing` strike when it sees `locked:true` freshly set. Return the field `newlyLocked: boolean` too.

### Agent visibility

- Admins see everything.
- Agents see conversations where **any linked order** has `assigned_to = userId`, **or** no linked order is assigned to anyone, which includes conversations with no orders.
- `view="todo"`: `needs_human=1`.
- `view="mine"`: `taken_over_by = userId`, or a linked order is assigned to the user.
- `q` matches the last 4+ digits of the phone or `display_name` with LIKE.
- Order by `updated_at DESC`, cursor-paginate on `updated_at|id`, default 30, max 100.
- `blocked` comes from a LEFT JOIN on `blocked_phones`.
- `strikePoints` is the sum of non-expired `wa_strikes.points`, via a subquery.

Logging rule: `logOrderContact` is called by task 21 once per inbound **conversation day** per linked full-access order, with note `WhatsApp : message client` (deduped by checking for an existing whatsapp note for that order on the same Casablanca date). The outbox (task 07) doesn't log here.

## Acceptance Criteria

- [ ] Unit test `scripts/unit/whatsapp-conversations.test.mjs` (temp DB) covers:
  - auto-link by phone
  - ref + same phone gives full access
  - ref + last 4 digits from another phone gives status only
  - ref alone from another phone fails with no info
  - 3 failures lock for 24 h
  - a duplicate wa_message_id is ignored
  - agent visibility (assigned to them / unassigned / assigned to another agent)
  - takeover and release, and `autoReleaseStale`
- [ ] Lint and tsc pass.
