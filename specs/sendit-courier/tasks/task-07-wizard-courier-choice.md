# Task 07: Wizard courier choice and env files

## Status

pending

## Wave

2

## Description

When starting a new niche store, `npm run new-store` must ask which courier the store uses (`ozon` or `sendit`) and collect only that courier's keys (optional, can be added later). It writes `DELIVERY_PROVIDER` and `MOCK_COURIER_PROFILE` so that local dev always runs on the mock but **behaves like the chosen courier**, and production uses the real courier only once its keys are filled (same rule as Ozon today). The answers file (`--answers`, used by `ai-memory-boilerplate/scripts/new-niche.py`) supports the new keys. `.env.example` and `docker-compose.yml` document the new variables.

## Dependencies

**Depends on:** task-01-courier-registry-env.md
**Blocks:** task-17-docs-policy.md

**Context from dependencies:** Task 01 created `src/lib/shipping/couriers.ts` with `COURIERS = { ozon: {name:"ozon", label:"Ozon Express", requiredEnv:["OZON_CLIENT_ID","OZON_API_KEY"], …}, sendit: {name:"sendit", label:"Sendit", requiredEnv:["SENDIT_PUBLIC_KEY","SENDIT_SECRET_KEY"], …} }` and env rules: `DELIVERY_PROVIDER` exact `mock`/`sendit`, else Ozon; `MOCK_COURIER_PROFILE` exact `sendit` → Sendit-like mock, else Ozon-like; generic knobs `COURIER_SUBMIT_INTERVAL_SEC` (15), `COURIER_POLL_INTERVAL_MIN` (30), `COURIER_TRACK_BATCH` (25) with `OZON_*` fallbacks.

Existing wizard (`scripts/new-store.mjs`):
- `FIELDS` array (line ~68): entries `{ key, prompt, group?, required?, optional?, secret?, hidden?, userOnly?, default?(answers), parse(v) }`; `FieldError` for validation; `str()` helper. Current Ozon fields (lines ~127–128): `ozonClientId` (group "Ozon (optionnel, peut être fait plus tard)") and `ozonApiKey` (secret).
- `collectInteractive(skipUser)` (line ~168) and `collectFromFile(file, skipUser)` (line ~207) loop over FIELDS; the file collector rejects unknown keys (except `_`-prefixed).
- Env: `scripts/new-store/env.mjs` — `PRODUCTION_ENV_HEADER`, `envText(values, header)`, `envValues(a, {production, catalogAgentKey})` currently returns `DELIVERY_PROVIDER: production && hasOzon ? "ozon" : "mock"`, `OZON_CLIENT_ID`, `OZON_API_KEY`, `OZON_BASE_URL`. Called at lines ~467/475 for `.env.local` and `.env.production.example`.
- `examples/new-store-answers.json` includes `ozonClientId`, `ozonApiKey`.
- Test: `scripts/unit/new-store-env.test.mjs` (without Ozon creds, production falls back to mock).
- `.env.example` lines ~25–37 hold `OZON_*` and `DELIVERY_PROVIDER="mock"`; `docker-compose.yml` lines ~13–21 pass `OZON_*` and `DELIVERY_PROVIDER: ${DELIVERY_PROVIDER:?set mock or ozon}`.

## Files to Create

- `scripts/new-store/couriers.mjs` — plain-JS mirror of the registry names/labels/requiredEnv for the wizard.

## Files to Modify

- `scripts/new-store.mjs` — `courier` field, conditional credential fields (`when` predicate), honour `when` in both collectors.
- `scripts/new-store/env.mjs` — courier-aware env values and header.
- `examples/new-store-answers.json` — add `"courier": "ozon"`, `"senditPublicKey": ""`, `"senditSecretKey": ""`.
- `scripts/unit/new-store-env.test.mjs` — new cases + registry mirror check.
- `.env.example`, `docker-compose.yml` — new variables.

## Technical Details

### `scripts/new-store/couriers.mjs`

```js
// Mirror of src/lib/shipping/couriers.ts (checked by scripts/unit/new-store-env.test.mjs).
export const WIZARD_COURIERS = {
  ozon: { label: "Ozon Express", requiredEnv: ["OZON_CLIENT_ID", "OZON_API_KEY"] },
  sendit: { label: "Sendit", requiredEnv: ["SENDIT_PUBLIC_KEY", "SENDIT_SECRET_KEY"] },
};
```

### FIELDS

Replace the two Ozon fields with:

```js
{ key: "courier", prompt: "Transporteur (ozon/sendit)", group: "Livraison", default: () => "ozon",
  parse: (v) => { const c = str(v).toLowerCase(); if (!(c in WIZARD_COURIERS)) throw new FieldError("« ozon » ou « sendit » attendu"); return c; } },
{ key: "ozonClientId", prompt: "Ozon Client ID (optionnel, peut être fait plus tard)", optional: true, when: (a) => a.courier === "ozon", parse: str },
{ key: "ozonApiKey", prompt: "Ozon API key (optionnel)", optional: true, secret: true, when: (a) => a.courier === "ozon", parse: str },
{ key: "senditPublicKey", prompt: "Sendit clé publique (optionnel, peut être fait plus tard)", optional: true, when: (a) => a.courier === "sendit", parse: str },
{ key: "senditSecretKey", prompt: "Sendit clé secrète (optionnel)", optional: true, secret: true, when: (a) => a.courier === "sendit", parse: str },
```

Both collectors: `if (field.when && !field.when(answers)) { answers[field.key] = ""; continue; }`. In the file collector, a provided value for a field whose `when` is false is ignored (do not error) so old answer files with `ozonClientId` keys keep working. A missing `courier` in an answers file defaults to `ozon` (backward compatible). Print a one-line hint after choosing Sendit: "Le district de ramassage se choisit ensuite dans CRM → Paramètres."

### `envValues`

```js
const courier = a.courier === "sendit" ? "sendit" : "ozon";
const creds = courier === "sendit" ? Boolean(a.senditPublicKey && a.senditSecretKey) : Boolean(a.ozonClientId && a.ozonApiKey);
return {
  …existing keys…,
  DELIVERY_PROVIDER: production && creds ? courier : "mock",
  MOCK_COURIER_PROFILE: courier,
  ...(courier === "ozon"
    ? { OZON_CLIENT_ID: a.ozonClientId, OZON_API_KEY: a.ozonApiKey, OZON_BASE_URL: "https://api.ozonexpress.ma" }
    : { SENDIT_PUBLIC_KEY: a.senditPublicKey, SENDIT_SECRET_KEY: a.senditSecretKey }),
  …rest unchanged…
};
```

Header text (replace the Ozon sentence): `# Si les clés du transporteur ont été ignorées, DELIVERY_PROVIDER vaut "mock" au départ : passez-le à "ozon" ou "sendit" uniquement après avoir renseigné ses clés (OZON_CLIENT_ID/OZON_API_KEY ou SENDIT_PUBLIC_KEY/SENDIT_SECRET_KEY). Sendit : choisissez ensuite le district de ramassage dans CRM → Paramètres.`

Do not write `store.config.ts` changes (courier stays env-only).

### `.env.example` / `docker-compose.yml`

`.env.example`: keep Ozon block; add
```
# Transporteur : "mock", "ozon" ou "sendit" (valeur exacte). En mock, MOCK_COURIER_PROFILE imite "ozon" ou "sendit".
DELIVERY_PROVIDER="mock"
MOCK_COURIER_PROFILE="ozon"
SENDIT_PUBLIC_KEY=""
SENDIT_SECRET_KEY=""
COURIER_SUBMIT_INTERVAL_SEC="15"
COURIER_POLL_INTERVAL_MIN="30"
COURIER_TRACK_BATCH="25"
```
(Keep `OZON_SUBMIT_INTERVAL_SEC`/`OZON_POLL_INTERVAL_MIN`/`OZON_TRACK_BATCH` lines with a comment "anciens noms, toujours lus en repli".) Don't duplicate `DELIVERY_PROVIDER`.

`docker-compose.yml`: add `MOCK_COURIER_PROFILE: ${MOCK_COURIER_PROFILE:-ozon}`, `SENDIT_PUBLIC_KEY: ${SENDIT_PUBLIC_KEY:-}`, `SENDIT_SECRET_KEY: ${SENDIT_SECRET_KEY:-}`, `COURIER_SUBMIT_INTERVAL_SEC: ${COURIER_SUBMIT_INTERVAL_SEC:-}`, `COURIER_POLL_INTERVAL_MIN: ${COURIER_POLL_INTERVAL_MIN:-}`, `COURIER_TRACK_BATCH: ${COURIER_TRACK_BATCH:-}` and change the guard to `${DELIVERY_PROVIDER:?set mock, ozon or sendit}`. Empty `COURIER_*` falls back to `OZON_*` (task 01's helper skips blank values).

### Tests (`scripts/unit/new-store-env.test.mjs`)

- Ozon with creds → production `ozon`, local `mock`, `MOCK_COURIER_PROFILE=ozon`, no `SENDIT_*` keys.
- Sendit without keys → production `mock`, `MOCK_COURIER_PROFILE=sendit`; with keys → production `sendit`; no `OZON_*` keys.
- Missing `courier` → behaves as Ozon.
- Mirror check: `loadSource("@/lib/shipping/couriers")` (from `../test-source.mjs`) — names, labels and `requiredEnv` equal `WIZARD_COURIERS`.

## Acceptance Criteria

- [ ] Interactive wizard asks the courier and only that courier's keys.
- [ ] `--answers examples/new-store-answers.json` works; old answer files without `courier` still work.
- [ ] Env output matches the rules above; `.env.example`/compose updated.
- [ ] `npm run test:unit`, `npm run lint`, `npx tsc --noEmit` pass.
