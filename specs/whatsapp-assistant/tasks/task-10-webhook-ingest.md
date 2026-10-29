# Task 10: Webhook ingest route

## Status

pending

## Wave

2

## Description

This is the single inbound HTTP entry point for Evolution events. It follows the **store-then-process** rule. The route:
- authenticates with a secret path segment plus a header, both compared in constant time
- caps the body size
- keeps only `messages.upsert` (customer messages, not `fromMe`, not groups) and `connection.update`
- stores the raw payload in `wa_inbound_events`, deduplicated by WhatsApp message ID
- returns `200` immediately

No AI, media download or business logic runs in the request. The `whatsapp` worker (task 24) processes stored events through task 21. This route is the sole exception to the "no webhook automation" rule in AGENTS.md.

## Dependencies

**Depends on:** task-02-migration-whatsapp.md, task-03-whatsapp-config.md
**Blocks:** task-21-inbound-processor

**Context from dependencies:**
- Task 02 created `wa_inbound_events(id, event_type, wa_message_id UNIQUE, payload_json, status DEFAULT 'pending', attempts, available_at, lease, last_error, received_at, processed_at)`.
- Task 03 created `src/lib/whatsapp/config.ts` with `webhookSecret(): string | null` (≥32 characters) and `whatsappConfigured()`.
- Existing helpers:
  - `src/lib/request-body.ts` `readLimitedBytes(request, maxBytes)` / `readLimitedJson`. Check their exact signatures and error types in the file.
  - `src/lib/services/security-budgets.ts`: `consumeBudgets`, `budgetKey`, `trustedClientIp`.
  - `src/lib/catalog-agent-auth.ts`: an example of a constant-time compare using `timingSafeEqual` on sha256 digests.
  - `src/middleware.ts` only applies browser-origin checks to `/api/admin*` and `/api/crm*`, so `/api/whatsapp/*` isn't blocked. Confirm the middleware matcher doesn't catch it; if it does, exclude it.

## Files to Create

- `src/app/api/whatsapp/webhook/[secret]/route.ts`
- `src/lib/services/whatsapp-inbound-events.ts`: `storeInboundEvent`, `claimNextInboundEvent`, `markInboundDone`, `markInboundIgnored`, `markInboundRetry`, `markInboundFailed`, `recoverStaleInbound`, `purgeInboundEvents`.

## Files to Modify

- None. Only touch `src/middleware.ts` if the matcher would intercept `/api/whatsapp`.

## Technical Details

### Route

- `export const runtime = "nodejs"; export const dynamic = "force-dynamic";`
- **Method:** only `POST`. Any other method gets 405.
- **Unconfigured:** if `whatsappConfigured()` is false, return **404** with an empty body.
- **Path secret:** compare `params.secret` to `webhookSecret()` with `timingSafeEqual` of their sha256 digests. On a mismatch, return **404**, to avoid confirming the endpoint exists.
- **Header:** `x-webhook-secret` must also match, compared the same way. On a mismatch, return **401**.
- **Rate budget:** `consumeBudgets` with key `budgetKey("wa_webhook", "global")` and 600 requests per minute. When exceeded, return 429 with `Retry-After`. Evolution retries.
- **Body:** at most **512 KB**. Base64 media is OFF in Evolution, so payloads are small. Over the limit gives 413. Invalid JSON gives 400.
- **Normalize the event name:** `payload.event` may be `"messages.upsert"` or `"MESSAGES_UPSERT"`. Lowercase it and turn `_` into `.`.

Filtering by event:

| Event | Condition | Action |
|---|---|---|
| `messages.upsert` | `data` may be an object or an array; handle each message | |
| | `data.key.fromMe === true` | Ignore. These are our own sends, already recorded by the outbox. |
| | `data.key.remoteJid` ends with `@g.us`, `@broadcast`, `@newsletter`, or is `status@broadcast` | Ignore |
| | `data.key.id` missing | Ignore |
| | Otherwise | `storeInboundEvent({ eventType: "messages.upsert", waMessageId: data.key.id, payload: <that single message object plus top-level instance> })` |
| `connection.update` | | Store with `waMessageId: null` |
| Anything else | | Return 200 and store nothing |

- **Response:** `200 { ok: true }` once storing is done, including duplicates. The route must not do anything slow.
- **Logs:** `log.info("wa.webhook", { event, stored, duplicate })` only. No phone numbers, bodies or secrets.

### Service

```ts
export function storeInboundEvent(input: { eventType: string; waMessageId: string | null; payload: unknown; now?: Date }): { stored: boolean; duplicate: boolean };
// INSERT OR IGNORE; payload_json = JSON.stringify(payload) truncated? -> reject (return stored:false) if > 256 KB after stringify.
export interface ClaimedInbound { id: string; eventType: string; payload: unknown; attempts: number; lease: string }
export function claimNextInboundEvent(now?: Date): ClaimedInbound | null; // status pending AND available_at<=now, oldest first; set processing+lease+attempts+1 atomically (UPDATE … WHERE id=(SELECT …) RETURNING)
export function markInboundDone(id: string, lease: string): void;
export function markInboundIgnored(id: string, lease: string, reason: string): void;
export function markInboundRetry(id: string, lease: string, error: string): void; // back to pending, available_at = now + min(10min, 5s*2^attempts); after 8 attempts -> failed
export function markInboundFailed(id: string, lease: string, error: string): void;
export function recoverStaleInbound(now?: Date): number; // processing with lease older than 5 min -> pending
export function purgeInboundEvents(now?: Date): number;  // delete done/ignored older than 14 days, failed older than 30 days
```

`last_error` text goes through `redactText` and is cut to 300 characters.

## Acceptance Criteria

- [ ] With WhatsApp unconfigured, any request gets 404.
- [ ] A wrong path secret gets 404. The right path with a wrong or missing header gets 401.
- [ ] A valid `messages.upsert` from a customer is stored once. Posting the same `key.id` again returns 200 and leaves one row.
- [ ] `fromMe`, group and status messages aren't stored. `connection.update` is stored.
- [ ] An oversize body gets 413.
- [ ] Unit or integration test `scripts/unit/whatsapp-webhook.test.mjs` exercises the service and the route handler (import the handler and call it with a `Request`).
- [ ] Lint and tsc pass.
