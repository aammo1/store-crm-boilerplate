# Task 19: Sendit parcel edit via PUT (DEFERRED)

## Status

deferred

## Wave

Deferred — not part of implementation runs until the owner asks.

## Description

Sendit allows updating an existing parcel (`PUT /api/v1/deliveries/{code}`), e.g. correcting the address or district after a `NEW_DESTINATION` status, or toggling `allow_open`/`allow_try`. Today an order edit after submission does not change the courier parcel (the snapshot is frozen). This task would add an explicit, agent-triggered "Mettre à jour chez Sendit" action.

## Dependencies

**Depends on:** task-08-sendit-adapter.md, task-13-sendit-parcel-lookup.md
**Blocks:** None

**Context from dependencies:** The official plugin first `GET /deliveries/{code}` and resends a full coherent body (`district_id, name, amount, address, phone, comment, reference, allow_try, allow_open`) because the API may require a full PUT. Edits must never be automatic and must be recorded (who/when/what) like other order history.

## Files to Create / Modify (when un-deferred)

- `src/lib/shipping/sendit.ts` — `updateParcel(code, patch)` (optional interface method + capability `parcelEdit`).
- `src/lib/shipping/couriers.ts` — capability flag.
- A service + route + button on the order page; order history entry.

## Technical Details (decisions to confirm before starting)

- Allowed fields: address, district, phone, allow_open, allow_try. Amount changes require explicit admin confirmation (COD money).
- Uncertain PUT result → show "vérifiez sur le portail", no automatic retry.
- Never change `reference`.

## Acceptance Criteria (when un-deferred)

- [ ] Explicit agent action only; recorded in history; uncertain results never retried blindly.
