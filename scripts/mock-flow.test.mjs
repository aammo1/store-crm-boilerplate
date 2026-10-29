import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "./test-source.mjs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-mock-flow-"));
process.env.DB_PATH = path.join(tempDir, "test.db");
process.env.UPLOAD_DIR = path.join(tempDir, "uploads");
process.env.DELIVERY_PROVIDER = "mock";
process.env.OZON_CLIENT_ID = "";
process.env.OZON_API_KEY = "";

// Any real HTTP call (e.g. to Ozon) fails the flow loudly.
const realFetch = globalThis.fetch;
const httpCalls = [];
globalThis.fetch = async (url) => { httpCalls.push(String(url)); throw new Error("network disabled in test"); };

const { getDb } = loadSource("@/lib/db");
import { createOrder } from "./fulfillment-fixtures.mjs";
const { confirmOrder } = loadSource("@/lib/services/confirmation");
const { openStock } = loadSource("@/lib/services/inventory");
const { createOrResumeBl } = loadSource("@/lib/services/delivery-notes");
const { handoffBl } = loadSource("@/lib/services/expeditions");
const { pollOnce } = loadSource("@/lib/services/tracking");
const { getProvider } = loadSource("@/lib/shipping");
const { createMockProvider } = loadSource("@/lib/shipping/mock");
const { syncCities } = loadSource("@/lib/shipping/city-sync");
const { ProviderError } = loadSource("@/lib/shipping/errors");
const { drainSubmissions } = loadSource("@/lib/workers/submission");
const { buildCreateParcelInput, buildSnapshotObject } = loadSource("@/lib/shipping/parcel-payload");
const { shipmentDescription } = loadSource("@/lib/order-item-label");
const { getCrmOrder } = loadSource("@/lib/services/orders");
const { ensureReturn, markReturnReceived } = loadSource("@/lib/services/returns");
const { receiveReturnLines } = loadSource("@/lib/services/inventory");
const db = getDb();
const actor = { id: "test-agent" };
const now = new Date().toISOString();

after(() => {
  globalThis.fetch = realFetch;
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

db.prepare(`INSERT INTO products (id, slug, name, category, price, created_at, updated_at)
  VALUES ('p', 'p', 'Chargeur test', 'accessoires', 300, ?, ?)`).run(now, now);
db.prepare("INSERT INTO variants (id, product_id, sku, label, options_json, options_key) VALUES ('v', 'p', 'v', 'Standard', '[]', '[]')").run();
openStock("v", 20, actor.id);

test("getProvider returns one shared mock and cities sync goes through it", async () => {
  assert.equal(getProvider(), getProvider());
  assert.equal(await syncCities(getProvider()), 5);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM cities").get().n, 5);
  assert.equal(httpCalls.length, 0);
});

test("confirmation → submission → BL → handoff → tracking runs on one mock without HTTP", async () => {
  const ids = [];
  for (const n of [1, 2]) {
    const id = `flow-${n}`;
    createOrder({ id, customerName: "Cliente", customerPhone: "+212612345678",
      items: [{ product_id: "p", variant_id: "v", sku: "v", name: "Chargeur test", variant_label: "Standard", options: [], quantity: 1, unit_price: 300, line_total: 300 }],
      upsellOffer: null, subtotal: 300, shipping: 29, total: 329 });
    ids.push(confirmOrder(id, { lines: [{ lineIndex: 0, variantId: "v" }], address: "12 rue test", cityId: 1 }, actor).submissionId);
  }

  await Promise.all([drainSubmissions(getProvider()), drainSubmissions(getProvider())]); // overlapping ticks are serialized
  const rows = db.prepare("SELECT id, status, tracking_number FROM courier_submissions ORDER BY id").all();
  assert.ok(rows.every((r) => r.status === "submitted" && r.tracking_number?.startsWith("OZEMOCK")), JSON.stringify(rows));
  assert.equal(new Set(rows.map((r) => r.tracking_number)).size, 2);

  const bl = await createOrResumeBl(ids, actor); // no explicit provider: shared mock
  assert.equal(bl.bl.status, "saved");
  assert.ok(bl.bl.ref.startsWith("BLMOCK"));
  assert.equal(handoffBl(bl.bl.id, actor.id).results.every((r) => r.ok), true);

  await pollOnce(); // shared mock knows the parcels it created
  const tracked = db.prepare("SELECT raw_status FROM courier_submissions WHERE id IN (?, ?)").all(...ids);
  assert.deepEqual(tracked.map((r) => r.raw_status), ["MOCK_CREATED", "MOCK_CREATED"]);

  assert.equal(httpCalls.length, 0);
});

test("mock numbers stay unique and trackable across a simulated restart", async () => {
  const code = db.prepare("SELECT tracking_number c FROM courier_submissions LIMIT 1").get().c;
  const restarted = createMockProvider(); // fresh in-memory state, like a new process
  const [seen] = await restarted.track([code]);
  assert.equal(seen.found, true);
  await new Promise((r) => setTimeout(r, 5)); // distinct boot id
  const input = { receiver: "x", codAmountMad: 1 };
  const a = (await restarted.createParcel(input)).trackingNumber;
  const b = (await createMockProvider().createParcel(input)).trackingNumber;
  assert.notEqual(a, b);
  assert.notEqual(a, code);
});

test("two-option and default snapshots survive catalog edits through mock shipment and archived return", async () => {
  const options = [{ name: "Contenance", value: "500 ml" }, { name: "Parfum", value: "Rose" }];
  db.prepare(`INSERT INTO products (id, slug, name, category, price, created_at, updated_at)
    VALUES ('serum', 'serum', 'Sérum original', 'soins', 300, ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO variants (id, product_id, sku, label, options_json, options_key)
    VALUES ('serum-rose', 'serum', 'SERUM-ROSE', '500 ml / Rose', ?, ?)`)
    .run(JSON.stringify(options), JSON.stringify([["contenance", "500 ml"], ["parfum", "rose"]]));
  openStock("serum-rose", 3, actor.id);
  const items = [
    { product_id: "serum", variant_id: "serum-rose", sku: "SERUM-ROSE", name: "Sérum original", variant_label: "500 ml / Rose", options, quantity: 2, unit_price: 300, line_total: 600 },
    { product_id: "p", variant_id: "v", sku: "v", name: "Chargeur test", variant_label: "Standard", options: [], quantity: 1, unit_price: 300, line_total: 300 },
  ];
  createOrder({ id: "generic-history", customerName: "Cliente", customerPhone: "+212612345678",
    items, upsellOffer: null, subtotal: 900, shipping: 0, total: 900 });
  const { submissionId } = confirmOrder("generic-history", { lines: items.map((item, lineIndex) => ({ lineIndex, variantId: item.variant_id })), address: "12 rue test", cityId: 1 }, actor);
  const frozen = db.prepare("SELECT payload_json FROM courier_submissions WHERE id = ?").get(submissionId).payload_json;
  assert.deepEqual(JSON.parse(frozen).items.map((item) => item.variant_id), ["serum-rose", "v"]);
  db.prepare("UPDATE products SET name = 'Nom modifié', active = 0 WHERE id = 'serum'").run();
  db.prepare("UPDATE variants SET label = 'Nouveau libellé', active = 0 WHERE id = 'serum-rose'").run();
  // Even later order changes must not replace the durable queued payload.
  const changed = { ...getCrmOrder("generic-history"), items: [] };
  assert.equal(buildCreateParcelInput({ payload: frozen }, changed).description,
    "Sérum original (500 ml / Rose) ×2 ; Chargeur test (Standard) ×1");
  const provider = getProvider();
  const calls = [];
  await drainSubmissions({ createParcel: async (input) => { calls.push(input); return provider.createParcel(input); } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].description, buildCreateParcelInput({ payload: frozen }, changed).description);
  const bl = await createOrResumeBl([submissionId], actor);
  assert.equal(handoffBl(bl.bl.id, actor.id).results.every((result) => result.ok), true);
  await pollOnce();
  const ret = ensureReturn(submissionId, "Retour manuel après expédition");
  markReturnReceived(ret.id, actor.id);
  receiveReturnLines(submissionId, "generic-history", [
    { variantId: "serum-rose", sellableQty: 1, damagedQty: 1 },
    { variantId: "v", sellableQty: 1, damagedQty: 0 },
  ], actor.id, ret.id);
  assert.deepEqual(db.prepare("SELECT variant_id, dispatched_qty, sellable_qty, damaged_qty FROM return_lines WHERE return_id = ? ORDER BY variant_id").all(ret.id), [
    { variant_id: "serum-rose", dispatched_qty: 2, sellable_qty: 1, damaged_qty: 1 },
    { variant_id: "v", dispatched_qty: 1, sellable_qty: 1, damaged_qty: 0 },
  ]);
  assert.deepEqual(db.prepare("SELECT physical, reserved, quarantine FROM stock_balances WHERE variant_id = 'serum-rose' AND location = 'MAIN'").get(), { physical: 3, reserved: 0, quarantine: 1 });
  assert.equal(httpCalls.length, 0);
});

test("shipment descriptions keep string options, accepted bonus quantities and bounded Unicode", () => {
  const base = { name: "Sérum", variant_label: "", options: [{ name: "Contenance", value: "500 ml" }], quantity: 2 };
  assert.equal(shipmentDescription([base]), "Sérum (Contenance : 500 ml) ×2");
  assert.equal(shipmentDescription([]), "Articles");
  const long = shipmentDescription([{ ...base, name: "🧴".repeat(300) }]);
  assert.equal(Array.from(long).length, 255);
  assert.equal(long.includes("\uFFFD"), false);
  const item = { product_id: "p", variant_id: "v", sku: "v", name: "Chargeur test", variant_label: "Standard", options: [], quantity: 1, unit_price: 300, line_total: 300 };
  const order = { id: "payload-only", customerName: "Cliente", customerPhone: "+212612345678",
    address: "12 rue test", cityId: 1, cityName: "Casablanca", total: 479,
    items: [item], upsellStatus: "accepted", upsellItems: [{ ...item, name: "Article bonus", unit_price: 150, line_total: 150 }] };
  const snapshot = buildSnapshotObject(order);
  assert.deepEqual(snapshot.items.map((line) => [line.variant_id, line.quantity]), [["v", 1], ["v", 1]]);
  assert.equal(buildCreateParcelInput({ payload: JSON.stringify(snapshot) }, order).description,
    "Chargeur test (Standard) ×1 ; Article bonus (Standard) ×1");
  assert.equal(buildSnapshotObject({ ...order, upsellStatus: "declined" }).items.length, 1);
});

test("submission worker never strands a claimed job and leaves jobs queued while unconfigured", async () => {
  const order = (id) => {
    createOrder({ id, customerName: "Cliente", customerPhone: "+212612345678",
      items: [{ product_id: "p", variant_id: "v", sku: "v", name: "Chargeur test", variant_label: "Standard", options: [], quantity: 1, unit_price: 300, line_total: 300 }],
      upsellOffer: null, subtotal: 300, shipping: 29, total: 329 });
    return confirmOrder(id, { lines: [{ lineIndex: 0, variantId: "v" }], address: "12 rue test", cityId: 1 }, actor).submissionId;
  };
  const statusOf = (id) => db.prepare("SELECT status, last_error, next_retry_at FROM courier_submissions WHERE id = ?").get(id);

  // Unconfigured courier: nothing is consumed, nothing is created.
  const waiting = order("worker-unconfigured");
  let created = 0;
  await drainSubmissions({ isConfigured: () => false, createParcel: async () => { created++; throw new Error("unreachable"); } });
  assert.equal(created, 0);
  assert.equal(statusOf(waiting).status, "queued");

  // Database failure before any courier request: safe delayed requeue, not stuck 'submitting'.
  db.exec("ALTER TABLE order_contacts RENAME TO order_contacts_hidden");
  try {
    await drainSubmissions({ createParcel: async () => { created++; return { trackingNumber: "X", raw: {} }; } });
  } finally {
    db.exec("ALTER TABLE order_contacts_hidden RENAME TO order_contacts");
  }
  assert.equal(created, 0);
  const requeued = statusOf(waiting);
  assert.equal(requeued.status, "queued");
  assert.match(requeued.last_error, /avant envoi/);
  assert.ok(requeued.next_retry_at > new Date().toISOString());

  // A row left 'submitting' long ago (crash between claim and settle) goes to manual review on the next tick.
  db.prepare("UPDATE courier_submissions SET status = 'submitting', updated_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 10 * 60_000).toISOString(), waiting);
  await drainSubmissions({ createParcel: async () => { created++; return { trackingNumber: "X", raw: {} }; } });
  assert.equal(statusOf(waiting).status, "needs_review");
  assert.equal(created, 0);
  assert.equal(httpCalls.length, 0);
});

test("MOCK_COURIER_PROFILE=sendit produces Sendit codes, capabilities, cities and pre-fills tariffs", async () => {
  const prevProfile = process.env.MOCK_COURIER_PROFILE;
  process.env.MOCK_COURIER_PROFILE = "sendit";
  try {
    const provider = getProvider();
    assert.equal(provider.profile, "sendit");
    assert.equal(provider.capabilities.deliveryNotes, false);
    assert.equal(provider.capabilities.labels, true);
    assert.equal(provider.capabilities.parcelLookup, true);

    // Pre-existing tariff for Casablanca (city 1)
    db.prepare(`INSERT OR REPLACE INTO city_tariffs (city_id, courier_cost, override_ignores_free_threshold, updated_by, updated_at)
      VALUES (1, 99, 0, NULL, ?)`).run(now);

    // syncCities writes provider='mock', arabic_name, is_pickup=1 for Casablanca, and pre-fills tariffs for others
    const count = await syncCities(provider);
    assert.equal(count, 5);

    const casa = db.prepare("SELECT * FROM cities WHERE id = 1").get();
    assert.equal(casa.provider, "mock");
    assert.equal(casa.arabic_name, "الدار البيضاء");
    assert.equal(casa.is_pickup, 1);

    const rabat = db.prepare("SELECT * FROM cities WHERE id = 2").get();
    assert.equal(rabat.arabic_name, "الرباط");
    assert.equal(rabat.is_pickup, 0);

    // Existing tariff for Casablanca kept unchanged at 99
    const casaTariff = db.prepare("SELECT courier_cost FROM city_tariffs WHERE city_id = 1").get();
    assert.equal(casaTariff.courier_cost, 99);

    // Missing tariff for Rabat pre-filled from mock's priceMad (35)
    const rabatTariff = db.prepare("SELECT courier_cost FROM city_tariffs WHERE city_id = 2").get();
    assert.equal(rabatTariff.courier_cost, 35);

    // buildCreateParcelInput returns reference starting with store slug and phoneLocal 06...
    const item = { product_id: "p", variant_id: "v", sku: "v", name: "Chargeur test", variant_label: "Standard", options: [], quantity: 1, unit_price: 300, line_total: 300 };
    const orderData = {
      id: "sendit-ord-1",
      customerName: "Ahmed Alami",
      customerPhone: "+212612345678",
      address: "123 Bd Zerktouni",
      cityId: 1,
      cityName: "Casablanca",
      total: 300,
      items: [item],
      upsellStatus: null,
      upsellItems: [],
    };
    const input = buildCreateParcelInput({ payload: null }, orderData);
    assert.ok(input.reference.startsWith("ma-boutique-sendit-ord-1"), input.reference);
    assert.equal(input.phoneLocal, "0612345678");

    // createParcel produces SNDMOCK code
    const res = await provider.createParcel(input);
    assert.ok(res.trackingNumber.startsWith("SNDMOCK"), res.trackingNumber);

    // BL methods reject with ProviderError kind permanent
    await assert.rejects(
      () => provider.createDeliveryNote(),
      (err) => err instanceof ProviderError && err.kind === "permanent",
    );
    await assert.rejects(
      () => provider.addParcelsToDeliveryNote("BL1", [res.trackingNumber]),
      (err) => err instanceof ProviderError && err.kind === "permanent",
    );
    await assert.rejects(
      () => provider.saveDeliveryNote("BL1"),
      (err) => err instanceof ProviderError && err.kind === "permanent",
    );
    assert.equal(provider.deliveryNotePdfUrl("BL1", "standard"), "mock://pdf/unsupported");

    // Reference lookup
    const lookup = await provider.findParcelByReference(input.reference, input.phoneLocal);
    assert.equal(lookup.complete, true);
    assert.equal(lookup.parcel?.trackingNumber, res.trackingNumber);
    assert.equal(lookup.parcel?.rawStatus, "PENDING");

    // Labels PDF
    const labels = await provider.getLabelsPdf([res.trackingNumber], "10x10");
    assert.equal(labels.url, "mock://labels/10x10/1");
  } finally {
    if (prevProfile === undefined) {
      delete process.env.MOCK_COURIER_PROFILE;
    } else {
      process.env.MOCK_COURIER_PROFILE = prevProfile;
    }
  }
});

