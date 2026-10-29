# Task 16: sendit:verify live read-only script

## Status

complete

## Wave

4

## Description

Provide `npm run sendit:verify -- --live --yes [--code <parcel code>]`, a read-only live check the store owner runs once per Sendit store (never in CI or tests). It confirms the keys log in, districts download (count, pickup districts, sample Arabic names), and optionally fetches one existing parcel to show its raw status shape — so any Sendit status not in our mapping table is noticed before going live. Mirrors the existing `scripts/ozon-verify.mjs`.

## Dependencies

**Depends on:** task-08-sendit-adapter.md
**Blocks:** task-17-docs-policy.md

**Context from dependencies:**
- `scripts/ozon-verify.mjs` is the pattern: refuses to run without `--live --yes`, loads the store's `.env.local` itself (this is the only script allowed to, because the owner runs it deliberately on their own store), redacts URLs/secrets in every print, read-only calls only. Read it first and mirror its structure, flags and messages.
- `package.json` has `"ozon:verify": "node scripts/ozon-verify.mjs"` (line ~31).
- Sendit API: `POST https://app.sendit.ma/api/v1/login` `{public_key, secret_key}` → `data.token`; `GET /districts?page=N` (Bearer) → `{data, last_page}`; `GET /deliveries/{code}` → `{success, data:{status (string or {code}), reference, …}}`. Statuses known to the CRM are in `SENDIT_STATUS_MAP` (`src/lib/shipping/status-map.ts`): PENDING, TO_PREPARE, TOPICKUP, PICKEDUP, TRANSIT, WAREHOUSE, DISTRIBUTED, DELIVERING, UNREACHABLE, POSTPONED, NEW_DESTINATION, DELIVERED, REJECTED, RETURNED, CANCELED (+ aliases TO_PICKUP, PICKED_UP, CANCELLED, IN_TRANSIT, RETOUR, RETURN).

## Files to Create

- `scripts/sendit-verify.mjs`

## Files to Modify

- `package.json` — add `"sendit:verify": "node scripts/sendit-verify.mjs"` next to `ozon:verify`.

## Technical Details

- Plain Node ESM, no TS imports (keep it standalone like `ozon-verify.mjs`); duplicate the small status list with a comment pointing at `status-map.ts`.
- Steps: parse flags → refuse without `--live --yes` (print usage) → load `.env.local` (same loader as ozon-verify) → require `SENDIT_PUBLIC_KEY`/`SENDIT_SECRET_KEY` → login (print "Connexion : OK", never the token) → districts all pages (cap 50): print total, pickup count (pickup_district==1 or ville Casablanca), 3 sample `name / arabic_name`, how many have integer `price` → if `--code`: GET the parcel, print code, reference, raw status and whether it's known; print unknown keys of `data` (names only, no values except status/reference/code).
- Every printed string passes through a redactor that masks both keys, the token and `Bearer …`.
- Exit code 0 on success, 1 on any failure with a French message. Timeouts 20 s.
- Never write to the DB, never create/update parcels or labels.

## Acceptance Criteria

- [ ] Without `--live --yes` the script exits without any network call.
- [ ] With fake env and `NODE_OPTIONS=--import=$PWD/scripts/block-external-network.mjs`, it fails cleanly (blocked network) and prints no secret.
- [ ] `npm run lint` passes.
