import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "../test-source.mjs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-assignment-"));
Object.assign(process.env, {
  DB_PATH: path.join(tempDir, "test.db"), UPLOAD_DIR: path.join(tempDir, "uploads"),
  DELIVERY_PROVIDER: "mock", CRM_PUBLIC_URL: "https://crm.example.test", AUTH_SECRET: randomBytes(32).toString("hex"),
});
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  return name === "server-only" ? {} : originalLoad.call(this, name, ...args);
};
const { getDb } = loadSource("@/lib/db");
const { createProduct } = loadSource("@/lib/services/catalog");
const { storefrontOrderService } = loadSource("@/lib/storefront-order-api");
const { updateStoreSettings, getStoreSettings } = loadSource("@/lib/services/store-settings");
const { pickAssignee } = loadSource("@/lib/services/assignment");
const { createManualOrder } = loadSource("@/lib/services/manual-orders");
Module._load = originalLoad;
const db = getDb();
after(() => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });

const addUser = (id, role, n, active = 1) => db.prepare(
  "INSERT INTO users (id, email, password_hash, name, role, is_active, created_at) VALUES (?, ?, 'x', ?, ?, ?, ?)",
).run(id, `${id}@x.test`, id, role, active, `2026-01-0${n}T00:00:00.000Z`);
addUser("admin", "admin", 1);
addUser("A", "agent", 2); addUser("B", "agent", 3); addUser("C", "agent", 4);

db.prepare("INSERT INTO cities (id, name, updated_at, provider) VALUES (1, 'Casablanca', ?, 'mock')").run(new Date().toISOString());
const product = createProduct({ name: "Appareil", category: "gadgets", price: 300, images: ["/images/main.webp"] });
const variantId = product.variants[0].id;
let phone = 20000000;
const checkout = () => {
  const { response } = storefrontOrderService().checkout(randomUUID(), {
    customer: { name: "Salma Benali", phone: `06${phone++}` }, items: [{ variantId, qty: 1 }],
  });
  return db.prepare("SELECT assigned_to FROM orders WHERE id = ?").get(response.orderId).assigned_to;
};
const reset = () => { db.prepare("DELETE FROM app_state WHERE key = 'assignment_cursor'").run(); db.prepare("UPDATE orders SET confirmation_status = 'cancelled'").run(); };

test("manual mode is the default and assigns nobody", () => {
  assert.equal(getStoreSettings().assignmentMode, "manual");
  assert.equal(checkout(), null);
  assert.equal(db.prepare("SELECT 1 FROM app_state WHERE key = 'assignment_cursor'").get(), undefined);
  assert.equal(db.transaction(() => pickAssignee(db, "manual")).immediate(), null);
});

test("partial settings update keeps assignmentMode; round robin A,B,C,A,B,C", () => {
  updateStoreSettings({ assignmentMode: "round_robin" });
  updateStoreSettings({ storeName: "Autre" });
  assert.equal(getStoreSettings().assignmentMode, "round_robin");
  assert.throws(() => updateStoreSettings({ assignmentMode: "random" }));
  reset();
  assert.deepEqual(Array.from({ length: 6 }, checkout), ["A", "B", "C", "A", "B", "C"]);
});

test("deactivated agents are skipped, admins never assigned", () => {
  db.prepare("UPDATE users SET is_active = 0 WHERE id = 'B'").run();
  reset();
  assert.deepEqual(Array.from({ length: 4 }, checkout), ["A", "C", "A", "C"]);
  // cursor user deactivated: continues after its position
  db.prepare("DELETE FROM app_state WHERE key = 'assignment_cursor'").run();
  db.prepare("INSERT INTO app_state (key, value) VALUES ('assignment_cursor', 'B')").run();
  assert.equal(checkout(), "C");
  db.prepare("UPDATE users SET is_active = 1 WHERE id = 'B'").run();
});

test("no eligible agent leaves the order unassigned", () => {
  db.prepare("UPDATE users SET is_active = 0 WHERE role = 'agent'").run();
  assert.equal(checkout(), null);
  db.prepare("UPDATE users SET is_active = 1 WHERE role = 'agent'").run();
});

test("least_loaded picks the fewest open orders, ties by cursor", () => {
  updateStoreSettings({ assignmentMode: "least_loaded" });
  reset();
  assert.deepEqual(Array.from({ length: 3 }, checkout), ["A", "B", "C"]);
  // A closes (confirmed) and B archives its order: both become empty; C keeps one.
  const orders = db.prepare("SELECT id, assigned_to FROM orders WHERE confirmation_status = 'new'").all();
  const of = (u) => orders.find((o) => o.assigned_to === u).id;
  db.prepare("UPDATE orders SET confirmation_status = 'confirmed' WHERE id = ?").run(of("A"));
  db.prepare("UPDATE orders SET archived_at = '2026-02-01T00:00:00.000Z' WHERE id = ?").run(of("B"));
  // Cursor is C: tie A/B -> next after C wraps to A, then B (A now loaded).
  assert.equal(checkout(), "A");
  assert.equal(checkout(), "B");
  // Now A, B, C all carry one open order: full tie, cursor B -> C.
  assert.equal(checkout(), "C");
});

test("manual orders are distributed too", () => {
  updateStoreSettings({ assignmentMode: "round_robin" });
  reset();
  const make = () => createManualOrder({
    requestId: randomUUID(), customer: { name: "Karim Alami", phone: `06${phone++}` }, address: "12 rue des Fleurs",
    cityId: 1, source: "manual_whatsapp", items: [{ variantId, qty: 1 }],
  }, { id: "admin" });
  let ids;
  try {
    ids = [make().orderId, make().orderId];
  } catch (e) { assert.fail(`manual order failed: ${e.message}`); }
  const got = ids.map((id) => db.prepare("SELECT assigned_to FROM orders WHERE id = ?").get(id).assigned_to);
  assert.deepEqual(got, ["A", "B"]);
});

test("agent-created manual orders are self-assigned without touching the cursor; admin uses auto-assignment", () => {
  updateStoreSettings({ assignmentMode: "round_robin" });
  reset();
  const make = (actor) => createManualOrder({
    requestId: randomUUID(), customer: { name: "Karim Alami", phone: `06${phone++}` }, address: "12 rue des Fleurs",
    cityId: 1, source: "manual_whatsapp", items: [{ variantId, qty: 1 }],
  }, actor);
  const assigned = (id) => db.prepare("SELECT assigned_to FROM orders WHERE id = ?").get(id).assigned_to;
  const cursor = () => db.prepare("SELECT value FROM app_state WHERE key = 'assignment_cursor'").get();
  assert.equal(assigned(make({ id: "C", role: "agent" }).orderId), "C");
  assert.equal(cursor(), undefined);
  assert.equal(assigned(make({ id: "admin", role: "admin" }).orderId), "A");
  assert.equal(cursor().value, "A");
  assert.equal(assigned(make({ id: "C", role: "agent" }).orderId), "C");
  assert.equal(cursor().value, "A");
  updateStoreSettings({ assignmentMode: "manual" });
  assert.equal(assigned(make({ id: "C", role: "agent" }).orderId), null);
});
