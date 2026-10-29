import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "../test-source.mjs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-tracking-lookup-"));
process.env.DB_PATH = path.join(tempDir, "test.db");
process.env.UPLOAD_DIR = path.join(tempDir, "uploads");
process.env.DELIVERY_PROVIDER = "mock";

const { getDb } = loadSource("@/lib/db");
import { createOrder } from "../fulfillment-fixtures.mjs";
const { budgetKey, consumeBudgetsDetailed, peekBudgets } = loadSource("@/lib/services/security-budgets");
const { lookupOrderTracking } = loadSource("@/lib/services/order-tracking-lookup");
const db = getDb();
const now = new Date().toISOString();
const PHONE = "+212612345678";

after(() => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });

function make(id) {
  createOrder({ id, customerName: "Cliente", customerPhone: PHONE, items: [], subtotal: 300, shipping: 29, total: 329 });
}
function ship(id) {
  db.prepare(`INSERT INTO courier_submissions (id, order_id, status, tracking_number, next_retry_at, created_at, updated_at)
    VALUES (?, ?, 'submitted', ?, ?, ?, ?)`).run(`s${id}`, id, `TRK${id}`, now, now, now);
}

test("correct ref and phone, full id or short prefix, local phone format", () => {
  make("abcdef12-0000-4000-8000-000000000001");
  assert.equal(lookupOrderTracking("ABCDEF12", "06 12 34 56 78").status, "received");
  assert.equal(lookupOrderTracking("abcdef12-0000-4000-8000-000000000001", PHONE).status, "received");
});

test("wrong phone, unknown ref and malformed input are all null", () => {
  assert.equal(lookupOrderTracking("ABCDEF12", "0712345678"), null);
  assert.equal(lookupOrderTracking("ZZZZZZZZ", PHONE), null);
  assert.equal(lookupOrderTracking("ABCDEF12", "nope"), null);
  assert.equal(lookupOrderTracking("%", PHONE), null);
  assert.equal(lookupOrderTracking("ABC", PHONE), null);
  assert.equal(lookupOrderTracking({}, PHONE), null);
});

test("status mapping", () => {
  make("MAP00001");
  assert.equal(lookupOrderTracking("MAP00001", PHONE).status, "received");
  db.prepare("UPDATE orders SET confirmation_status='confirmed' WHERE id='MAP00001'").run();
  assert.equal(lookupOrderTracking("MAP00001", PHONE).status, "confirmed");
  assert.equal(lookupOrderTracking("MAP00001", PHONE).trackingNumber, undefined);
  ship("MAP00001");
  const shipped = lookupOrderTracking("MAP00001", PHONE);
  assert.equal(shipped.status, "shipped");
  assert.equal(shipped.trackingNumber, "TRKMAP00001");
  assert.deepEqual(Object.keys(shipped).sort(), ["status", "trackingNumber", "updatedAt"]);
  db.prepare("UPDATE orders SET delivery_outcome='delivered' WHERE id='MAP00001'").run();
  assert.equal(lookupOrderTracking("MAP00001", PHONE).status, "delivered");
  db.prepare("UPDATE orders SET delivery_outcome='refused' WHERE id='MAP00001'").run();
  assert.equal(lookupOrderTracking("MAP00001", PHONE).status, "refused");
  db.prepare("UPDATE orders SET confirmation_status='cancelled', delivery_outcome=NULL WHERE id='MAP00001'").run();
  assert.equal(lookupOrderTracking("MAP00001", PHONE).status, "cancelled");
});

// Mirrors the route policy: peek first, consume only on failed lookups.
function routeLookup(ref, phone) {
  const budget = { key: budgetKey("store-track:phone", phone), limit: 8, windowMs: 600_000, scope: "phone" };
  if (peekBudgets([budget])) return "limited";
  const result = lookupOrderTracking(ref, phone);
  if (!result) { consumeBudgetsDetailed([budget]); return "notfound"; }
  return "ok";
}

test("phone budget: successful lookups never consume it, 8 failures lock it", () => {
  make("BUD00001");
  for (let i = 0; i < 20; i++) assert.equal(routeLookup("BUD00001", PHONE), "ok");
  for (let i = 0; i < 8; i++) assert.equal(routeLookup("ZZZZZZZZ", PHONE), "notfound");
  assert.equal(routeLookup("BUD00001", PHONE), "limited");
  assert.equal(routeLookup("ZZZZZZZZ", PHONE), "limited");
});

test("manual orders (ord_ + nanoid) are found by their displayed 8-character ref", () => {
  make("ord_k3xq9zabcdef");
  assert.equal(lookupOrderTracking("K3XQ9ZAB", PHONE).status, "received");
  assert.equal(lookupOrderTracking("ord_k3xq9zabcdef", PHONE).status, "received");
  assert.equal(lookupOrderTracking("K3XQ9ZAB", "0712345678"), null);
  assert.equal(lookupOrderTracking("K3XQ_ZAB", PHONE), null, "_ is never a wildcard");
  make("ZZXQ9ZAB-0000-4000-8000-000000000009");
  assert.equal(lookupOrderTracking("ZZXQ_ZAB", PHONE), null);
});
