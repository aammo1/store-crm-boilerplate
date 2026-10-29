import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "../test-source.mjs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-lease-"));
process.env.DB_PATH = path.join(tempDir, "test.db");
process.env.UPLOAD_DIR = path.join(tempDir, "uploads");
process.env.DELIVERY_PROVIDER = "mock";
globalThis.fetch = async () => { throw new Error("HTTP disabled in isolated tests"); };

const { getDb } = loadSource("@/lib/db");
const lease = loadSource("@/lib/services/process-lease");
const { createOrder } = await import("../fulfillment-fixtures.mjs");
const { confirmOrder } = loadSource("@/lib/services/confirmation");
const { openStock } = loadSource("@/lib/services/inventory");
const { drainSubmissions } = loadSource("@/lib/workers/submission");
const db = getDb();

after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const T0 = Date.parse("2026-01-01T00:00:00Z");

test("only the first owner acquires; second acquires after TTL expiry", () => {
  assert.equal(lease.acquireWorkerLease(T0, "A").acquired, true);
  const b = lease.acquireWorkerLease(T0 + 1000, "B");
  assert.equal(b.acquired, false);
  assert.equal(b.holder.ownerId, "A");
  assert.equal(lease.acquireWorkerLease(T0 + lease.LEASE_TTL_MS, "B").acquired, false);
  assert.equal(lease.acquireWorkerLease(T0 + lease.LEASE_TTL_MS + 1, "B").acquired, true);
  // A's heartbeat now fails and does not overwrite B.
  assert.equal(lease.heartbeatWorkerLease(T0 + lease.LEASE_TTL_MS + 2, "A"), false);
  assert.equal(lease.workerLeaseStatus(T0 + lease.LEASE_TTL_MS + 2, "B").owned, true);
  assert.equal(lease.workerLeaseStatus(T0 + lease.LEASE_TTL_MS + 2, "A").owned, false);
});

test("default owner id is stable across module re-evaluation", () => {
  const path_ = loadSource.resolve("@/lib/services/process-lease");
  const first = lease.PROCESS_OWNER_ID;
  delete loadSource.cache[path_];
  const second = loadSource("@/lib/services/process-lease");
  assert.notEqual(second, lease);
  assert.equal(second.PROCESS_OWNER_ID, first);
  assert.equal(globalThis.__crmWorkerOwnerId, first);
});

test("heartbeat extends the lease; owner can re-acquire its own", () => {
  lease.releaseWorkerLease("B");
  assert.equal(lease.acquireWorkerLease(T0, "A").acquired, true);
  assert.equal(lease.heartbeatWorkerLease(T0 + 60_000, "A"), true);
  assert.equal(lease.acquireWorkerLease(T0 + 120_000, "B").acquired, false);
  assert.equal(lease.acquireWorkerLease(T0 + 120_000, "A").acquired, true);
});

test("release by non-owner is a no-op; release by owner frees immediately", () => {
  lease.releaseWorkerLease("B");
  assert.equal(lease.acquireWorkerLease(T0 + 121_000, "B").acquired, false);
  lease.releaseWorkerLease("A");
  assert.equal(lease.workerLeaseStatus(T0 + 121_000, "A").holder, null);
  assert.equal(lease.acquireWorkerLease(T0 + 121_000, "B").acquired, true);
});

test("stale in-flight result cannot overwrite a changed submission status", async () => {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO products (id, slug, name, category, price, created_at, updated_at)
    VALUES ('p', 'p', 'Chargeur test', 'accessoires', 300, ?, ?)`).run(now, now);
  db.prepare("INSERT INTO variants (id, product_id, sku, label, options_json, options_key) VALUES ('v', 'p', 'v', 'Standard', '[]', '[]')").run();
  openStock("v", 50, "agent-1");
  db.prepare("INSERT INTO cities (id, name, updated_at, provider) VALUES (1, 'Casablanca', ?, 'mock')").run(now);
  createOrder({ id: "o1", customerName: "Cliente", customerPhone: "+212612345678",
    items: [{ product_id: "p", variant_id: "v", sku: "v", name: "Chargeur test", variant_label: "Standard", options: [], quantity: 1, unit_price: 300, line_total: 300 }],
    upsellOffer: null, subtotal: 300, shipping: 29, total: 329 });
  const { submissionId } = confirmOrder("o1", { lines: [{ lineIndex: 0, variantId: "v" }], address: "12 rue test", cityId: 1 }, { id: "agent-1" });
  db.prepare("UPDATE courier_submissions SET next_retry_at = ? WHERE id = ?").run(new Date(0).toISOString(), submissionId);

  const provider = {
    async createParcel() {
      // Another actor resolves the row while the request is in flight.
      db.prepare("UPDATE courier_submissions SET status = 'needs_review', last_error = 'agent' WHERE id = ?").run(submissionId);
      return { trackingNumber: "OZ-LATE", raw: {} };
    },
  };
  await drainSubmissions(provider);
  const row = db.prepare("SELECT status, tracking_number, last_error FROM courier_submissions WHERE id = ?").get(submissionId);
  assert.deepEqual(row, { status: "needs_review", tracking_number: null, last_error: "agent" });
});
