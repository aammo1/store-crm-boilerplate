# Task 12: Arabic/alias city search and confirm guards

## Status

pending

## Wave

3

## Description

Agents confirm orders by phone and type the city the way customers say it — often in Arabic ("الدار البيضاء") or with common short names ("Casa", "Tanger"). Sendit returns Arabic district names; the current city picker strips every non-Latin character from its search key, so Arabic never matches. This task makes the picker search Arabic names and a small alias list, makes city lists/validation use only the active courier's cities, and requires a real address (≥ 5 characters) before confirmation for every courier, so a parcel is never sent to a courier that will certainly reject it.

## Dependencies

**Depends on:** task-05-neutral-copy-knobs.md, task-06-shipping-core-refactor.md
**Blocks:** task-17-docs-policy.md

**Context from dependencies:**
- Task 06: `cities` rows have `provider` (`mock|ozon|sendit`, from the provider that synced them) and nullable `arabic_name`; Ozon cities have no Arabic name.
- Task 05 edited only the cancel-blocked message in `src/lib/services/confirmation.ts` (~line 281); leave it.
- `src/lib/env.ts` `deliveryProviderName()` returns the provider name used as `cities.provider`.
- Existing: `src/components/crm/city-combobox.tsx` exports `CityOption {id:number; name:string}` and `CityCombobox({id, cities, value, onChange, disabled, placeholder, noneLabel, className})`; `searchKey()` NFD-strips accents and replaces `[^a-z0-9]+` with spaces (Arabic lost); prefix then substring match; `MAX_RESULTS = 60`.
- `src/lib/services/orders.ts:~877` `listCities()` → `SELECT id, name FROM cities` (feeds the pickers on confirm, manual order, edit order).
- `src/lib/services/confirmation.ts:~135` validates `input.address?.trim()` non-empty and ≤ 500 chars and `cityId` positive; ~148–153 checks the city exists in `cities` ("Ville inconnue — lancez la synchronisation des villes").
- `src/lib/services/manual-orders.ts:~189` validates the city id against `cities`; `src/lib/services/order-edits.ts` may validate cities too (check).

## Files to Create

- None.

## Files to Modify

- `src/components/crm/city-combobox.tsx` — Arabic-aware search, optional `arabicName`, aliases, show Arabic name as secondary text.
- `src/lib/services/orders.ts` — `listCities()` filters by active provider and returns `arabicName`.
- `src/lib/services/confirmation.ts` — city existence check scoped to the active provider; address ≥ 5 chars.
- `src/lib/services/manual-orders.ts` — same city scoping (and address rule only if it confirms immediately).
- `src/lib/services/order-edits.ts` — same city scoping if it validates city ids.

## Technical Details

### Search

```ts
export interface CityOption { id: number; name: string; arabicName?: string | null }

const ALIASES: Record<string, string[]> = {
  casablanca: ["casa", "dar el beida", "darbeida"],
  tanger: ["tangier", "tanja"],
  marrakech: ["marrakesh", "kech"],
  fes: ["fez"],
  meknes: ["meknas"],
  agadir: ["agadir"],
  laayoune: ["layoune", "el aaiun"],
  "el jadida": ["jadida"],
  kenitra: ["knitra"],
  tetouan: ["tetuan", "tetwan"],
};

function latinKey(v: string) { /* existing searchKey */ }
function arabicKey(v: string) {
  return v.replace(/\u0640/g, "")                 // tatweel
          .replace(/[\u064B-\u0652\u0670]/g, "")   // harakat
          .replace(/[إأآا]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
          .replace(/\s+/g, " ").trim();
}
```

- Index each city with `keys = [latinKey(name), ...aliasesFor(latinKey(name)), arabicName ? arabicKey(arabicName) : null]`.
- If the query contains Arabic letters (`/\p{Script=Arabic}/u`), match against the Arabic key (prefix, then substring); otherwise against Latin name + aliases (prefix, then substring). Keep `MAX_RESULTS` and existing keyboard/ARIA behaviour.
- Option label: `name` with `arabicName` in muted text after it (`dir="rtl"` span) when present.

### City scoping

- `listCities()`: `SELECT id, name, arabic_name AS arabicName FROM cities WHERE provider = ? ORDER BY name` with `deliveryProviderName()`.
- Confirmation/manual/edit existence checks: `SELECT 1 FROM cities WHERE id = ? AND provider = ?`. Keep the existing error message.
- Live Ozon stores: existing rows default to `'ozon'`, so nothing changes. Tests run with `mock` and sync mock cities with provider `mock`; if a test inserts cities manually without `provider`, it gets `'ozon'` — update such test fixtures by adding `provider = 'mock'` (search `INSERT INTO cities` in `scripts/`), and list those test files in your summary.

### Address rule

In `confirmation.ts`, replace the empty check with `const address = input.address?.trim() ?? ""; if (address.length < 5 || address.length > 500 || …)` and message `"Adresse trop courte — indiquez au moins le quartier et la rue (5 caractères minimum)."`. Keep other validations. Apply the same rule in `manual-orders.ts` only if manual orders create a courier submission immediately; otherwise leave it.

## Acceptance Criteria

- [ ] Typing "الدار" or "casa" finds Casablanca (when Arabic names exist / alias matches); Latin search unchanged.
- [ ] City pickers and validations only use the active provider's cities.
- [ ] Confirmation rejects addresses shorter than 5 characters with the French message.
- [ ] `npm run test:crm`, `npm run test:unit`, `npm run lint`, `npx tsc --noEmit` pass.
