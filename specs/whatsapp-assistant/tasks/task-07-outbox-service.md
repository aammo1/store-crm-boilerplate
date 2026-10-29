# Task 07: Outbox service with pacing

## Status

pending

## Wave

2

## Description

`wa_outbox` is the **only** path for outbound WhatsApp messages. This service:
- **enqueues** rows inside the caller's DB transaction, with a unique `dedupe_key` so each event sends at most once
- decides **when** a row may go out, according to safety pacing: sending window, daily cap, random gap between sends and a global sending order
- **claims** rows with a lease
- records `sent` / `failed` / `uncertain` results
- supports manual resolution of uncertain rows
- purges old rows

It follows the Meta outbox in `src/lib/services/meta.ts`. The worker in task 24 calls `claimNextOutbox()` and the result functions. This task does no network I/O.

## Dependencies

**Depends on:** task-02-migration-whatsapp.md, task-04-whatsapp-settings.md, task-05-phone-and-copy.md
**Blocks:** task-15, task-18, task-19, task-21, task-24

**Context from dependencies:**
- Task 02 created `wa_outbox` with these columns:
  - `id`, `dedupe_key UNIQUE`, `conversation_id`, `order_id`, `phone`
  - `purpose` (`notify_confirmed`|`notify_shipped`|`notify_delivered`|`notify_out_for_delivery`|`notify_delivery_issue`|`notify_cancelled`|`relance_no_answer`|`admin_alert`|`ai_reply`|`agent_reply`|`strike_warning`|`product_card`)
  - `kind` (`text`|`image`), `body`, `media_ref`, `respect_window`, `counts_toward_cap`
  - `status` (`queued`|`sending`|`sent`|`uncertain`|`failed`|`cancelled`)
  - `attempts`, `available_at`, `lease`, `wa_message_id`, `last_error`, `author_user_id`, `resolved_by`, `resolved_at`, `created_at`, `sent_at`, `updated_at`

  It also created `wa_conversations` (`phone UNIQUE`, `no_whatsapp`, `last_outbound_at`, …) and `blocked_phones(phone, source)`.
- Task 04 created `getWhatsAppSettings()` in `src/lib/services/whatsapp-settings.ts` with `enabled`, `notificationsEnabled`, `sendWindowStart`/`End` ("HH:MM"), `dailyOutboundCap`, `minGapSeconds`, `maxGapSeconds`, `adminQuietHours` and `adminPhones`.
- Task 05 created `src/lib/whatsapp/phone.ts` (`phoneToJid`).

## Files to Create

- `src/lib/services/whatsapp-outbox.ts`
- `src/lib/whatsapp/pacing.ts`: pure pacing math, unit-testable.

## Files to Modify

- None.

## Technical Details

### Purpose classes

Hard-code these defaults inside `enqueueOutbox`:

| Purposes | respect_window | counts_toward_cap |
|---|---|---|
| `notify_*`, `relance_no_answer`, `product_card`* | 1 | 1 |
| `ai_reply`, `agent_reply`, `strike_warning` | 0 | 0 (replies to a customer who wrote) |
| `admin_alert` | `settings.adminQuietHours ? 1 : 0` | 0 |

\* `product_card` is sent as part of an AI reply, so override it to 0/0 when enqueued by the agent.

### API

```ts
export interface EnqueueInput {
  dedupeKey: string;               // e.g. `order:${orderId}:confirmed`, `order:${orderId}:shipped`, `admin:${orderId}:confirmed:${phone}`, `msg:${inboundMsgId}:reply:${n}`
  phone: string;                   // normalized +212…
  purpose: OutboxPurpose;
  body: string;                    // 1..4096 chars
  kind?: "text" | "image";
  mediaRef?: string | null;        // for images: absolute https URL from catalog or relative upload path
  orderId?: string | null;
  conversationId?: string | null;
  availableAt?: string;            // default now
  respectWindow?: boolean; countsTowardCap?: boolean; // overrides
}
/** Must be called INSIDE the caller's db.transaction. Returns false when deduped, disabled, blocked or no_whatsapp. Never throws for those cases. */
export function enqueueOutbox(input: EnqueueInput): boolean;
```

`enqueueOutbox` skips (returns false) when:
- `settings.enabled` is false;
- the purpose is `notify_*` or `relance_no_answer` and `notificationsEnabled` is false;
- the phone is in `blocked_phones`, unless the purpose is `admin_alert`;
- the matching `wa_conversations.no_whatsapp = 1`.

Otherwise it runs `INSERT OR IGNORE` on `dedupe_key`.

```ts
export interface ClaimedOutbox { id: string; phone: string; purpose: OutboxPurpose; kind: "text"|"image"; body: string; mediaRef: string|null; conversationId: string|null; orderId: string|null; lease: string; attempts: number }
/** Atomically claims at most one due row, honoring pacing. Returns null when nothing may be sent now. */
export function claimNextOutbox(now?: Date): ClaimedOutbox | null;
export function markOutboxSent(id: string, lease: string, waMessageId: string | null): void;   // status=sent, sent_at, clears lease; also inserts a wa_messages 'out' row if conversation_id (author: ai/agent/system by purpose) and updates conversations.last_outbound_at
export function markOutboxRetry(id: string, lease: string, error: string): void;               // status back to queued, available_at = now + min(1h, 15s * 2^attempts); after 10 attempts -> failed
export function markOutboxFailed(id: string, lease: string, error: string): void;              // permanent
export function markOutboxUncertain(id: string, lease: string, error: string): void;           // NEVER auto-retried
export function resolveUncertain(id: string, userId: string, resolution: "sent" | "not_sent_requeue" | "cancel"): boolean;
export function cancelQueuedForOrder(orderId: string, purposes?: OutboxPurpose[]): number;    // used when an order is cancelled/deleted
export function recoverStaleSending(now?: Date): number;  // rows in 'sending' with lease older than 5 min -> 'uncertain' (crash mid-send)
export function purgeOutbox(now?: Date): number;          // delete sent/failed/cancelled older than 30 days
export function outboxStats(now?: Date): { queued: number; uncertain: number; failed24h: number; sentToday: number; capRemaining: number };
```

- If a `wa_messages` 'out' row's outbox ID already exists, don't insert a duplicate.
- `EnqueueInput` also accepts `authorUserId?: string | null`, which is stored in `wa_outbox.author_user_id`. Task 18 sets it for agent replies.
- `markOutboxSent` sets the `wa_messages.author` from the purpose: `ai_reply`/`product_card` → `ai`, `agent_reply` → `agent`, everything else → `system`. It copies `wa_outbox.author_user_id` into `wa_messages.author_user_id`.

### Pacing rules in `claimNextOutbox`

Run them inside an immediate transaction:
1. If `settings.enabled` is false, return null.
2. **Global gap.** Read `app_state` key `wa_next_send_at`. If now < that value, return null.
3. **Candidates.** `status='queued' AND available_at <= now`, ordered `ORDER BY counts_toward_cap ASC, available_at ASC`, so replies jump the queue.
4. For a candidate with `respect_window = 1`:
   - If the current Africa/Casablanca time is outside `[sendWindowStart, sendWindowEnd)`, skip it and set its `available_at` to the next window opening. Don't count this as an attempt.
   - If it also has `counts_toward_cap = 1` and today's count of sent rows with `counts_toward_cap=1` (Casablanca day) is at or above `dailyOutboundCap`, defer it to tomorrow's window opening.
5. Claim it: `UPDATE … SET status='sending', lease=?, attempts=attempts+1, updated_at=? WHERE id=? AND status='queued'`.
6. Set `wa_next_send_at`:
   - Rows that count toward the cap: now + random integer seconds in `[minGapSeconds, maxGapSeconds]`.
   - Replies (`counts_toward_cap=0`): now + a random 2–5 s.

Put the time math in `pacing.ts`, pure and taking injected `now` and random values:

```ts
export function casablancaParts(now: Date): { date: string; minutes: number }; // via Intl.DateTimeFormat("en-CA",{timeZone:"Africa/Casablanca",...})
export function inWindow(now: Date, start: string, end: string): boolean;       // supports start<end only; if start>=end treat as always-open
export function nextWindowOpen(now: Date, start: string): Date;                 // next instant when Casablanca local time == start (today if still ahead, else tomorrow)
export function randomGapMs(minS: number, maxS: number, rnd?: () => number): number;
```

Use `crypto.randomUUID()` for ids and leases, and nanoid where the repo already does.

## Acceptance Criteria

- [ ] Unit test `scripts/unit/whatsapp-outbox.test.mjs` (temp DB with migrations) covers:
  - a duplicate dedupe key inserts one row
  - disabled settings skip enqueue
  - blocked or no-WhatsApp phones are skipped
  - a window-closed notification is deferred to the next 09:00 Casablanca while an `ai_reply` is still claimable
  - the cap defers to tomorrow
  - the gap blocks a second claim
  - uncertain is never re-claimed
  - `recoverStaleSending` turns stuck rows into uncertain
  - `resolveUncertain` requeues or cancels
- [ ] Pacing math tests at 08:59, 09:00, 20:59 and 21:00 Casablanca.
- [ ] Lint and tsc pass.
