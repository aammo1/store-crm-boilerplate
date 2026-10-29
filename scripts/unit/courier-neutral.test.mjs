import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadSource } from "../test-source.mjs";

const { courierLabel, courierPortal } = loadSource("@/lib/shipping/courier-copy");
const { ProviderError } = loadSource("@/lib/shipping/errors");
const { submissionIntervalMs, drainSubmissions } = loadSource("@/lib/workers/submission");
const { pollIntervalMin, trackBatchSize } = loadSource("@/lib/services/tracking");

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-throttled-"));
  const origDbPath = process.env.DB_PATH;
  process.env.DB_PATH = path.join(tempDir, "test.db");

  try {
    const { getDb } = loadSource("@/lib/db");
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(`INSERT INTO products (id, slug, name, category, price, created_at, updated_at)
      VALUES ('prod-1', 'prod-1', 'Test Product', 'cat', 100, ?, ?)`).run(now, now);
    db.prepare("INSERT INTO variants (id, product_id, sku, label, options_json, options_key) VALUES ('var-1', 'prod-1', 'SKU-1', 'Std', '[]', '[]')").run();
    db.prepare("INSERT INTO cities (id, name, updated_at) VALUES (1, 'Casablanca', ?)").run(now);

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
    assert.match(row.last_error, /Transporteur saturé \(429\) — nouvel essai planifié : Sendit 429/);
    const retryAt = new Date(row.next_retry_at).getTime();
    assert.ok(retryAt >= before + 119_000 && retryAt <= before + 125_000, `next_retry_at ${row.next_retry_at} should be ~120s in future`);

    db.close();
  } finally {
    if (origDbPath !== undefined) process.env.DB_PATH = origDbPath;
    else delete process.env.DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
