import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "../test-source.mjs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "courier-neutral-"));
process.env.DELIVERY_PROVIDER = "mock";
process.env.DB_PATH = path.join(tempDir, "test.db");

after(() => {
  const { getDb } = loadSource("@/lib/db");
  try { getDb().close(); } catch {}
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const { courierLabel, courierPortal } = loadSource("@/lib/shipping/courier-copy");
const { ProviderError } = loadSource("@/lib/shipping/errors");
const { submissionIntervalMs, drainSubmissions } = loadSource("@/lib/workers/submission");
const { pollIntervalMin, trackBatchSize } = loadSource("@/lib/services/tracking");
const {
  normalizeStatus,
  TRACKING_STATUSES,
  OZON_STATUS_MAP,
  SENDIT_STATUS_MAP,
  STATUS_MAPS,
  SENDIT_STATUS_LABELS,
} = loadSource("@/lib/shipping/status-map");

test("courierLabel and courierPortal adapt to courierProfile", () => {
  const origProvider = process.env.DELIVERY_PROVIDER;
  const origProfile = process.env.MOCK_COURIER_PROFILE;
  try {
    process.env.DELIVERY_PROVIDER = "ozon";
    delete process.env.MOCK_COURIER_PROFILE;
    assert.equal(courierLabel(), "Ozon Express");
    assert.equal(courierPortal(), "le portail Ozon Express");

    process.env.DELIVERY_PROVIDER = "sendit";
    assert.equal(courierLabel(), "Sendit");
    assert.equal(courierPortal(), "le portail Sendit");

    process.env.DELIVERY_PROVIDER = "mock";
    process.env.MOCK_COURIER_PROFILE = "sendit";
    assert.equal(courierLabel(), "Sendit");
    assert.equal(courierPortal(), "le portail Sendit");

    process.env.MOCK_COURIER_PROFILE = "ozon";
    assert.equal(courierLabel(), "Ozon Express");
    assert.equal(courierPortal(), "le portail Ozon Express");
  } finally {
    if (origProvider !== undefined) process.env.DELIVERY_PROVIDER = origProvider;
    else delete process.env.DELIVERY_PROVIDER;
    if (origProfile !== undefined) process.env.MOCK_COURIER_PROFILE = origProfile;
    else delete process.env.MOCK_COURIER_PROFILE;
  }
});

test("ProviderError supports throttled kind and retryAfterSec", () => {
  const err = new ProviderError("throttled", "Trop de requêtes", { retryAfterSec: 45 });
  assert.equal(err.kind, "throttled");
  assert.equal(err.message, "Trop de requêtes");
  assert.equal(err.retryAfterSec, 45);
});

test("worker knobs prefer COURIER_* over OZON_* and respect floors/defaults", () => {
  const origCourierSubmit = process.env.COURIER_SUBMIT_INTERVAL_SEC;
  const origOzonSubmit = process.env.OZON_SUBMIT_INTERVAL_SEC;
  const origCourierPoll = process.env.COURIER_POLL_INTERVAL_MIN;
  const origOzonPoll = process.env.OZON_POLL_INTERVAL_MIN;
  const origCourierBatch = process.env.COURIER_TRACK_BATCH;
  const origOzonBatch = process.env.OZON_TRACK_BATCH;

  try {
    delete process.env.COURIER_SUBMIT_INTERVAL_SEC;
    delete process.env.OZON_SUBMIT_INTERVAL_SEC;
    assert.equal(submissionIntervalMs(), 15_000);

    process.env.OZON_SUBMIT_INTERVAL_SEC = "20";
    assert.equal(submissionIntervalMs(), 20_000);

    process.env.COURIER_SUBMIT_INTERVAL_SEC = "10";
    assert.equal(submissionIntervalMs(), 10_000);

    process.env.COURIER_SUBMIT_INTERVAL_SEC = "2"; // Below 5s floor
    assert.equal(submissionIntervalMs(), 5_000);

    delete process.env.COURIER_POLL_INTERVAL_MIN;
    delete process.env.OZON_POLL_INTERVAL_MIN;
    assert.equal(pollIntervalMin(), 30);

    process.env.OZON_POLL_INTERVAL_MIN = "45";
    assert.equal(pollIntervalMin(), 45);

    process.env.COURIER_POLL_INTERVAL_MIN = "15";
    assert.equal(pollIntervalMin(), 15);

    process.env.COURIER_POLL_INTERVAL_MIN = "2"; // Below 5 min floor
    assert.equal(pollIntervalMin(), 5);

    delete process.env.COURIER_TRACK_BATCH;
    delete process.env.OZON_TRACK_BATCH;
    assert.equal(trackBatchSize(), 25);

    process.env.OZON_TRACK_BATCH = "50";
    assert.equal(trackBatchSize(), 50);

    process.env.COURIER_TRACK_BATCH = "10";
    assert.equal(trackBatchSize(), 10);
  } finally {
    if (origCourierSubmit !== undefined) process.env.COURIER_SUBMIT_INTERVAL_SEC = origCourierSubmit;
    else delete process.env.COURIER_SUBMIT_INTERVAL_SEC;
    if (origOzonSubmit !== undefined) process.env.OZON_SUBMIT_INTERVAL_SEC = origOzonSubmit;
    else delete process.env.OZON_SUBMIT_INTERVAL_SEC;
    if (origCourierPoll !== undefined) process.env.COURIER_POLL_INTERVAL_MIN = origCourierPoll;
    else delete process.env.COURIER_POLL_INTERVAL_MIN;
    if (origOzonPoll !== undefined) process.env.OZON_POLL_INTERVAL_MIN = origOzonPoll;
    else delete process.env.OZON_POLL_INTERVAL_MIN;
    if (origCourierBatch !== undefined) process.env.COURIER_TRACK_BATCH = origCourierBatch;
    else delete process.env.COURIER_TRACK_BATCH;
    if (origOzonBatch !== undefined) process.env.OZON_TRACK_BATCH = origOzonBatch;
    else delete process.env.OZON_TRACK_BATCH;
  }
});

test("submission worker requeues on throttled error instead of needs_review", async () => {
  const { getDb } = loadSource("@/lib/db");
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(`INSERT INTO products (id, slug, name, category, price, created_at, updated_at)
    VALUES ('prod-1', 'prod-1', 'Test Product', 'cat', 100, ?, ?)`).run(now, now);
  db.prepare("INSERT INTO variants (id, product_id, sku, label, options_json, options_key) VALUES ('var-1', 'prod-1', 'SKU-1', 'Std', '[]', '[]')").run();
  db.prepare("INSERT INTO cities (id, name, updated_at, provider) VALUES (1, 'Casablanca', ?, 'mock')").run(now);

  const { createOrder } = await import("../fulfillment-fixtures.mjs");
  const { confirmOrder } = loadSource("@/lib/services/confirmation");
  const { openStock } = loadSource("@/lib/services/inventory");

  openStock("var-1", 10, "admin");

  createOrder({
    id: "ord-throttled",
    customerName: "Client Throttled",
    customerPhone: "+212612345678",
    items: [{
      product_id: "prod-1",
      variant_id: "var-1",
      sku: "SKU-1",
      name: "Test Product",
      variant_label: "Std",
      options: [],
      quantity: 1,
      unit_price: 100,
      line_total: 100,
    }],
    upsellOffer: null,
    subtotal: 100,
    shipping: 20,
    total: 120,
  });

  const { submissionId } = confirmOrder(
    "ord-throttled",
    { lines: [{ lineIndex: 0, variantId: "var-1" }], address: "123 Rue Principale", cityId: 1 },
    { id: "agent-1" },
  );

  const mockProvider = {
    name: "mock",
    profile: "sendit",
    capabilities: { deliveryNotes: false, labels: true, labelFormats: [], parcelLookup: true, bulkTracking: false, pickupDistrict: true },
    isConfigured: () => true,
    async createParcel() {
      throw new ProviderError("throttled", "Sendit 429: Trop de requêtes", { retryAfterSec: 120 });
    },
  };

  const before = Date.now();
  await drainSubmissions(mockProvider);

  const row = db.prepare("SELECT * FROM courier_submissions WHERE id = ?").get(submissionId);
  assert.equal(row.status, "queued");
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /Transporteur saturé ou injoignable \(rien créé\) — nouvel essai planifié : Sendit 429/);
  const retryAt = new Date(row.next_retry_at).getTime();
  assert.ok(retryAt >= before + 119_000 && retryAt <= before + 125_000, `next_retry_at ${row.next_retry_at} should be ~120s in future`);
});

test("status-map exports per-courier maps, labels, aliases, and normalizes correctly", () => {
  // Vocabulary contains all 10 statuses
  assert.equal(TRACKING_STATUSES.length, 10);
  assert.ok(TRACKING_STATUSES.includes("awaiting_pickup"));
  assert.ok(TRACKING_STATUSES.includes("delivery_issue"));

  // Ozon map empty by default
  assert.deepEqual(Object.keys(OZON_STATUS_MAP), []);
  assert.equal(STATUS_MAPS.ozon, OZON_STATUS_MAP);
  assert.equal(STATUS_MAPS.sendit, SENDIT_STATUS_MAP);

  // Sendit status map
  assert.equal(SENDIT_STATUS_MAP.PENDING, "awaiting_pickup");
  assert.equal(SENDIT_STATUS_MAP.TO_PREPARE, "awaiting_pickup");
  assert.equal(SENDIT_STATUS_MAP.TOPICKUP, "awaiting_pickup");
  assert.equal(SENDIT_STATUS_MAP.PICKEDUP, "in_transit");
  assert.equal(SENDIT_STATUS_MAP.TRANSIT, "in_transit");
  assert.equal(SENDIT_STATUS_MAP.WAREHOUSE, "at_facility");
  assert.equal(SENDIT_STATUS_MAP.DISTRIBUTED, "at_facility");
  assert.equal(SENDIT_STATUS_MAP.DELIVERING, "out_for_delivery");
  assert.equal(SENDIT_STATUS_MAP.UNREACHABLE, "delivery_issue");
  assert.equal(SENDIT_STATUS_MAP.POSTPONED, "delivery_issue");
  assert.equal(SENDIT_STATUS_MAP.NEW_DESTINATION, "delivery_issue");
  assert.equal(SENDIT_STATUS_MAP.DELIVERED, "delivered");
  assert.equal(SENDIT_STATUS_MAP.REJECTED, "refused");
  assert.equal(SENDIT_STATUS_MAP.RETURNED, "return_in_transit");
  assert.equal(SENDIT_STATUS_MAP.CANCELED, "cancelled");

  // Sendit labels
  assert.equal(SENDIT_STATUS_LABELS.PENDING, "En attente");
  assert.equal(SENDIT_STATUS_LABELS.TO_PREPARE, "À préparer");
  assert.equal(SENDIT_STATUS_LABELS.NEW_DESTINATION, "À changer");
  assert.equal(SENDIT_STATUS_LABELS.TOPICKUP, "Ramassage en cours");
  assert.equal(SENDIT_STATUS_LABELS.PICKEDUP, "Ramassé");
  assert.equal(SENDIT_STATUS_LABELS.WAREHOUSE, "Entrepôt");
  assert.equal(SENDIT_STATUS_LABELS.TRANSIT, "En transit");
  assert.equal(SENDIT_STATUS_LABELS.DISTRIBUTED, "Distribué");
  assert.equal(SENDIT_STATUS_LABELS.UNREACHABLE, "Injoignable");
  assert.equal(SENDIT_STATUS_LABELS.POSTPONED, "Reporté");
  assert.equal(SENDIT_STATUS_LABELS.DELIVERING, "En cours de livraison");
  assert.equal(SENDIT_STATUS_LABELS.DELIVERED, "Livré");
  assert.equal(SENDIT_STATUS_LABELS.CANCELED, "Annulé");
  assert.equal(SENDIT_STATUS_LABELS.REJECTED, "Refusé");
  assert.equal(SENDIT_STATUS_LABELS.RETURNED, "Retourné");

  // Sendit aliases & case/whitespace handling
  assert.equal(normalizeStatus("to_pickup", "sendit"), "awaiting_pickup");
  assert.equal(normalizeStatus("  PICKED_UP  ", "sendit"), "in_transit");
  assert.equal(normalizeStatus("cancelled", "sendit"), "cancelled");
  assert.equal(normalizeStatus("in_transit", "sendit"), "in_transit");
  assert.equal(normalizeStatus("retour", "sendit"), "return_in_transit");
  assert.equal(normalizeStatus("return", "sendit"), "return_in_transit");

  // Null / empty / unknown
  assert.equal(normalizeStatus(null, "sendit"), "unknown");
  assert.equal(normalizeStatus("", "sendit"), "unknown");
  assert.equal(normalizeStatus("FOOBAR", "sendit"), "unknown");
  assert.equal(normalizeStatus(null, "ozon"), "unknown");
  assert.equal(normalizeStatus("DELIVERED", "ozon"), "unknown"); // Ozon map is empty
});

test("city scoping, address length guard, and listCities with arabicName", async () => {
  const { getDb } = loadSource("@/lib/db");
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(`INSERT INTO products (id, slug, name, category, price, active, created_at, updated_at)
    VALUES ('p-scope', 'p-scope', 'Product Scope', 'cat', 100, 1, ?, ?)`).run(now, now);
  db.prepare("INSERT INTO variants (id, product_id, sku, label, options_json, options_key, active) VALUES ('v-scope', 'p-scope', 'SKU-S', 'Std', '[]', '[]', 1)").run();

  // Insert cities with IDs 10, 20, 30 for mock, ozon, and sendit
  db.prepare("INSERT INTO cities (id, name, updated_at, provider, arabic_name) VALUES (10, 'Casablanca-Scope', ?, 'mock', 'الدار البيضاء')").run(now);
  db.prepare("INSERT INTO cities (id, name, updated_at, provider, arabic_name) VALUES (20, 'Rabat-Scope', ?, 'ozon', NULL)").run(now);
  db.prepare("INSERT INTO cities (id, name, updated_at, provider, arabic_name) VALUES (30, 'Tanger-Scope', ?, 'sendit', 'طنجة')").run(now);

  const { listCities } = loadSource("@/lib/services/orders");
  const { createOrder } = await import("../fulfillment-fixtures.mjs");
  const { confirmOrder, ConfirmationError } = loadSource("@/lib/services/confirmation");
  const { createManualOrder, ManualOrderError } = loadSource("@/lib/services/manual-orders");
  const { openStock } = loadSource("@/lib/services/inventory");

  openStock("v-scope", 10, "admin");

  // With DELIVERY_PROVIDER=mock (default in tests), listCities returns only mock cities (1 from previous test, 10 from this test)
  const mockCities = listCities();
  assert.ok(mockCities.some((c) => c.id === 10 && c.arabicName === "الدار البيضاء"));
  assert.ok(!mockCities.some((c) => c.id === 20));
  assert.ok(!mockCities.some((c) => c.id === 30));

  createOrder({
    id: "ord-city-scope",
    customerName: "Test Client",
    customerPhone: "+212612345678",
    items: [{
      product_id: "p-scope",
      variant_id: "v-scope",
      sku: "SKU-S",
      name: "Product Scope",
      variant_label: "Std",
      options: [],
      quantity: 1,
      unit_price: 100,
      line_total: 100,
    }],
    upsellOffer: null,
    subtotal: 100,
    shipping: 20,
    total: 120,
  });

  const actor = { id: "agent-1" };

  // Confirm rejects address shorter than 5 chars
  for (const shortAddress of ["", "   ", "a", "1234", " ab "]) {
    assert.throws(
      () => confirmOrder("ord-city-scope", { lines: [{ lineIndex: 0, variantId: "v-scope" }], address: shortAddress, cityId: 10 }, actor),
      (err) => err instanceof ConfirmationError && err.status === 400 && err.message === "Adresse trop courte — indiquez au moins le quartier et la rue (5 caractères minimum).",
    );
  }

  // Confirm rejects city from a different provider (city 20 is ozon, active is mock)
  assert.throws(
    () => confirmOrder("ord-city-scope", { lines: [{ lineIndex: 0, variantId: "v-scope" }], address: "123 Rue Principale", cityId: 20 }, actor),
    (err) => err instanceof ConfirmationError && err.status === 400 && err.message === "Ville inconnue — lancez la synchronisation des villes.",
  );

  // Confirm succeeds with valid address and active provider's city
  const res = confirmOrder("ord-city-scope", { lines: [{ lineIndex: 0, variantId: "v-scope" }], address: "123 Rue Principale", cityId: 10 }, actor);
  assert.ok(res.submissionId);

  // Manual order rejects city from a different provider
  const { randomUUID } = await import("node:crypto");
  assert.throws(
    () => createManualOrder({
      requestId: randomUUID(),
      customer: { name: "Client Test", phone: "0612345678" },
      items: [{ variantId: "v-scope", qty: 1 }],
      cityId: 20, // ozon city, active is mock
      address: "123 Rue Principale",
      source: "manual_whatsapp",
    }, actor),
    (err) => err instanceof ManualOrderError && err.status === 400 && err.message === "Ville inconnue — veuillez synchroniser la liste des villes.",
  );

  // Manual order succeeds with active provider's city
  const manualRes = createManualOrder({
    requestId: randomUUID(),
    customer: { name: "Client Test", phone: "0612345678" },
    items: [{ variantId: "v-scope", qty: 1 }],
    cityId: 10, // mock city
    address: "123 Rue Principale",
    source: "manual_whatsapp",
  }, actor);
  assert.ok(manualRes.orderId);
});

test("latinKey, arabicKey, and ALIASES search matching", async () => {
  const Module = await import("node:module");
  const ts = await import("typescript");
  Module.default._extensions[".tsx"] = (module, filename) => {
    const { outputText } = ts.default.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.default.ModuleKind.CommonJS, target: ts.default.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.default.JsxEmit.ReactJSX },
    });
    module._compile(outputText, filename);
  };
  const { latinKey, arabicKey, ALIASES } = loadSource("@/components/crm/city-combobox");

  // Latin normalization
  assert.equal(latinKey("Casablanca"), "casablanca");
  assert.equal(latinKey("Fès"), "fes");
  assert.equal(latinKey("Laâyoune"), "laayoune");
  assert.equal(latinKey("Ksar El Kébir"), "ksar el kebir");

  // Arabic normalization
  assert.equal(arabicKey("الدار البيضاء"), "الدار البيضاء");
  assert.equal(arabicKey("طَنْجَة"), "طنجه"); // strips harakat and normalizes ta marbuta to ha
  assert.equal(arabicKey("طَنْجَة"), arabicKey("طنجة")); // matches unvocalized
  assert.equal(arabicKey("مراكـش"), "مراكش"); // strips tatweel
  assert.equal(arabicKey("الإسماعيلية"), "الاسماعيليه"); // normalizes alef, ya, ta marbuta
  assert.equal(arabicKey("الدار البيضاء").startsWith(arabicKey("الدار")), true);

  // Aliases
  assert.deepEqual(ALIASES.casablanca, ["casa", "dar el beida", "darbeida"]);
  assert.ok(ALIASES.tanger.includes("tangier") && ALIASES.tanger.includes("tanja"));
  assert.ok(ALIASES.marrakech.includes("kech"));
  assert.ok(ALIASES.fes.includes("fez"));
});
