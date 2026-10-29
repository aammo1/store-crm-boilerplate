# Task 24: WhatsApp worker and health

## Status

complete

## Wave

5

## Description

The `whatsapp` background worker runs under the existing single-owner worker lease. It's the **only** code that sends WhatsApp messages and the only code that processes inbound events. Each tick it:
1. recovers stale leases
2. processes up to N inbound events through the inbound processor
3. sends at most one paced outbox message, with a "composing" presence and a typing delay first
4. periodically does maintenance: auto-release stale human takeovers, refresh the connection state, purge old rows and expired media

It's registered with the worker health system and `/api/health`.

## Dependencies

**Depends on:** task-06-evolution-client.md, task-21-inbound-processor.md (task-07, task-08, task-10, task-16 indirectly)
**Blocks:** None

**Context from dependencies:**
- Task 06 (`src/lib/whatsapp/evolution.ts`):
  - `getWhatsAppSender()` returns a sender or null, with `sendText(number, text)` and `sendImage(number, { url, mimetype, fileName }, caption)`, both returning `{ waMessageId }`
  - `sendPresence(number, "composing", delayMs)`, `checkNumbers(numbers)`, `connectionState()`
  - errors are `WhatsAppError(kind: retryable|permanent|unknown, message)`; the message is `not_on_whatsapp` for numbers not on WhatsApp
- Task 07 (`src/lib/services/whatsapp-outbox.ts`): `claimNextOutbox(now)` returns `{ id, phone, purpose, kind, body, mediaRef, conversationId, lease, attempts } | null`, already honouring the window, cap and gap. Also `markOutboxSent(id, lease, waMessageId)`, `markOutboxRetry`, `markOutboxFailed`, `markOutboxUncertain`, `recoverStaleSending()` and `purgeOutbox()`.
- Task 10 (`src/lib/services/whatsapp-inbound-events.ts`): `claimNextInboundEvent()`, `recoverStaleInbound()` and `purgeInboundEvents()`.
- Task 21 (`src/lib/whatsapp/inbound-processor.ts`): `processInboundEvent(ev)`, which calls the mark functions itself.
- Task 08 (`src/lib/services/whatsapp-conversations.ts`): `autoReleaseStale(hours)` and `markNoWhatsapp(phone)`.
- Task 16 (`src/lib/whatsapp/media.ts`): `purgeExpiredMedia(retentionDays)`.
- Task 04: `getWhatsAppSettings()` (`enabled`, `aiResumeAfterHours`, `mediaRetentionDays`) and `setWhatsAppConnectionState({ state })`.
- Task 03: `whatsappConfigured()`.
- Existing worker infrastructure:
  - `src/lib/workers/index.ts`: the `WorkerGlobals` type, `stopWorkerTimers()` key list, `startAllWorkers()`, `startSafely(name, fn)` (whose `recordWorkerError` guard lists names), and `workerHealth()`.
  - `src/lib/services/worker-status.ts`: `type WorkerName = "submission" | "tracking" | "meta" | "tiktok"`, `recordWorkerTick(name)` and `recordWorkerError(name, err)`.
  - `src/lib/workers/meta.ts` is the template: a `running` guard, `setInterval`, a `globalThis.__crm…Worker` timer.
  - `/api/health` at `src/app/api/health/route.ts` reports workers. Read it to add `whatsapp` consistently, including details gated by `HEALTH_DETAILS_TOKEN`.

## Files to Create

- `src/lib/workers/whatsapp.ts`: `startWhatsAppWorker()`.

## Files to Modify

- `src/lib/services/worker-status.ts`: add `"whatsapp"` to `WorkerName`.
- `src/lib/workers/index.ts`:
  - add `__crmWhatsAppWorker` and `__crmWhatsAppMaintenance` to `WorkerGlobals` and to the `stopWorkerTimers` keys
  - `startSafely("whatsapp", startWhatsAppWorker)` in `startAllWorkers`
  - include `"whatsapp"` in the `startSafely` error-record guard
  - add `whatsapp: { enabled }` to `workerHealth()`
- `src/app/api/health/route.ts`: include the WhatsApp worker status. In detailed mode, include `outboxStats()` counts (no phones) and the connection state.

## Technical Details

```ts
export const WA_TICK_MS = 2000;
export const WA_MAINTENANCE_MS = 5 * 60_000;
export const MAX_INBOUND_PER_TICK = 5;

export function startWhatsAppWorker(): void {
  if (!whatsappConfigured()) return;          // inert when unconfigured
  // guard globalThis.__crmWhatsAppWorker; running flag; setInterval(tick, WA_TICK_MS); setInterval(maintenance, WA_MAINTENANCE_MS); run maintenance once at start
}
```

### `tick()`

1. Inbound: process up to `MAX_INBOUND_PER_TICK` events with `claimNextInboundEvent()` and `await processInboundEvent(ev)`, one after another. Inbound is processed **even when `settings.enabled` is false**, so the inbox keeps recording. The processor already skips AI and replies when disabled.
2. Outbound: if `settings.enabled` and the sender is non-null, `claimNextOutbox()`. If a row comes back:
   - `number = phone.replace("+", "")`
   - **Typing simulation** for `ai_reply`, `agent_reply`, `strike_warning` and `product_card`: `await sender.sendPresence(number, "composing", d)` with `d = clamp(body.length * 40ms, 1200, 6000)` plus a random 0–800 ms, then `await sleep(d)`. Presence errors are ignored.
   - Send: text gives `sendText`; image gives `sendImage(number, { url: mediaRef, mimetype: guess from extension, fileName }, body)`.
   - Success gives `markOutboxSent(id, lease, waMessageId)`.
   - `WhatsAppError`:
     - `retryable` gives `markOutboxRetry`.
     - `permanent` gives `markOutboxFailed`. If the message is `not_on_whatsapp`, also call `markNoWhatsapp(phone)` and cancel the phone's other queued rows (a small SQL update in the outbox service, or loop over them).
     - `unknown` gives `markOutboxUncertain`. **Never retry.**
   - Any other thrown error **after** the send call started gives `markOutboxUncertain`. Before the send (e.g. building the payload) gives `markOutboxFailed`.
3. `recordWorkerTick("whatsapp")`. On an outer error, `recordWorkerError("whatsapp", err)` and `log.error("whatsapp.worker_failed", { error })`, with no phone or body.

The tick must not overlap: use a `running` flag. Typing sleeps happen inside the tick, which is fine because the interval skips while running.

### `maintenance()`

- `recoverStaleSending()`, which turns rows into `uncertain`
- `recoverStaleInbound()`
- `autoReleaseStale(settings.aiResumeAfterHours)`
- `connectionState()`, then `setWhatsAppConnectionState`, ignoring errors
- `purgeOutbox()`, `purgeInboundEvents()`, `purgeExpiredMedia(settings.mediaRetentionDays)`

## Acceptance Criteria

- [ ] With WhatsApp unconfigured, the worker doesn't start, health shows `whatsapp.enabled = false`, and existing tests pass.
- [ ] Integration test `scripts/unit/whatsapp-worker.test.mjs` with a stubbed fetch (Evolution) and a temp DB covers:
  - a queued `ai_reply` is sent with presence first and marked sent with `wa_message_id`
  - a timeout gives uncertain and it isn't re-sent on the next ticks
  - a 401 gives failed
  - `not_on_whatsapp` marks the conversation and cancels the other queued rows
  - with the kill switch OFF, nothing is sent while inbound events are still processed
  - maintenance purges old rows
- [ ] Losing the worker lease stops the WhatsApp timers (the existing `stopWorkerTimers` covers the new keys).
- [ ] Lint and tsc pass. `DELIVERY_PROVIDER=mock npm run build` passes.
