import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "./test-source.mjs";
import { genericProduct, orderFixture, upsellService } from "./order-operations-fixtures.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-order-edits-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.DELIVERY_PROVIDER = "mock";
process.env.AUTH_SECRET = "isolated-order-edits-test-secret-32-characters";
process.env.FACEBOOK_PIXEL_ID = "";
process.env.FACEBOOK_ACCESS_TOKEN = "";
const { getDb } = loadSource("@/lib/db");
const { getCrmOrder: getOrder } = loadSource("@/lib/services/orders");
const { editOrder, getOrderEditState, listOrderEdits } = loadSource("@/lib/services/order-edits");
const { confirmOrder, updateOrderLine } = loadSource("@/lib/services/confirmation");
const { openStock, reserveForOrder } = loadSource("@/lib/services/inventory");
const { changeOrderLifecycle } = loadSource("@/lib/services/order-lifecycle");
const { createManualOrder } = loadSource("@/lib/services/manual-orders");
const db = getDb();
const service = upsellService(db);
const { deriveOrderToken } = loadSource("@/lib/order-token");
const resolveUpsell = (id, action) => service.resolveUpsell(id, `request-${action}`, deriveOrderToken(id, `nonce-${id}`),
  action === "accept" ? { action, variantId: "p-38" } : { action });
const actor = { id: "agent", name: "Agent test", role: "agent" };
after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const now = new Date().toISOString();
for (const [p, price] of [["p", 300], ["other", 150]]) {
  genericProduct(db, p, price, [[`${p}-38`, [{ name: "Format", value: "XL" }]],
    [`${p}-39`, [{ name: "Format", value: "500 ml" }]]]);
  for (const id of [`${p}-38`, `${p}-39`]) {
    openStock(id, 20, actor.id);
  }
}
db.prepare("INSERT INTO cities (id, name, updated_at, provider) VALUES (1, 'Casablanca', ?, 'mock')").run(now);

function order(id) {
  orderFixture(db, id, { variantId: "p-38" });
}
function input(id, overrides = {}) {
  return { revision: getOrderEditState(id).revision, lines: [{ variantId: "p-38", qty: 1 }],
    discountType: "none", discountValue: 0, shippingMode: "auto", reason: "Demande cliente", ...overrides };
}

test("replace, add, remove and quantity changes use catalog prices; discounts and shipping survive confirmation", () => {
  order("edit");
  let state = editOrder("edit", input("edit", { lines: [{ variantId: "other-39", qty: 2 }, { variantId: "p-39", qty: 1 }],
    discountType: "percent", discountValue: 10, shippingMode: "paid" }), actor);
  assert.equal(state.snapshot.subtotal, 600);
  assert.equal(state.snapshot.discountAmount, 60);
  assert.equal(state.snapshot.shipping, 29);
  assert.equal(state.snapshot.total, 569);
  state = editOrder("edit", input("edit", { lines: [{ variantId: "other-38", qty: 2 }],
    discountType: "fixed", discountValue: 50, shippingMode: "free" }), actor);
  assert.equal(state.snapshot.total, 250);
  assert.equal(getOrder("edit").items.length, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM reservations WHERE order_id = 'edit'").get().n, 0);
  confirmOrder("edit", { lines: [{ lineIndex: 0, variantId: "other-38" }], address: "12 rue test", cityId: 1 }, actor);
  assert.equal(getOrder("edit").total, 250);
  const submission = db.prepare("SELECT payload_json FROM courier_submissions WHERE order_id = 'edit'").get();
  assert.equal(JSON.parse(submission.payload_json).total, 250);
  assert.equal(db.prepare("SELECT qty FROM reservations WHERE order_id = 'edit' AND status = 'active'").get().qty, 2);
  assert.equal(getOrderEditState("edit").editable, false);
  assert.throws(() => editOrder("edit", input("edit"), actor), { status: 409 });
  const history = listOrderEdits("edit");
  assert.equal(history.length, 2);
  assert.equal(history[0].actorName, actor.name);
  assert.equal(history[0].before.total, 569);
  assert.equal(history[0].after.total, 250);
  assert.equal(history[0].reason, "Demande cliente");
});

test("removing discount and automatic shipping recalculate the threshold after discount", () => {
  order("threshold");
  const lines = [{ variantId: "other-39", qty: 3 }];
  let result = editOrder("threshold", input("threshold", { lines, discountType: "fixed", discountValue: 51 }), actor);
  assert.equal(result.snapshot.shipping, 29);
  assert.equal(result.snapshot.total, 428);
  result = editOrder("threshold", input("threshold", { lines, discountType: "fixed", discountValue: 50 }), actor);
  assert.equal(result.snapshot.shipping, 0);
  assert.equal(result.snapshot.total, 400);
  result = editOrder("threshold", input("threshold", { lines }), actor);
  assert.equal(result.snapshot.discountAmount, 0);
  assert.equal(result.snapshot.total, 450);
});

test("accepted upsell keeps its price, cannot be forged, duplicated or expanded; pending offers close", () => {
  order("upsell");
  resolveUpsell("upsell", "accept");
  const lines = [{ variantId: "p-38", qty: 1 }, { variantId: "p-39", qty: 1, upsellIndex: 0 }];
  const result = editOrder("upsell", input("upsell", { lines, discountType: "percent", discountValue: 10 }), actor);
  assert.equal(result.snapshot.total, 480);
  assert.equal(result.snapshot.upsellItems[0].unit_price, 210);
  assert.equal(result.snapshot.discountAmount, 30);
  for (const bad of [
    [{ variantId: "other-39", qty: 1, upsellIndex: 0 }],
    [{ variantId: "p-39", qty: 2, upsellIndex: 0 }],
    [lines[1], lines[1]],
  ]) assert.throws(() => editOrder("upsell", input("upsell", { lines: bad }), actor), { status: 400 });
  editOrder("upsell", input("upsell"), actor);
  assert.equal(getOrder("upsell").upsellStatus, "declined");
  assert.equal(getOrder("upsell").upsellItems, null);
  order("pending");
  editOrder("pending", input("pending", { shippingMode: "free" }), actor);
  assert.throws(() => resolveUpsell("pending", "accept"), { status: 409 });
  assert.equal(getOrder("pending").total, 300);
  assert.equal(getOrder("pending").upsellStatus, "declined");
});

test("stale edits cannot overwrite other edits, legacy variant changes or accepted upsells", () => {
  order("stale");
  const stale = input("stale");
  editOrder("stale", { ...stale, shippingMode: "free" }, actor);
  assert.throws(() => editOrder("stale", stale, actor), { status: 409 });
  const beforeVariant = input("stale");
  updateOrderLine("stale", { lineIndex: 0, variantId: "p-39" }, actor);
  assert.throws(() => editOrder("stale", beforeVariant, actor), { status: 409 });
  order("upsell-race");
  const beforeUpsell = input("upsell-race");
  resolveUpsell("upsell-race", "accept");
  assert.throws(() => editOrder("upsell-race", beforeUpsell, actor), { status: 409 });
});

test("invalid, inactive, overstock, archived and fulfillment-history edits leave order and history intact", () => {
  order("invalid");
  const before = getOrderEditState("invalid");
  for (const overrides of [
    { lines: [] }, { lines: [{ variantId: "missing", qty: 1 }] },
    { lines: [{ variantId: "p-38", qty: 6 }, { variantId: "p-38", qty: 5 }] },
    { discountType: "percent", discountValue: 101 }, { discountType: "fixed", discountValue: 301 },
    { reason: " " }, { total: 1 }, { lines: [{ variantId: "p-38", qty: 1, price: 1 }] },
  ]) assert.throws(() => editOrder("invalid", input("invalid", overrides), actor), { status: 400 });
  db.prepare("UPDATE variants SET active = 0 WHERE id = 'other-38'").run();
  assert.throws(() => editOrder("invalid", input("invalid", { lines: [{ variantId: "other-38", qty: 1 }] }), actor), { status: 400 });
  db.prepare("UPDATE variants SET active = 1 WHERE id = 'other-38'").run();
  order("stock-holder");
  reserveForOrder("stock-holder", [{ variantId: "p-38", qty: 19 }], actor.id, "crm");
  assert.throws(() => editOrder("invalid", input("invalid", { lines: [{ variantId: "p-38", qty: 2 }] }), actor), { status: 409 });
  assert.deepEqual(getOrderEditState("invalid"), before);
  assert.deepEqual(listOrderEdits("invalid"), []);
  order("archived");
  changeOrderLifecycle(["archived"], "archive", actor);
  assert.throws(() => editOrder("archived", input("archived"), actor), { status: 409 });
  order("history");
  db.prepare(`INSERT INTO courier_submissions (id, order_id, status, next_retry_at, created_at, updated_at)
    VALUES ('history-parcel', 'history', 'failed', ?, ?, ?)`).run(now, now, now);
  assert.throws(() => editOrder("history", input("history"), actor), { status: 409 });
});

test("history failure rolls the entire edit back and archived edited orders remain deletable", () => {
  order("rollback");
  const before = getOrderEditState("rollback");
  db.exec("CREATE TRIGGER reject_edit BEFORE INSERT ON order_edits BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.throws(() => editOrder("rollback", input("rollback", { shippingMode: "free" }), actor), /test failure/);
  db.exec("DROP TRIGGER reject_edit");
  assert.deepEqual(getOrderEditState("rollback"), before);
  assert.equal(listOrderEdits("rollback").length, 0);
  editOrder("rollback", input("rollback"), actor);
  changeOrderLifecycle(["rollback"], "archive", actor);
  changeOrderLifecycle(["rollback"], "delete", { id: "admin", role: "admin" });
  assert.equal(getOrder("rollback"), null);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
});

test("closing a pending offer with an edit freezes the final durable conversion snapshot", () => {
  order("meta-edit");
  db.prepare("INSERT INTO meta_purchases (order_id, event_id, context_json, deadline) VALUES (?, ?, '{}', 0)")
    .run("meta-edit", "meta-edit-event");
  const result = editOrder("meta-edit", input("meta-edit", { lines: [{ variantId: "other-39", qty: 2 }] }), actor);
  const frozen = JSON.parse(db.prepare("SELECT snapshot_json FROM meta_purchases WHERE order_id = ?").get("meta-edit").snapshot_json);
  assert.equal(frozen.total, result.snapshot.total);
  assert.deepEqual(frozen.items, result.snapshot.items);
  assert.deepEqual(frozen.upsellItems, []);
});

test("shipping rules and accepted upsell snapshots survive later settings/catalog changes", () => {
  orderFixture(db, "snapshots", { variantId: "p-38", rules: { storeName: "Test", shippingFeeMad: 43,
    freeShippingThresholdMad: 900, upsellEnabled: true, upsellWindowSeconds: 300, upsellDiscountPercent: 30 } });
  resolveUpsell("snapshots", "accept");
  const original = getOrder("snapshots").upsellItems[0];
  db.prepare("UPDATE products SET price = 700, name = 'Nouveau nom' WHERE id = 'p'").run();
  db.prepare("INSERT INTO app_state (key, value) VALUES ('store_settings', ?)").run(JSON.stringify({
    storeName: "Changed", shippingFeeMad: 80, freeShippingThresholdMad: 10,
    upsellEnabled: false, upsellWindowSeconds: 1, upsellDiscountPercent: 80 }));
  const state = editOrder("snapshots", input("snapshots", { lines: [{ variantId: "other-39", qty: 1 },
    { variantId: "p-38", qty: 1, upsellIndex: 0 }] }), actor);
  assert.deepEqual(state.snapshot.upsellItems[0], original);
  assert.equal(state.snapshot.shipping, 43);
  assert.equal(state.snapshot.total, 403);
});

test("missing no-offer checkout rules block repricing rather than using changed settings", () => {
  orderFixture(db, "missing-rules", { variantId: "p-38", offer: false });
  const before = getOrderEditState("missing-rules");
  assert.throws(() => editOrder("missing-rules", input("missing-rules"), actor), { status: 409 });
  assert.deepEqual(getOrderEditState("missing-rules"), before);
});

test("manual shipping rules survive settings changes and no-op edits still invalidate revisions", () => {
  const created = createManualOrder({ requestId: randomUUID(), customer: { name: "Manuelle", phone: "0612345678" },
    items: [{ variantId: "other-39", qty: 1 }], source: "manual_other" }, actor);
  const settings = JSON.parse(db.prepare("SELECT value FROM app_state WHERE key = 'store_settings'").get().value);
  assert.equal(settings.shippingFeeMad, 80);
  db.prepare("UPDATE app_state SET value = ? WHERE key = 'store_settings'").run(JSON.stringify({ ...settings,
    shippingFeeMad: 1, freeShippingThresholdMad: 9999 }));
  const body = input(created.orderId, { lines: [{ variantId: "other-39", qty: 1 }], shippingMode: "paid" });
  const changed = editOrder(created.orderId, body, actor);
  assert.equal(changed.snapshot.shipping, 80);
  const repeatBody = { ...body, revision: changed.revision };
  const originalUpdatedAt = db.prepare("SELECT updated_at FROM orders WHERE id = ?").get(created.orderId).updated_at;
  editOrder(created.orderId, repeatBody, actor);
  db.prepare("UPDATE orders SET updated_at = ? WHERE id = ?").run(originalUpdatedAt, created.orderId);
  assert.notEqual(getOrderEditState(created.orderId).revision, repeatBody.revision);
  assert.throws(() => editOrder(created.orderId, repeatBody, actor), { status: 409 });
});

test("no-offer checkout snapshots original shipping rules for audited edits and immutable replay", () => {
  const { orderRulesKey, orderShippingRules } = loadSource("@/lib/services/order-lines");
  const savedSettings = db.prepare("SELECT value FROM app_state WHERE key = 'store_settings'").get();
  try {
    // With upsells enabled, this catalog has neither upsellRef nor best sellers.
    // Both ways of creating a null offer must persist exactly the same contract.
    for (const upsellEnabled of [false, true]) {
      const originalRules = { shippingFeeMad: 43, freeShippingThresholdMad: 900 };
      const settings = { storeName: "Original checkout", ...originalRules, upsellEnabled,
        upsellWindowSeconds: 20, upsellDiscountPercent: 30 };
      db.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES ('store_settings', ?)").run(JSON.stringify(settings));
      const key = `no-offer-edit-${upsellEnabled}`;
      const body = { customer: { name: "Cliente sans offre", phone: "0612345678" },
        items: [{ variantId: "other-39", qty: 1 }] };
      const first = service.checkout(key, body);
      const id = first.response.orderId;
      assert.equal(first.status, 201);
      assert.equal(first.response.upsellOffer, null);
      assert.equal(getOrder(id).upsellStatus, "closed");
      assert.deepEqual(first.response.totals, { itemsSubtotal: 150, shipping: 43, total: 193, currency: "MAD" });
      const storedRules = db.prepare("SELECT value FROM app_state WHERE key = ?").get(orderRulesKey(id)).value;
      assert.deepEqual(JSON.parse(storedRules), originalRules);
      assert.deepEqual(orderShippingRules(id), originalRules);

      db.prepare("UPDATE app_state SET value = ? WHERE key = 'store_settings'").run(JSON.stringify({
        ...settings, shippingFeeMad: 80, freeShippingThresholdMad: 9999,
      }));
      const edited = editOrder(id, input(id, { lines: [{ variantId: "other-39", qty: 3 }] }), actor);
      assert.equal(edited.snapshot.subtotal, 450);
      assert.equal(edited.snapshot.shipping, 43);
      assert.equal(edited.snapshot.total, 493);
      const free = editOrder(id, input(id, { lines: [{ variantId: "other-39", qty: 6 }] }), actor);
      assert.equal(free.snapshot.subtotal, 900);
      assert.equal(free.snapshot.shipping, 0);
      assert.equal(free.snapshot.total, 900);
      assert.equal(listOrderEdits(id).length, 2);
      assert.equal(db.prepare("SELECT value FROM app_state WHERE key = ?").get(orderRulesKey(id)).value, storedRules);

      const replay = service.checkout(key, body);
      assert.equal(replay.status, 200);
      assert.deepEqual(replay.response, first.response);
      assert.deepEqual(getOrderEditState(id), free);
      assert.deepEqual(orderShippingRules(id), originalRules);
    }
  } finally {
    if (savedSettings) db.prepare("UPDATE app_state SET value = ? WHERE key = 'store_settings'").run(savedSettings.value);
    else db.prepare("DELETE FROM app_state WHERE key = 'store_settings'").run();
  }
});

test("receipt failure rolls back no-offer checkout shipping snapshot together with its order", () => {
  const before = {
    orders: db.prepare("SELECT COUNT(*) AS n FROM orders").get().n,
    rules: db.prepare("SELECT key, value FROM app_state WHERE key LIKE 'order-shipping-rules:%' ORDER BY key").all(),
    receipts: db.prepare("SELECT COUNT(*) AS n FROM storefront_request_receipts").get().n,
  };
  const key = "no-offer-snapshot-rollback";
  const body = { customer: { name: "Cliente rollback", phone: "0612345678" },
    items: [{ variantId: "other-39", qty: 1 }] };
  db.exec(`CREATE TEMP TRIGGER reject_shipping_receipt BEFORE INSERT ON storefront_request_receipts
    WHEN NEW.request_key = '${key}' BEGIN SELECT RAISE(ABORT, 'checkout receipt failure'); END`);
  try { assert.throws(() => service.checkout(key, body), /checkout receipt failure/); }
  finally { db.exec("DROP TRIGGER reject_shipping_receipt"); }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders").get().n, before.orders);
  assert.deepEqual(db.prepare("SELECT key, value FROM app_state WHERE key LIKE 'order-shipping-rules:%' ORDER BY key").all(), before.rules);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM storefront_request_receipts").get().n, before.receipts);
  assert.equal(service.checkout(key, body).status, 201);
  assert.equal(service.checkout(key, body).status, 200);
});

test("unchanged lines on a sold-out variant still allow discount/shipping edits; added quantity is stock-checked", () => {
  genericProduct(db, "sold", 200, [["sold-1", []]]);
  orderFixture(db, "sold-out", { productId: "sold", variantId: "sold-1", price: 200 });
  const lines = [{ variantId: "sold-1", qty: 1 }];
  const state = editOrder("sold-out", input("sold-out", { lines, discountType: "fixed", discountValue: 20 }), actor);
  assert.equal(state.snapshot.total, 209);
  assert.throws(() => editOrder("sold-out", input("sold-out", { lines: [{ variantId: "sold-1", qty: 2 }] }), actor), { status: 409 });
  assert.equal(listOrderEdits("sold-out").length, 1);
});

test("edits keep the original unit price of untouched lines after a catalog price increase", () => {
  genericProduct(db, "rise", 100, [["rise-1", []]]);
  openStock("rise-1", 20, actor.id);
  orderFixture(db, "rise-order", { productId: "rise", variantId: "rise-1", price: 100 });
  db.prepare("UPDATE products SET price = 500 WHERE id = 'rise'").run();
  const state = editOrder("rise-order", input("rise-order", { lines: [{ variantId: "rise-1", qty: 1 }], shippingMode: "free" }), actor);
  assert.equal(state.snapshot.items[0].unit_price, 100);
  assert.equal(state.snapshot.total, 100);
  const more = editOrder("rise-order", input("rise-order", { lines: [{ variantId: "rise-1", qty: 2 }], shippingMode: "free" }), actor);
  assert.equal(more.snapshot.items[0].unit_price, 100);
  assert.equal(more.snapshot.total, 200);
});

test("pack mode recomputes the pack discount from current packs for the edited quantities", () => {
  genericProduct(db, "pk", 149, [["pk-1", []]]);
  openStock("pk-1", 20, actor.id);
  db.prepare(`INSERT INTO product_packs (id, product_id, quantity, price_mad, created_at, updated_at) VALUES ('pk-3', 'pk', 3, 399, ?, ?)`).run(now, now);
  orderFixture(db, "pack-order", { productId: "pk", variantId: "pk-1", price: 149 });
  const rows = () => db.prepare("SELECT pack_snapshot_json, discount_type, discount_value, discount_amount FROM orders WHERE id = 'pack-order'").get();
  // 2 -> 3 in pack mode: pack applies and is snapshotted. Client discount is ignored.
  let state = editOrder("pack-order", input("pack-order", { lines: [{ variantId: "pk-1", qty: 3 }], discountMode: "pack",
    discountType: "fixed", discountValue: 1 }), actor);
  assert.equal(state.snapshot.discountAmount, 48);
  assert.equal(state.snapshot.total, 399 + 29);
  assert.equal(state.snapshot.discountMode, "pack");
  assert.equal(JSON.parse(rows().pack_snapshot_json)[0].packPrice, 399);
  assert.equal(rows().discount_type, "fixed");
  // Mode defaults to pack now (snapshot present). 3 -> 2: no pack, no stale discount.
  state = editOrder("pack-order", input("pack-order", { lines: [{ variantId: "pk-1", qty: 2 }] }), actor);
  assert.equal(state.snapshot.discountAmount, 0);
  assert.equal(state.snapshot.total, 2 * 149 + 29);
  assert.equal(rows().pack_snapshot_json, null);
  assert.equal(rows().discount_amount, 0);
  // Back to 3, then manual mode overrides the pack and clears the snapshot.
  editOrder("pack-order", input("pack-order", { lines: [{ variantId: "pk-1", qty: 3 }], discountMode: "pack" }), actor);
  assert.notEqual(rows().pack_snapshot_json, null);
  state = editOrder("pack-order", input("pack-order", { lines: [{ variantId: "pk-1", qty: 3 }], discountMode: "manual",
    discountType: "fixed", discountValue: 10, shippingMode: "free" }), actor);
  assert.equal(rows().pack_snapshot_json, null);
  assert.equal(state.snapshot.discountAmount, 10);
  assert.equal(state.snapshot.total, 3 * 149 - 10);
  assert.equal(state.snapshot.discountMode, "manual");
  const history = listOrderEdits("pack-order");
  assert.equal(history[0].before.discountMode, "pack");
  assert.equal(history[0].after.discountMode, "manual");
});

test("city fee override applies only with explicit applyCityFee and persists in the rules snapshot", () => {
  const { upsertCityTariff } = loadSource("@/lib/services/city-tariffs");
  const { orderShippingRules } = loadSource("@/lib/services/order-lines");
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, name, role, created_at) VALUES ('agent', 'a@x.test', 'x', 'A', 'agent', ?)").run(now);
  upsertCityTariff({ cityId: 1, courierCost: 20, customerFeeOverride: 60, overrideIgnoresFreeThreshold: false }, "agent");
  order("city-fee");
  db.prepare("UPDATE orders SET city_id = 1 WHERE id = 'city-fee'").run();
  const lines = [{ variantId: "other-39", qty: 1 }];
  // No flag: nothing changes.
  let state = editOrder("city-fee", input("city-fee", { lines }), actor);
  assert.equal(state.snapshot.shipping, 29);
  assert.equal(orderShippingRules("city-fee").shippingFeeMad, 29);
  // Explicit flag: override used, persisted, shown in history.
  state = editOrder("city-fee", input("city-fee", { lines, applyCityFee: true }), actor);
  assert.equal(state.snapshot.shipping, 60);
  assert.equal(state.snapshot.total, 210);
  assert.equal(orderShippingRules("city-fee").shippingFeeMad, 60);
  assert.equal(listOrderEdits("city-fee")[0].after.cityFeeMad, 60);
  // A later edit without the flag stays consistent with the snapshot, even if the tariff changes.
  upsertCityTariff({ cityId: 1, courierCost: 20, customerFeeOverride: 99, overrideIgnoresFreeThreshold: false }, "agent");
  state = editOrder("city-fee", input("city-fee", { lines, shippingMode: "paid" }), actor);
  assert.equal(state.snapshot.shipping, 60);
  // Free-shipping threshold still applies by default...
  const big = [{ variantId: "other-39", qty: 3 }];
  state = editOrder("city-fee", input("city-fee", { lines: big, applyCityFee: true }), actor);
  assert.equal(state.snapshot.shipping, 0);
  // ...unless the tariff ignores it.
  upsertCityTariff({ cityId: 1, courierCost: 20, customerFeeOverride: 99, overrideIgnoresFreeThreshold: true }, "agent");
  state = editOrder("city-fee", input("city-fee", { lines: big, applyCityFee: true }), actor);
  assert.equal(state.snapshot.shipping, 99);
  // No override for the city: explicit flag is rejected.
  order("city-none");
  assert.throws(() => editOrder("city-none", input("city-none", { applyCityFee: true }), actor), { status: 400 });
});
