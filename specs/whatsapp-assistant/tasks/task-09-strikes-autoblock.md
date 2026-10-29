# Task 09: Strikes and auto-block

## Status

complete

## Wave

2

## Description

This is the "not serious customer" safety system. Strike points accumulate per phone and expire after 90 days, and each new strike returns an escalation decision:
- warn (level 1)
- final warning (level 2)
- auto-block

When the `autoBlockEnabled` setting is ON, the block is written to `blocked_phones` with `source='system'` and no `created_by` user. When it's OFF, warnings still happen, but instead of blocking, the conversation is flagged for a human. This task changes nothing at checkout: blocked phones keep being flagged to agents, as today. Sending the warning messages is task 21's job. This service only decides.

## Dependencies

**Depends on:** task-02-migration-whatsapp.md, task-04-whatsapp-settings.md
**Blocks:** task-15, task-18, task-21

**Context from dependencies:**
- Task 02 created:
  - `wa_strikes(id, phone, points 0..10, reason_code, detail, message_id, order_id, created_at, expires_at)`. `reason_code` is one of `insult`, `severe`, `spam_burst`, `refused_delivery`, `repeated_cancel`, `manipulation`, `ref_guessing`. There's a unique index on `(order_id, reason_code)` where `order_id` is not null, so one strike per order per reason.
  - `blocked_phones.source TEXT DEFAULT 'agent' CHECK IN ('agent','system')`.
- Task 04 created `getWhatsAppSettings()` with `autoBlockEnabled`.
- Existing `src/lib/services/customers.ts`:
  - `blockPhone(raw, reason, userId)`: `INSERT OR IGNORE` with `created_by=userId`.
  - `unblockPhone(raw)`, `getBlockedPhone`, `isPhoneBlocked`, `listBlockedPhones`, `BlocklistError`.
  - Phones are normalized via `normalizeMaPhone`.
  - The `BlockedPhone` type has `phone`, `reason`, `createdBy`, `createdAt`.
- `security_audit` table (migration 014) exists. Check its columns in `migrations/014_*.sql` before inserting audit rows. If that's unclear, skip auditing.

## Files to Create

- `src/lib/services/whatsapp-strikes.ts`

## Files to Modify

- `src/lib/services/customers.ts`:
  - add `blockPhoneSystem(phone, reason): boolean`, which inserts with `source='system'` and `created_by=NULL`
  - add a `source: "agent" | "system"` field to the `BlockedPhone` type and to the selects
  - `listBlockedPhones` returns the source
  - existing behaviour is otherwise unchanged
- `src/components/crm/blocklist-manager.tsx`: show an `Auto · système` badge when `source === "system"`. The display-only change is fine here.

## Technical Details

```ts
export const STRIKE_POINTS = { insult: 2, severe: 3, spam_burst: 1, refused_delivery: 2, repeated_cancel: 1, manipulation: 1, ref_guessing: 1 } as const;
export const STRIKE_TTL_DAYS = 90;
export const BLOCK_THRESHOLD = 3;

export type StrikeReason = keyof typeof STRIKE_POINTS;
export type StrikeDecision =
  | { action: "none"; points: number }              // duplicate (same order+reason) or zero
  | { action: "warn"; level: 1 | 2; points: number }
  | { action: "blocked"; points: number }            // newly blocked by system now
  | { action: "already_blocked"; points: number }
  | { action: "needs_human"; points: number };       // threshold reached but autoBlockEnabled=false

export function addStrike(input: { phone: string; reason: StrikeReason; detail?: string; messageId?: string; orderId?: string; now?: Date }): StrikeDecision;
export function activePoints(phone: string, now?: Date): number;
export function listStrikes(phone: string, now?: Date): Array<{ id; reason; points; detail; createdAt; expiresAt }>;
export function clearStrikes(phone: string): number; // admin action used by unblock
```

### Decision logic

Run it in one immediate transaction:
1. If the phone is already in `blocked_phones`, still insert the strike (for history), then return `already_blocked`.
2. Insert the strike (`INSERT OR IGNORE`). If it was ignored as a duplicate, return `none`.
3. Compute `total` = sum of non-expired points, including the new one.
4. `reason === "severe"`, or `total >= BLOCK_THRESHOLD`:
   - `autoBlockEnabled` is true: call `blockPhoneSystem(phone, "Auto : <reason label FR> (<total> pts)")` and return `blocked`.
   - Otherwise return `needs_human`.
5. Otherwise:
   - `total >= 2`: `warn` level 2.
   - `total == 1`: `warn` level 1.

French reason labels: `insult` = "insultes", `severe` = "menaces / contenu grave", `spam_burst` = "spam", `refused_delivery` = "colis refusé", `repeated_cancel` = "annulations répétées", `manipulation` = "manipulation de l'assistant", `ref_guessing` = "tentatives de référence".

- `detail` is at most 300 characters. Never store the full message body. Store a short excerpt or a classifier label.
- Unblocking stays in the existing `api/crm/blocklist/[phone]` DELETE route. Task 18 adds strike clearing to the inbox's unblock action.

## Acceptance Criteria

- [ ] Unit test `scripts/unit/whatsapp-strikes.test.mjs` covers:
  - 1 point gives warn 1, then 2 points total give warn 2, then 3 give blocked (with the setting ON) or needs_human (OFF)
  - severe blocks immediately
  - a duplicate order+reason gives none
  - points expire after 90 days
  - a system block has `source='system'` and NULL `created_by`
- [ ] The existing blocklist tests and `npm run test:crm` still pass.
- [ ] Lint and tsc pass.
