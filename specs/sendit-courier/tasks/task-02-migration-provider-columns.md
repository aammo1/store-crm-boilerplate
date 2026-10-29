# Task 02: Migration 029 provider columns

## Status

complete

## Wave

1

## Description

Record which courier produced every courier submission and every synced city, and add the city fields Sendit provides (Arabic name, pickup capability). One courier per store is the rule, but recording the provider keeps history correct if a store is ever switched deliberately, lets the poller query only the active courier's parcels, and lets city pickers show only the active courier's cities. This replaces the provider columns that the WhatsApp spec (task 02, migration 028) originally planned; that spec has been edited to drop them.

## Dependencies

**Depends on:** None (Wave 1)
**Blocks:** task-06-shipping-core-refactor.md

**Context from dependencies:** None. Existing schema (from `migrations/001_init.sql`, never edit it): `cities (id INTEGER PRIMARY KEY, name TEXT, updated_at TEXT)`; `courier_submissions (id, order_id, status CHECK(queued/submitting/submitted/failed/needs_review), attempts, next_retry_at, payload_json, tracking_number, raw_response_json, last_error, normalized_status, raw_status, last_sync_at, created_at, updated_at)`. Migrations run in sorted filename order inside a transaction and are recorded with a checksum in `_migrations` (`src/lib/migrate.ts`); unapplied files are applied even if a lower number appears later, so `029` is safe even though `028_whatsapp.sql` is reserved by another spec and may not exist yet. `src/lib/services/submissions.ts` has the only `INSERT INTO courier_submissions` (around line 79). `src/lib/env.ts` exports `deliveryProviderName()` returning `"mock" | "ozon"` today (`"sendit"` after task 01; no compile dependency for this task).

## Files to Create

- `migrations/029_courier_providers.sql`

## Files to Modify

- `src/lib/services/submissions.ts` — insert `provider = deliveryProviderName()`; add `provider` to the row type/selects it returns.

## Technical Details

### `migrations/029_courier_providers.sql`

```sql
-- Courier provenance (one courier per store; history survives a deliberate switch).
ALTER TABLE courier_submissions ADD COLUMN provider TEXT NOT NULL DEFAULT 'ozon';
ALTER TABLE cities ADD COLUMN provider TEXT NOT NULL DEFAULT 'ozon';
-- Sendit district extras (NULL/0 for Ozon).
ALTER TABLE cities ADD COLUMN arabic_name TEXT;
ALTER TABLE cities ADD COLUMN is_pickup INTEGER NOT NULL DEFAULT 0 CHECK (is_pickup IN (0,1));

CREATE INDEX IF NOT EXISTS idx_submissions_provider_status ON courier_submissions(provider, status);
CREATE INDEX IF NOT EXISTS idx_cities_provider_name ON cities(provider, name);
```

Allowed provider values are `mock`, `ozon`, `sendit` (no CHECK constraint, so a future courier needs no migration). `cities.id` stays the primary key (courier city/district id) — no composite key.

### `submissions.ts`

- Import `deliveryProviderName` from `@/lib/env`.
- Change the INSERT to include `provider` with `deliveryProviderName()` evaluated at insert time.
- Add `provider: string` to `SubmissionRow` (or the equivalent exported type) and to every SELECT that maps into it. Don't change any other behaviour.

Do not touch `src/lib/shipping/ozon.ts` (city sync moves to a new module in task 06, which writes `cities.provider`).

## Acceptance Criteria

- [ ] Fresh DB applies all migrations including 029 (`scripts/unit/migrate.test.mjs` passes).
- [ ] New submissions record `mock` under tests; existing rows default to `ozon`.
- [ ] `npm run test:unit`, `npm run test:crm`, `npm run lint`, `npx tsc --noEmit` pass.

## Notes

If `migrations/028_whatsapp.sql` already exists when you implement this and it still contains `ALTER TABLE … ADD COLUMN provider`, stop and report — the WhatsApp spec's task 02 was edited to remove those two ALTERs, and adding them twice fails.
