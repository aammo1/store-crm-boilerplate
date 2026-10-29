# Task 17: Docs, policy, AGENTS.md, ai-memory README

## Status

pending

## Wave

5

## Description

Document the finished feature so future agents and the owner use it correctly: how to choose and activate Sendit, the courier registry/capabilities model, the status-mapping policy difference (Sendit vendor-published vs Ozon unverified), mock profiles, the generic `COURIER_*` knobs, the shared-account COD behaviour, upgrading existing store copies, and switching courier on a live store (manual review). Also update `AGENTS.md` and one line in the sibling `ai-memory-boilerplate` repo.

## Dependencies

**Depends on:** task-04, task-07, task-11, task-12, task-13, task-14, task-15, task-16
**Blocks:** None

**Context from dependencies (what now exists):**
- Env: `DELIVERY_PROVIDER` = exact `mock` | `ozon` | `sendit` (anything else = Ozon); `MOCK_COURIER_PROFILE` = `ozon` (default) | `sendit`; `SENDIT_PUBLIC_KEY`, `SENDIT_SECRET_KEY`; `COURIER_SUBMIT_INTERVAL_SEC` (15), `COURIER_POLL_INTERVAL_MIN` (30), `COURIER_TRACK_BATCH` (25) with `OZON_*` fallbacks.
- Registry `src/lib/shipping/couriers.ts` (capabilities `deliveryNotes`, `labels`, `labelFormats`, `parcelLookup`, `bulkTracking`, `pickupDistrict`); adapters `ozon.ts`, `sendit.ts`, `mock.ts` (profiles); shared `city-sync.ts` (records provider, Arabic names, pickup flag, pre-fills missing tariffs from courier prices); `parcel-payload.ts` reference `"<slug>-<orderId>"`.
- Migration `029_courier_providers.sql` (provider on submissions/cities, `arabic_name`, `is_pickup`).
- Status maps: Ozon empty (unchanged policy); Sendit mapped from the official Sendit plugin's `GET /all-status-deliveries` list; new normalized `awaiting_pickup`, `delivery_issue`.
- `throttled` error kind (Sendit 429 on create → requeue).
- CRM: Paramètres → "Transporteur Sendit" (pickup district required, opening/try-on flags); Expéditions adapts (Ozon BL vs Sendit labels + bulk handoff); "Chercher chez Sendit" in the submission resolution form (read-only); dashboard courier health card + "Tester la connexion"; `/api/health` details `courier` block; Arabic/alias city search; address ≥ 5 chars before confirmation; COD unknown lines shown as "Autre boutique / inconnu" and ignored.
- Wizard: `courier` field (`ozon`/`sendit`), conditional keys, `MOCK_COURIER_PROFILE` written; answers keys `courier`, `senditPublicKey`, `senditSecretKey`.
- Scripts: `npm run sendit:verify -- --live --yes [--code X]`; contract tests `scripts/unit/courier-contract.test.mjs`.

## Files to Create

- None.

## Files to Modify

- `docs/operations.md` — runtime config table (new vars), "Activation Sendit par le propriétaire" section (mirror the Ozon activation section: stay on mock until keys; `sendit:verify`; choose pickup district; first real parcel checklist; never expose keys; worker alone creates parcels, poller alone tracks; labels + explicit handoff; uncertain → needs_review + lookup helper), outcomes section (Sendit automatic delivered/refused, `delivery_issue` alerts; Ozon still manual), COD section (shared account), health section (courier card).
- `docs/new-niche.md` — wizard courier question, answers keys, go-live checklist per courier.
- `docs/template-upgrades.md` — how an existing store copy adopts this (migration 029, env renames optional, Ozon unchanged) and "switching courier on a live store" (finish/resolve open parcels, sync new cities, review tariffs and city ids on open orders, change env, no automatic migration).
- `docs/release-verification.md` — add `src/lib/shipping/sendit.ts`, `couriers.ts`, `city-sync.ts`, `scripts/sendit-verify.mjs` to the release file list.
- `src/lib/shipping/POLICY.md` — throttled rule; lookup helper is read-only; status-map sources per courier.
- `AGENTS.md` — update: "Only exact `mock` selects mock; exact `sendit` selects Sendit; unset/other values select Ozon"; ownership list adds `couriers.ts` registry and `city-sync.ts`; invariant wording "Unknown/unverified tracking statuses never automatically change stock; Sendit's map comes from the vendor-published status list, Ozon's stays empty until verified"; commands add `npm run sendit:verify`; mention `MOCK_COURIER_PROFILE`. Keep the file's terse style.
- `/home/tal7a/Projects/ai-memory-boilerplate/README.md` (line ~57) and `/home/tal7a/Projects/ai-memory-boilerplate/docs/SETUP.md` (line ~5) — "Ozon Express Morocco or `mock` courier" → "Ozon Express or Sendit (chosen in the store wizard), or `mock`". Only these lines in that repo.

## Technical Details

- French for operations docs (match existing language of each doc).
- Don't invent behaviour: read the implemented code for exact env names, routes and messages before writing.
- Mark `specs/whatsapp-assistant/tasks/task-20…` and `task-27…` remain "superseded" (already edited at spec time — verify only).

## Acceptance Criteria

- [ ] An owner can activate Sendit for a new store by following `docs/new-niche.md` + `docs/operations.md` alone.
- [ ] AGENTS.md reflects the new selection rule, registry and commands.
- [ ] Only the two lines changed in ai-memory-boilerplate.
- [ ] `npm run lint` passes (docs only otherwise).
