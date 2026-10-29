# Task 20: Courier provider groundwork

## Status

superseded — replaced by `specs/sendit-courier/` (tasks 02 and 06). Do not implement.

## Wave

3

## Description

This prepares the data model for a second courier (Sendit, task 27) without changing behaviour. The plan is **one courier per store copy**, selected by `DELIVERY_PROVIDER`. Recording the provider on every courier submission and every synced city means a store that ever switches courier keeps correct history, and the poller can later query each parcel with the right adapter. Today every value is `ozon`, or `mock` in tests.

## Dependencies

**Depends on:** task-02-migration-whatsapp.md
**Blocks:** task-27-sendit-adapter

**Context from dependencies:** Task 02 added `courier_submissions.provider TEXT NOT NULL DEFAULT 'ozon'` and `cities.provider TEXT NOT NULL DEFAULT 'ozon'`.

Existing code:
- `src/lib/services/submissions.ts` `createSubmission(orderId)` inserts `courier_submissions` rows. It's called from `confirmOrder` and in resolution flows; check `src/lib/services/submission-resolution.ts` for any other INSERT into `courier_submissions`.
- `src/lib/shipping/ozon.ts` `syncCities(provider)` upserts into `cities`.
- `src/lib/env.ts` `deliveryProviderName()` returns `"mock" | "ozon"`. Only an exact `mock` selects mock.

## Files to Create

- None.

## Files to Modify

- `src/lib/services/submissions.ts`: every INSERT into `courier_submissions` sets `provider = deliveryProviderName()`. Add `provider` to `SubmissionRow` and to the selects.
- `src/lib/services/submission-resolution.ts`: same, if it inserts submissions.
- `src/lib/shipping/ozon.ts`: the `syncCities` upsert sets `provider = 'ozon'`. Don't change city IDs.
- `docs/template-upgrades.md`: a short note saying `provider` columns exist and that switching courier on a live store requires a deliberate review (city ids, tariffs, BL flow).

## Technical Details

- Don't touch `src/lib/services/tracking.ts` (task 19 modifies it in this wave). Task 27 adds the per-provider poll filter.
- Don't change `getProvider()` or the env validation. `sendit` isn't accepted yet.
- Display: if the expeditions UI shows submission details, it may show the provider in small text. That's optional; skip it if it touches hot files.

## Acceptance Criteria

- [ ] New submissions record `mock` in tests and `ozon` otherwise. Existing rows keep `ozon`.
- [ ] `npm run test:crm` passes unchanged.
- [ ] Lint and tsc pass.
