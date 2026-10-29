# Requirements: Sendit Courier

## Summary

Every store copy generated from this boilerplate ships parcels through exactly one Moroccan courier. Today the only real courier is Ozon Express (`src/lib/shipping/ozon.ts`), and several parts of the CRM assume Ozon: the parcel input shape, the mandatory BL (bon de livraison) step before handoff, the "portail Ozon" copy, the `OZON_*` worker knobs and the wizard.

This feature adds **Sendit** (sendit.ma) as a second courier, chosen per store in `npm run new-store` ("Transporteur : ozon / sendit"). It first turns the shipping layer into a small **courier registry with capabilities** (Ozon = delivery notes/BL; Sendit = 10×10 labels, no BL, parcel lookup by reference), so the CRM adapts to the active courier and a third courier (Amana, Cathedis, Forcelog…) later costs one adapter file plus one registry entry. Ozon stores must behave exactly as today.

The outcome: a new niche store can go live on Sendit with automatic parcel creation, tracking with automatic delivered/refused outcomes, label printing, explicit handoff, a read-only "Chercher chez Sendit" helper for uncertain creations, Sendit district prices pre-filling tariffs, Arabic city search, and a courier health card — all verified offline with mocked HTTP.

This spec supersedes `specs/whatsapp-assistant/tasks/task-20-courier-provider-groundwork.md` and `task-27-sendit-adapter.md` (marked superseded there). The provider columns originally planned in WhatsApp migration 028 now live in this spec's migration `029_courier_providers.sql`.

## Decisions (from planning)

1. **One courier per store copy.** No routing between couriers inside a store. Switching courier on a live store is a deliberate manual review (city ids, tariffs, open parcels), documented, not automated.
2. **Selection stays in env.** `DELIVERY_PROVIDER` = exact `mock` → mock, exact `sendit` → Sendit, anything else → Ozon (keeps the AGENTS.md rule and every existing store working).
3. **Mock courier profiles.** `MOCK_COURIER_PROFILE` = exact `sendit` → mock behaves like Sendit (no BL, labels, `SNDMOCK…` codes, Sendit statuses, reference lookup); anything else → Ozon-like mock (unchanged behaviour, `OZEMOCK…`/`BLMOCK…`). The wizard writes it so local dev of a Sendit store shows Sendit screens.
4. **Courier registry** in `src/lib/shipping/couriers.ts` (browser-safe metadata: name, French label, capabilities, required/secret env names). Env validation, wizard (mirrored list + test), health and UI read it.
5. **Capabilities**: `deliveryNotes` (Ozon BL flow), `labels` (+ formats), `parcelLookup`, `bulkTracking`, `pickupDistrict`. Expéditions and handoff adapt: Ozon unchanged (BL → print → handoff); Sendit = select parcels → print 10×10 labels → "Remis au livreur" (explicit agent action, recorded via existing `recordDispatch`).
6. **Neutral parcel request** (`ParcelRequest`) built from the frozen payload snapshot; each adapter maps it to its own wire format. Courier reference = `"<store-slug>-<orderId>"`, frozen into the snapshot, so several stores sharing one Sendit account never collide.
7. **Sendit statuses mapped from the vendor-published list** (official Sendit WooCommerce plugin, `GET /all-status-deliveries`) — this is not guessing. Ozon's map stays empty. Two new normalized statuses: `awaiting_pickup` and `delivery_issue` (UNREACHABLE/POSTPONED/NEW_DESTINATION → CRM alert, no automatic action).
8. **Polling first.** Sendit has no bulk tracking: one `GET /deliveries/{code}` per parcel, max 3 concurrent, back off on 429, same 30-minute interval. Webhook is deferred (task 18).
9. **Same submission policy as Ozon**: uncertain create (timeout, network, 5xx, 200 without code) → `needs_review`, never re-created automatically. Sendit HTTP 429 on create = nothing created → requeue with delay (new `throttled` error kind). The review form gets a read-only "Chercher chez Sendit" (search by phone, exact reference match); the agent still decides.
10. **Sendit settings in CRM → Paramètres** (not wizard, not env): pickup district (required before any parcel is sent), "Autoriser l'ouverture" (default yes), "Autoriser l'essayage" (default no). Stored in `app_state` key `courier_settings`.
11. **Tariff pre-fill**: Sendit district `price` fills `city_tariffs.courier_cost` only for cities without a tariff row; never overwrites.
12. **Generic worker knobs** `COURIER_SUBMIT_INTERVAL_SEC`, `COURIER_POLL_INTERVAL_MIN`, `COURIER_TRACK_BATCH`, with `OZON_*` fallbacks. `toOzonPhone` → `toLocalPhone`. Copy says "portail {transporteur}".
13. **COD import on a shared account**: lines whose tracking number is unknown in this store are labelled "Colis inconnu dans cette boutique (autre boutique du même compte ?)" and ignored, not treated as errors.
14. **Courier health card** in the CRM dashboard and in `/api/health` details (no secrets): courier, live/mock, configured, readiness reasons, cities count, pickup set, last city/tracking sync, blocked jobs; admin "Tester la connexion".
15. **Arabic + alias city search** in the city picker; **address required** (≥ 5 chars) before confirmation for every courier.
16. **Shared courier contract tests** with fake HTTP for Ozon, Sendit and the mock (explicitly requested).
17. **`npm run sendit:verify -- --live --yes`**: read-only live check (login, districts, optional one parcel code), run only by the owner.
18. Deferred tasks written now: Sendit webhook (18) and Sendit parcel edit via `PUT` (19).

## Sendit API reference (from the official open-source WooCommerce plugin `sendit-ma-integration`)

Base `https://app.sendit.ma/api/v1`. JSON everywhere.

| Need | Call | Notes |
|---|---|---|
| Login | `POST /login` body `{"public_key","secret_key"}` → `data.token` | Bearer token, cache ≤ 55 min, keyed to the account. On 401/403 with a cached token: drop it, log in again, retry the call **once** (an auth-refused request created nothing). |
| Districts | `GET /districts?page=N` (Bearer) → `{data:[…], last_page}` | Each: `id`, `name`, `arabic_name` (may contain tatweel U+0640, sometimes Latin — keep only if it contains Arabic letters), `ville`, `price`, `pickup_district` (1/0). Pickup-capable = `pickup_district == 1` OR `ville == "Casablanca"`. Cap at 50 pages. 500+ districts. |
| Create parcel | `POST /deliveries` body `{reference, name, amount, phone, address, pickup_district_id, district_id, comment, allow_try (0/1), allow_open (0/1), products}` | Success = HTTP 200 + `success: true` + string `data.code`. 200 with `success:false` = refused (permanent). 429 = throttled, nothing created (`Retry-After`). 0/5xx/200-without-code = **uncertain**. Other 4xx = permanent. Error text = `message` + flattened `errors`, strip tags, ≤ 500 chars. |
| Get parcel | `GET /deliveries/{code}` → `data` | `data.status` is a string or `{code}`; uppercase + trim. |
| Search | `GET /deliveries?querystring=<phone>&page=N` | Rows = integer keys of `data` (or `data.data`) that are arrays; other keys (e.g. `packaging_fee`) are noise. Match **exact** `reference`; ignore dead statuses `CANCELED, CANCELLED, REJECTED, RETURNED, DELETED`. Max 3 pages; more → inconclusive. |
| Labels | `POST /deliveries/getlabels` body `{"codesToPrint":"C1,C2","printFormat":1}` → PDF URL | URL may be at `data.fileUrl`, `data.file_url`, `data.url`, `data.pdf`, `data.link`, `data.path`, `data` (string), or root `fileUrl/file_url/url`. Accept only `https://app.sendit.ma/...`. |
| Update parcel | `PUT /deliveries/{code}` | Deferred (task 19). |
| Status list | `GET /all-status-deliveries` | Reference only. |

Phone format expected: local `0[5-7]XXXXXXXX` (same as Ozon's `06…`). Amount in MAD. Products string: `Nom (Option: Valeur, …) xQté` joined by ` | `, with `|`→`/`, `;`→`,`, `:`→` -` removed from labels.

**Sendit status codes → normalized** (aliases first: `TO_PICKUP→TOPICKUP`, `PICKED_UP→PICKEDUP`, `CANCELLED→CANCELED`, `IN_TRANSIT→TRANSIT`, `RETOUR`/`RETURN→RETURNED`):

| Sendit | Label | Normalized |
|---|---|---|
| PENDING, TO_PREPARE, TOPICKUP | En attente / À préparer / Ramassage en cours | `awaiting_pickup` |
| PICKEDUP, TRANSIT | Ramassé / En transit | `in_transit` |
| WAREHOUSE, DISTRIBUTED | Entrepôt / Distribué | `at_facility` |
| DELIVERING | En cours de livraison | `out_for_delivery` |
| UNREACHABLE, POSTPONED, NEW_DESTINATION | Injoignable / Reporté / À changer | `delivery_issue` |
| DELIVERED | Livré | `delivered` |
| REJECTED | Refusé | `refused` |
| RETURNED | Retourné | `return_in_transit` |
| CANCELED | Annulé | `cancelled` |
| anything else | — | `unknown` |

## Goals

- A new store chooses Ozon or Sendit in the wizard (and via `--answers` for `ai-memory-boilerplate/scripts/new-niche.py`).
- Sendit stores create, track, label and hand off parcels with the same safety guarantees as Ozon.
- Ozon stores and all existing tests behave exactly as before.
- Adding a third courier later = one adapter + one registry entry (+ wizard mirror).

## Non-Goals

- Multiple couriers in one store, or routing by city.
- Automatic migration of a live store from Ozon to Sendit.
- Sendit webhook and parcel editing (written as deferred tasks 18–19, not implemented now).
- Sendit pickup requests/stock (fulfilment by Sendit) — the CRM always ships from the merchant's pickup district.
- Courier credentials in the CRM UI or DB (env-only, as today).
- Any change to the storefront, checkout or pricing rules.
- Guessing Ozon statuses.

## Acceptance Criteria

- [ ] `DELIVERY_PROVIDER=sendit` with `SENDIT_PUBLIC_KEY`/`SENDIT_SECRET_KEY` boots in production; missing keys fail boot with a variable-name-only error.
- [ ] With `DELIVERY_PROVIDER=mock` + `MOCK_COURIER_PROFILE=sendit`, the Expéditions page shows the labels flow (no BL), handoff works without a BL, codes start `SNDMOCK`.
- [ ] With `DELIVERY_PROVIDER=mock` and no profile, every existing suite (`test:unit`, `test:crm`, `test:catalog-agent`, `test:assistant`, `test:security`) passes unchanged in behaviour.
- [ ] Fake-HTTP contract tests prove: Sendit create success/permanent/throttled/uncertain classification, one token refresh on 401, district pagination + pickup + Arabic names, labels URL host check, tracking parse, secrets never in error text; same suite covers Ozon and the mock.
- [ ] Sendit DELIVERED/REJECTED trigger the existing delivered/refused side effects; UNREACHABLE shows as "Colis à problème" on the dashboard; Ozon map remains empty.
- [ ] A Sendit job is never sent while the pickup district is unset; the health card says why.
- [ ] "Chercher chez Sendit" never changes state; the agent still submits the resolution.
- [ ] COD import of a statement containing other stores' parcels imports this store's lines and lists the others as ignored.
- [ ] Wizard offers the courier choice and writes the right env; `npm run lint`, `npx tsc --noEmit`, `DELIVERY_PROVIDER=mock npm run build` and `npm run perf-budget` pass.

## Assumptions

- Sendit's public API behaves as the official plugin (v2.2.x) uses it. Live confirmation happens through `sendit:verify` by the owner (see action-required.md).
- Sendit district ids are only meaningful for Sendit; a store uses one courier, so `cities.id` stays the courier's id (no composite key).
- Several of the owner's stores may share one Sendit account.
- A Sendit token lives ~1 hour.

## Technical Constraints

- Follow `AGENTS.md` invariants: parcel creation only by the submission worker, tracking only by the poller, no blind retry, unknown statuses never change stock, build never opens SQLite, storefront bundles untouched, CRM copy French, integer MAD, Africa/Casablanca.
- Never edit applied migrations; this spec owns `migrations/029_courier_providers.sql` (WhatsApp keeps 028; the runner applies unapplied files in sorted order, so 029 may ship before 028).
- Secrets only in runtime env; never in URLs, logs, browser JSON or props. The Sendit token is memory-only (never DB).
- Tests: `DELIVERY_PROVIDER=mock`, temp `DB_PATH` (`fs.mkdtempSync`), ephemeral secrets, stubbed `globalThis.fetch`, `NODE_OPTIONS=--import=$PWD/scripts/block-external-network.mjs`. New unit tests in `scripts/unit/<name>.test.mjs` loading TS via `import { loadSource } from "../test-source.mjs"`.
- Finish every task with `npm run lint` and `npx tsc --noEmit` plus the suites it touches. Do not commit.
