# Task 04: COD import ignores other stores' parcels

## Status

complete

## Wave

1

## Description

The owner runs several niche stores and may use one Sendit (or Ozon) account for all of them. A courier COD statement then lists parcels from every store. Today, a statement line whose tracking number is not found in this store is classified `unmatched` with "Aucune commande avec ce numéro de suivi." and shown as "Introuvable", which looks like an error. This task reclassifies those lines as **foreign**: clearly labelled as probably belonging to another store on the same account, ignored by the import, counted separately, and never blocking the import of this store's lines. Courier-agnostic; helps Ozon stores too.

## Dependencies

**Depends on:** None (Wave 1)
**Blocks:** task-17-docs-policy.md

**Context from dependencies:** None. Existing code in `src/lib/services/cod-remittances.ts`:
- `type PreviewStatus = "matched" | "mismatch" | "unmatched" | "invalid" | "duplicate" | "already_paid" | "needs_delivery" | "not_deliverable"`.
- `matchTracking(tracking)` finds a submitted `courier_submissions` row by `upper(tracking_number)`.
- `classify(m, paid, fee)` returns `{status:"unmatched", message:"Aucune commande avec ce numéro de suivi."}` when nothing matched (line ~124).
- Import (around line ~392) pushes non-importable rows into `skipped` with a reason.
- UI `src/components/crm/remittance-workspace.tsx` maps statuses to French labels (`unmatched: "Introuvable"`, line ~33).
- Tests: `scripts/unit/cod-remittances.test.mjs`.

## Files to Create

- None.

## Files to Modify

- `src/lib/services/cod-remittances.ts` — rename the status `unmatched` → `foreign` everywhere (type, classify, import, summaries) with the new message; make sure foreign rows never fail or block the import and are counted as ignored.
- `src/components/crm/remittance-workspace.tsx` — label `foreign: "Autre boutique / inconnu"`, neutral (muted, not red) styling, a summary line "N colis inconnus dans cette boutique ignorés (autre boutique du même compte ?)" in the preview and after import.
- `scripts/unit/cod-remittances.test.mjs` — update expectations; add a statement mixing this store's tracking numbers with unknown ones: known lines import, unknown are reported as `foreign` and ignored.

## Technical Details

- New message: `Colis inconnu dans cette boutique (autre boutique du même compte ?) — ignoré.`
- Keep every other status unchanged. A line with a known tracking number keeps its existing classification even if it looks odd.
- If any persisted data stores the literal `"unmatched"` (search `cod_remittance_lines` / migration 025 for a CHECK or stored status), keep reading old values as `foreign` and don't write migrations; if a CHECK constraint lists `unmatched`, keep writing `unmatched` in the DB and map it to `foreign` only in the preview/API layer — report this choice in your summary.
- Search the repo for `"unmatched"` (`grep -rn unmatched src scripts`) and update all usages (API route response typing, UI filters).

## Acceptance Criteria

- [ ] Unknown tracking numbers show as "Autre boutique / inconnu" with the new message and are ignored without error.
- [ ] Import of the store's own lines succeeds in the same run; summary shows the ignored count.
- [ ] `npm run test:unit`, `npm run lint`, `npx tsc --noEmit` pass.
