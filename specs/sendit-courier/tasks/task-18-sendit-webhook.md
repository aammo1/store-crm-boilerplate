# Task 18: Sendit status webhook (DEFERRED)

## Status

deferred

## Wave

Deferred — not part of implementation runs until the owner asks.

## Description

Sendit can push status changes to a merchant URL (`{reference, status, event_id?}` JSON; the official plugin authenticates it with a shared secret in `?token=` or header `X-Sendit-Token`). Polling (task 09) already covers tracking; a webhook would make updates near-real-time. It introduces a new unauthenticated-by-session inbound route, so it needs its own security review before implementation.

## Dependencies

**Depends on:** task-09-status-maps-tracking.md, task-14-courier-health.md
**Blocks:** None

**Context from dependencies:** Polling persists observations via `persistObservation` / `applySideEffects` in `src/lib/services/tracking.ts`, normalized with `normalizeStatus(raw, "sendit")`; submissions are found by `tracking_number` or by `payload_json.courier_reference` ("<slug>-<orderId>").

## Files to Create (when un-deferred)

- `src/app/api/couriers/sendit/webhook/route.ts`

## Files to Modify (when un-deferred)

- `src/lib/services/tracking.ts` — export an "apply one observation" entry point reused by poller and webhook.
- `docs/operations.md`, `AGENTS.md` (narrow inbound-webhook exception, like the WhatsApp spec's).

## Technical Details (decisions to confirm before starting)

- Secret `SENDIT_WEBHOOK_TOKEN` (≥ 32 chars) compared with `timingSafeEqual`; prefer header over query (query tokens leak into proxy logs — redact `token` in logs).
- Body ≤ 64 KiB; reference must match `^[A-Za-z0-9_-]{1,64}$` and belong to this store's slug; status `^[A-Z][A-Z0-9_]{0,63}$`.
- Idempotent: dedupe by `(submission, raw_status, observed_at)` like the poller; `event_id` hashes kept for replay protection.
- Late non-final statuses never move a delivered/refused parcel backwards (existing sticky logic).
- Webhook never creates parcels; poller remains the fallback; budget/rate limit per IP.

## Acceptance Criteria (when un-deferred)

- [ ] Security review approved; invalid token → 401 without DB access; replay safe; same side effects as polling.
