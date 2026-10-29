# Task 05: Courier-neutral copy, COURIER_* knobs, throttled error kind

## Status

complete

## Wave

2

## Description

Make the provider-agnostic parts of the CRM stop saying "Ozon", switch the worker knobs to generic `COURIER_*` names (keeping `OZON_*` as fallbacks so existing stores keep working), and add a `throttled` provider error kind so a courier can say "rate-limited, nothing was created" — Sendit returns HTTP 429 on create in that case, and the safe action is to requeue rather than send the job to `needs_review`. Ozon's adapter never raises `throttled`, so Ozon behaviour is unchanged.

## Dependencies

**Depends on:** task-01-courier-registry-env.md
**Blocks:** task-08-sendit-adapter.md, task-09-status-maps-tracking.md, task-12-city-search-confirm-guards.md

**Context from dependencies:** Task 01 created `src/lib/shipping/couriers.ts` (`COURIERS: Record<"ozon"|"sendit", {label, portalUrl, capabilities, requiredEnv, secretEnv}>`) and added to `src/lib/env.ts`: `courierProfile()` (the courier the store behaves like: `"ozon"|"sendit"`, honouring `MOCK_COURIER_PROFILE` in mock mode) and `courierNumberEnv(suffix)` which reads `COURIER_<suffix>` then `OZON_<suffix>` and returns a number or `undefined`.

## Files to Create

- `src/lib/shipping/courier-copy.ts` — server-only helpers for courier display names in copy.

## Files to Modify

- `src/lib/shipping/errors.ts` — add `"throttled"` to `ProviderErrorKind`, optional `retryAfterSec`.
- `src/lib/workers/submission.ts` — knob via `courierNumberEnv("SUBMIT_INTERVAL_SEC")`; handle `throttled` → requeue; neutral copy.
- `src/lib/services/tracking.ts` — **only** `pollIntervalMin()` and `trackBatchSize()` switch to `courierNumberEnv` (task 09 edits the rest of this file later).
- `src/lib/api-schemas.ts` — neutral evidence message (line ~124).
- `src/lib/services/submission-resolution.ts` — neutral evidence message (line ~26) and comment.
- `src/lib/services/confirmation.ts` — neutral cancel-blocked message (line ~281) only.
- `src/lib/services/delivery-notes.ts` — messages at lines ~82, ~203, ~270 use the courier label.
- `src/app/api/crm/bl/[id]/pdf/route.ts` — messages at ~102, ~109, ~118 use the courier label.
- `src/components/crm/bl-operation-card.tsx`, `src/components/crm/submission-resolve-form.tsx` — generic client copy.
- `src/lib/assistant.ts` — "ni contacter le transporteur".

## Technical Details

### `courier-copy.ts`

```ts
import "server-only"; // only if other server modules in src/lib use this marker; otherwise omit (node tests load these files via loadSource — check that "server-only" resolves there; if not, omit)
import { courierProfile } from "@/lib/env";
import { COURIERS } from "./couriers";

export function courierLabel(): string { return COURIERS[courierProfile()].label; }
/** "le portail Ozon Express" / "le portail Sendit" */
export function courierPortal(): string { return `le portail ${courierLabel()}`; }
```

Evaluate at call time (inside functions), never at module load, so tests that switch env still work.

### Copy changes

Server-side strings → use `courierPortal()`:
- `workers/submission.ts` lines ~68 and ~154: `… — vérifier sur ${courierPortal()} avant toute re-création`. These are SQL `COALESCE(last_error, '…')` literals: pass the text as a bound parameter instead of interpolating into SQL.
- `workers/submission.ts` ~208 mock log: `aucun appel réel au transporteur`.
- `confirmation.ts` ~281: `Résultat transporteur incertain — vérifiez ${courierPortal()} et résolvez la soumission avant d'annuler.`
- `delivery-notes.ts` ~82/~203/~270 and `bl/[id]/pdf/route.ts` ~102/~109/~118: replace "le portail Ozon" / "portail Ozon" with `courierPortal()`; keep the rest of each sentence.

Static/client strings → generic (no env access in client components or module-level zod messages):
- `api-schemas.ts` ~124 and `submission-resolution.ts` ~26: `Décrivez la vérification effectuée chez le transporteur (portail ou support).`
- `bl-operation-card.tsx`: "Résoudre après vérification chez le transporteur", "Vérifiez le résultat dans le portail du transporteur (ou auprès du support) avant de choisir.", "BL enregistré chez le transporteur", "Ancien BL inutilisé — aucun colis chez le transporteur, vérifié", "Référence du BL existant chez le transporteur", placeholder "Ex. : portail du transporteur vérifié le…, référence…, codes de suivi présents / absents…".
- `submission-resolve-form.tsx` ~68: "Vérifiez d'abord le portail du transporteur : …"; ~118 placeholder "Ex. portail du transporteur consulté le 14/10, aucun colis au nom de la cliente."; comment at ~18 neutral. Do not add props (task 13 adds lookup props later).
- `assistant.ts` ~24: "… ni créer un BL, ni contacter le transporteur."

Existing tests use evidence strings containing "Portail Ozon" as *input*; they stay valid. Run `grep -rn "Ozon" scripts/*.test.mjs` and update only assertions on output messages you changed.

### Knobs

```ts
// submission.ts
export function submissionIntervalMs(): number {
  const raw = courierNumberEnv("SUBMIT_INTERVAL_SEC");
  const sec = raw !== undefined && raw > 0 ? raw : DEFAULT_INTERVAL_SEC;
  return Math.max(sec, MIN_INTERVAL_SEC) * 1000;
}
// tracking.ts
pollIntervalMin(): courierNumberEnv("POLL_INTERVAL_MIN") with same default/min logic
trackBatchSize(): const raw = courierNumberEnv("TRACK_BATCH"); Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_TRACK_BATCH
```

### `throttled`

```ts
export type ProviderErrorKind = "retryable" | "permanent" | "unknown" | "throttled";
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryAfterSec?: number;
  constructor(kind, message, options?: { cause?: unknown; retryAfterSec?: number })
}
```

Doc comment: `throttled` = the courier explicitly refused to process the request (e.g. HTTP 429) **and nothing was created**; only adapters that can guarantee this may raise it.

In `submission.ts` catch block (around lines 120–133, after `provider.createParcel`): before the `permanent` branch, add

```ts
} else if (err instanceof ProviderError && err.kind === "throttled") {
  requeue(id, `Transporteur saturé (429) — nouvel essai planifié : ${message}`);
}
```

`requeue` currently uses `REQUEUE_DELAY_MS` (60 s); if `err.retryAfterSec` is set, use `max(REQUEUE_DELAY_MS, retryAfterSec*1000)` capped at 15 minutes (add an optional delay param to `requeue`). `attempts` keeps incrementing as today. All other branches unchanged.

## Acceptance Criteria

- [ ] No user-facing "Ozon" string remains in the files listed (BL wording stays, it is Ozon's capability, but says "transporteur").
- [ ] `OZON_SUBMIT_INTERVAL_SEC`/`OZON_POLL_INTERVAL_MIN`/`OZON_TRACK_BATCH` still work; `COURIER_*` take precedence.
- [ ] A `throttled` error after the request is sent requeues the job (status `queued`, future `next_retry_at`), never `needs_review`.
- [ ] `npm run test:crm`, `npm run test:unit`, `npm run test:assistant`, `npm run lint`, `npx tsc --noEmit` pass.
