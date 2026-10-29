import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadSource } from "./test-source.mjs";
import { genericProduct, orderFixture, upsellService } from "./order-operations-fixtures.mjs";

const childAction = process.env.CRM_WORKFLOW_TEST_ACTION;
const tempDir = childAction ? null : fs.mkdtempSync(path.join(os.tmpdir(), "crm-order-workflow-"));
if (tempDir) process.env.DB_PATH = path.join(tempDir, "test.db");
process.env.DELIVERY_PROVIDER = "mock";
process.env.OZON_CLIENT_ID = "";
process.env.OZON_API_KEY = "";
process.env.AUTH_SECRET = "isolated-order-workflow-test-secret-32-characters";
process.env.FACEBOOK_PIXEL_ID = "";
process.env.FACEBOOK_ACCESS_TOKEN = "";

const { getDb } = loadSource("@/lib/db");
const { getCrmOrder: getOrder } = loadSource("@/lib/services/orders");
const { confirmOrder, cancelOrder, updateOrderLine, ConfirmationError } = loadSource("@/lib/services/confirmation");
const { insertContact, listOrders } = loadSource("@/lib/services/orders");
const { openStock } = loadSource("@/lib/services/inventory");
const { createSubmission } = loadSource("@/lib/services/submissions");
const { getDashboard } = loadSource("@/lib/services/dashboard");
const { createManualOrder } = loadSource("@/lib/services/manual-orders");
const { changeOrderLifecycle } = loadSource("@/lib/services/order-lifecycle");
const db = getDb();
const service = upsellService(db);
const { deriveOrderToken } = loadSource("@/lib/order-token");
const resolveUpsell = (id, action) => service.resolveUpsell(id, `request-${action}`, deriveOrderToken(id, `nonce-${id}`),
  action === "accept" ? { action, variantId: "test-upsell" } : { action });
const actor = { id: "test-agent" };
const confirmation = {
  lines: [],
  address: "12 rue de test",
  cityId: 1,
};

if (childAction) {
  process.once("message", () => {
    try {
      const id = process.env.CRM_WORKFLOW_TEST_ORDER;
      if (childAction === "crash-confirm") {
        db.exec("BEGIN IMMEDIATE");
        confirmOrder(id, confirmation, actor);
        process.exit(0); // OS closes the uncommitted outer transaction.
      }
      const result = childAction === "confirm"
        ? confirmOrder(id, confirmation, actor)
        : childAction === "manual" ? createManualOrder(JSON.parse(process.env.CRM_WORKFLOW_MANUAL_INPUT), actor)
          : resolveUpsell(id, childAction);
      process.send({ ok: true, result });
    } catch (error) {
      process.send({ ok: false, error: error.name, message: error.message });
    } finally {
      db.close();
      process.disconnect();
    }
  });
  process.send({ ready: true });
} else {
  after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const now = new Date().toISOString();
  genericProduct(db, "test-product", 300, [["test-main", []]]);
  genericProduct(db, "test-offer", 300, [["test-upsell", [{ name: "Volume", value: "500 ml" }]],
    ["test-replacement", [{ name: "Volume", value: "1 L" }]]]);
  for (const id of ["test-main", "test-upsell", "test-replacement"]) {
    openStock(id, 100, actor.id);
  }
  db.prepare("INSERT INTO cities (id, name, updated_at, provider) VALUES (1, 'Casablanca', ?, 'mock')").run(now);

  function order(id) {
    return orderFixture(db, id, { productId: "test-product", variantId: "test-main",
      offerProductId: "test-offer", offerVariantId: "test-upsell" });
  }

  function contact(id, outcome, nextCallbackAt = null) {
    return insertContact({ orderId: id, agentId: actor.id, channel: "phone", outcome, nextCallbackAt, allowPastCallback: true });
  }

  function state(id) {
    const { contacts: _contacts, ...order } = getOrder(id);
    void _contacts; // Contact journal changes are asserted separately below.
    return {
      order,
      reservations: db.prepare("SELECT * FROM reservations WHERE order_id = ? ORDER BY variant_id").all(id),
      submissions: db.prepare("SELECT * FROM courier_submissions WHERE order_id = ? ORDER BY rowid").all(id),
      movements: db.prepare("SELECT * FROM stock_movements WHERE order_id = ? ORDER BY rowid").all(id),
    };
  }

  function assertShipmentMatchesOrder(id) {
    const saved = state(id);
    assert.equal(saved.order.confirmationStatus, "confirmed");
    assert.equal(saved.submissions.length, 1);
    const payload = JSON.parse(saved.submissions[0].payload_json);
    assert.equal(payload.total, saved.order.total);
    const lines = [...saved.order.items, ...(saved.order.upsellItems ?? [])];
    assert.deepEqual(payload.items, lines.map(({ product_id, variant_id, sku, name, variant_label, options, quantity }) => ({
      product_id, variant_id, sku, name, variant_label, options, quantity,
    })));
    assert.equal(saved.reservations.reduce((sum, row) => sum + row.qty, 0), lines.reduce((sum, row) => sum + row.quantity, 0));
    assert.equal(saved.reservations.find(row => row.variant_id === "test-main")?.qty, 1);
    assert.equal(saved.reservations.find(row => row.variant_id === "test-upsell")?.qty ?? 0, saved.order.upsellStatus === "accepted" ? 1 : 0);
  }

  async function race(id, actions) {
    const children = actions.map(action => fork(fileURLToPath(import.meta.url), [], {
      env: { ...process.env, CRM_WORKFLOW_TEST_ACTION: action, CRM_WORKFLOW_TEST_ORDER: id },
      execArgv: [],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    }));
    try {
      const results = children.map(child => new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("message", message => { if (!message.ready) resolve(message); });
        child.on("exit", code => { if (code !== 0) reject(new Error(`Test child exited ${code}`)); });
      }));
      const exits = children.map(child => new Promise(resolve => child.once("exit", resolve)));
      await Promise.all(children.map(child => new Promise(resolve => {
        child.once("message", message => { assert.equal(message.ready, true); resolve(); });
      })));
      for (const child of children) child.send("go");
      const values = await Promise.all(results);
      await Promise.all(exits);
      return values;
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
    }
  }

  test("contact outcomes preserve confirmed/cancelled state and existing fulfillment", () => {
    order("confirmed-contacts");
    confirmOrder("confirmed-contacts", confirmation, actor);
    const before = state("confirmed-contacts");
    contact("confirmed-contacts", "no_answer");
    contact("confirmed-contacts", "call_back_later", "2020-01-01T00:00:00.000Z");
    contact("confirmed-contacts", "note");
    assert.deepEqual(state("confirmed-contacts"), before);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM order_contacts WHERE order_id = ?").get("confirmed-contacts").n, 3);
    assert.equal(confirmOrder("confirmed-contacts", confirmation, actor).created, false);
    assert.deepEqual(state("confirmed-contacts"), before);

    order("cancelled-contacts");
    cancelOrder("cancelled-contacts", { reason: "Annulation test" }, actor);
    const cancelled = state("cancelled-contacts");
    contact("cancelled-contacts", "no_answer");
    contact("cancelled-contacts", "call_back_later", "2020-01-01T00:00:00.000Z");
    assert.deepEqual(state("cancelled-contacts"), cancelled);
    assert.throws(() => confirmOrder("cancelled-contacts", confirmation, actor), ConfirmationError);
  });

  test("pre-confirmation contacts still transition; callback rescheduling/notes/resolution are current", () => {
    order("callbacks");
    contact("callbacks", "no_answer");
    assert.equal(getOrder("callbacks").confirmationStatus, "no_answer");
    contact("callbacks", "call_back_later", "2099-01-01T00:00:00.000Z");
    contact("callbacks", "call_back_later", "2020-01-01T00:00:00.000Z");
    contact("callbacks", "note");
    assert.equal(listOrders({ status: "all", callbackDue: true }).orders.find(row => row.id === "callbacks")?.nextCallbackAt, "2020-01-01T00:00:00.000Z");
    assert.ok(getDashboard().callbacksDue.rows.some(row => row.orderId === "callbacks"));
    contact("callbacks", "no_answer");
    assert.ok(!listOrders({ status: "all", callbackDue: true }).orders.some(row => row.id === "callbacks"));
    contact("callbacks", "call_back_later", "2020-01-01T00:00:00.000Z");
    confirmOrder("callbacks", confirmation, actor);
    assert.ok(!listOrders({ status: "all", callbackDue: true }).orders.some(row => row.id === "callbacks"));
    assert.equal(getDashboard().callbacksDue.count, 0);
  });

  test("submission history blocks reconfirmation/line edits even if an old contact corrupted status", () => {
    for (const status of ["queued", "submitting", "submitted", "failed", "needs_review"]) {
      const id = `history-${status}`;
      order(id);
      const result = confirmOrder(id, confirmation, actor);
      db.prepare("UPDATE courier_submissions SET status = ? WHERE id = ?").run(status, result.submissionId);
      db.prepare("UPDATE orders SET confirmation_status = 'no_answer' WHERE id = ?").run(id);
      const before = state(id);
      assert.throws(() => confirmOrder(id, confirmation, actor), error => error instanceof ConfirmationError && error.status === 409);
      assert.throws(() => updateOrderLine(id, { lineIndex: 0, variantId: "test-upsell" }, actor), ConfirmationError);
      assert.deepEqual(state(id), before);
    }
  });

  test("resolved reservation history cannot be replayed into an unreserved shipment", () => {
    order("released-history");
    confirmOrder("released-history", confirmation, actor);
    cancelOrder("released-history", { reason: "Test" }, actor);
    db.prepare("DELETE FROM courier_submissions WHERE order_id = ?").run("released-history");
    db.prepare("UPDATE orders SET confirmation_status = 'new' WHERE id = ?").run("released-history");
    const before = state("released-history");
    assert.throws(() => confirmOrder("released-history", confirmation, actor), ConfirmationError);
    assert.deepEqual(state("released-history"), before);
  });

  test("upsell accepted first is resolved/reserved in the courier snapshot and replay cannot double-charge", () => {
    order("upsell-first");
    resolveUpsell("upsell-first", "accept");
    assert.equal(getOrder("upsell-first").total, 510);
    confirmOrder("upsell-first", confirmation, actor);
    assertShipmentMatchesOrder("upsell-first");
    const before = state("upsell-first");
    resolveUpsell("upsell-first", "accept");
    assert.throws(() => resolveUpsell("upsell-first", "decline"), { status: 409 });
    assert.deepEqual(state("upsell-first"), before);
  });

  test("confirmation first closes pending upsell; late acceptance/decline never changes COD or stock", () => {
    order("confirmation-first");
    confirmOrder("confirmation-first", confirmation, actor);
    assert.equal(getOrder("confirmation-first").upsellStatus, "closed");
    const before = state("confirmation-first");
    assert.throws(() => resolveUpsell("confirmation-first", "accept"), { status: 409 });
    assert.throws(() => resolveUpsell("confirmation-first", "decline"), { status: 409 });
    assert.deepEqual(state("confirmation-first"), before);
    assertShipmentMatchesOrder("confirmation-first");
  });

  test("failed confirmation does not close the offer or partially reserve stock", () => {
    order("confirmation-rollback");
    const before = state("confirmation-rollback");
    const failInsert = db.prepare(`CREATE TEMP TRIGGER reject_test_submission BEFORE INSERT ON courier_submissions
      WHEN NEW.order_id = 'confirmation-rollback' BEGIN SELECT RAISE(ABORT, 'test submission failure'); END`);
    failInsert.run();
    try {
      assert.throws(() => confirmOrder("confirmation-rollback", confirmation, actor), /test submission failure/);
      assert.deepEqual(state("confirmation-rollback"), before);
    } finally {
      db.exec("DROP TRIGGER reject_test_submission");
    }
  });

  test("generic identity, replacement ownership and invalid overrides are atomic", () => {
    order("generic-validation");
    const before = state("generic-validation");
    for (const lines of [[{ lineIndex: -1, variantId: "test-main" }],
      [{ lineIndex: 1, variantId: "test-main" }], [{ lineIndex: 0, variantId: "test-upsell" }],
      [{ lineIndex: 0, variantId: "test-main" }, { lineIndex: 0, variantId: "test-main" }]]) {
      assert.throws(() => confirmOrder("generic-validation", { ...confirmation, lines }, actor), { status: 400 });
      assert.deepEqual(state("generic-validation"), before);
    }
    resolveUpsell("generic-validation", "accept");
    const price = getOrder("generic-validation").upsellItems[0].unit_price;
    confirmOrder("generic-validation", { ...confirmation, lines: [{ lineIndex: 1, variantId: "test-replacement" }] }, actor);
    const current = getOrder("generic-validation");
    assert.equal(current.items[0].variant_id, "test-main");
    assert.deepEqual(current.items[0].options, []);
    assert.equal(current.upsellItems[0].variant_id, "test-replacement");
    assert.deepEqual(current.upsellItems[0].options, [{ name: "Volume", value: "1 L" }]);
    assert.equal(current.upsellItems[0].unit_price, price);
    assert.equal(db.prepare("SELECT count(*) n FROM order_edits WHERE order_id = ?").get("generic-validation").n, 1);
  });

  test("zero-stock manual creation is price-free, idempotent and uses safe current rules; confirmation failure rolls back", () => {
    genericProduct(db, "empty", 120, [["empty-default", []]]);
    const body = { requestId: randomUUID(), customer: { name: "Cliente manuelle", phone: "0612345678" },
      items: [{ variantId: "empty-default", qty: 1 }], source: "manual_whatsapp" };
    assert.throws(() => createManualOrder({ ...body, items: [{ ...body.items[0], price: 1 }] }, actor), { status: 400 });
    const created = createManualOrder(body, actor);
    assert.deepEqual(created.totals, { itemsSubtotal: 120, shipping: 29, total: 149 });
    assert.equal(getOrder(created.orderId).address, null);
    assert.equal(getOrder(created.orderId).items[0].variant_id, "empty-default");
    db.prepare("UPDATE products SET price = 999, active = 0 WHERE id = 'empty'").run();
    assert.deepEqual(createManualOrder(body, actor), { ...created, isReplay: true });
    assert.throws(() => createManualOrder({ ...body, items: [{ variantId: "empty-default", qty: 2 }] }, actor), { status: 409 });
    assert.throws(() => createManualOrder(body, { id: "different-agent" }), { status: 409 });
    db.prepare("UPDATE products SET active = 1 WHERE id = 'empty'").run();
    const before = state(created.orderId);
    assert.throws(() => confirmOrder(created.orderId, confirmation, actor), { status: 409 });
    assert.deepEqual(state(created.orderId), before);
    openStock("empty-default", 1, actor.id);
    confirmOrder(created.orderId, confirmation, actor);
    assert.equal(getOrder(created.orderId).total, 149);
    cancelOrder(created.orderId, { reason: "Test libération" }, actor);
    assert.equal(db.prepare("SELECT status FROM reservations WHERE order_id = ?").get(created.orderId).status, "released");
  });

  test("storefront receipts prevent permanent deletion and archive blocks confirmation", () => {
    const created = service.checkout("lifecycle-request-key", { customer: { name: "Cliente", phone: "0612345678" },
      items: [{ variantId: "test-main", qty: 1 }] });
    const id = created.response.orderId;
    changeOrderLifecycle([id], "archive", actor);
    assert.throws(() => confirmOrder(id, confirmation, actor), { status: 409 });
    assert.throws(() => changeOrderLifecycle([id], "delete", { id: "admin", role: "admin" }), { status: 409 });
    changeOrderLifecycle([id], "restore", actor);
    assert.equal(service.checkout("lifecycle-request-key", { customer: { name: "Cliente", phone: "0612345678" },
      items: [{ variantId: "test-main", qty: 1 }] }).response.orderId, id);
  });

  test("pending offers cannot mutate cancelled, legacy confirmed, or already-submitted orders", () => {
    for (const kind of ["cancelled", "confirmed", "submission"]) {
      const id = `frozen-${kind}`;
      order(id);
      if (kind === "submission") createSubmission(id);
      else db.prepare("UPDATE orders SET confirmation_status = ? WHERE id = ?").run(kind, id);
      const before = state(id);
      for (const action of ["accept", "decline"]) {
        assert.throws(() => resolveUpsell(id, action), { status: 409 });
      }
      assert.deepEqual(state(id), before);
    }
  });

  test("two SQLite processes accepting the same upsell add exactly one pair/discount", { timeout: 20000 }, async () => {
    order("concurrent-accept");
    const results = await race("concurrent-accept", ["accept", "accept"]);
    assert.ok(results.every(result => result.ok));
    assert.equal(getOrder("concurrent-accept").total, 510);
    assert.equal(getOrder("concurrent-accept").upsellItems.length, 1);
  });

  test("two SQLite confirmations reserve once and queue one durable submission", { timeout: 20000 }, async () => {
    order("concurrent-confirm-twice");
    const results = await race("concurrent-confirm-twice", ["confirm", "confirm"]);
    assert.ok(results.every(result => result.ok), JSON.stringify(results));
    assert.equal(results.filter(result => result.result.created).length, 1);
    assert.equal(results[0].result.submissionId, results[1].result.submissionId);
    assertShipmentMatchesOrder("concurrent-confirm-twice");
  });

  test("upsell acceptance racing confirmation produces one consistent reserved parcel", { timeout: 60000 }, async () => {
    for (let index = 0; index < 3; index += 1) {
      const id = `concurrent-confirm-${index}`;
      order(id);
      const results = await race(id, ["accept", "confirm"]);
      assert.ok(results.find((result) => result.ok && result.result.submissionId), JSON.stringify(results));
      assert.ok(results.every(result => result.ok || result.error === "StorefrontOrderError"), JSON.stringify(results));
      assertShipmentMatchesOrder(id);
      assert.ok(["accepted", "closed"].includes(getOrder(id).upsellStatus));
    }
  });

  test("acceptance racing decline has exactly one durable outcome", { timeout: 20000 }, async () => {
    order("concurrent-decline");
    const results = await race("concurrent-decline", ["accept", "decline"]);
    assert.equal(results.filter(result => result.ok).length, 1);
    const current = getOrder("concurrent-decline");
    assert.equal(current.total, current.upsellStatus === "accepted" ? 510 : 329);
    assert.equal(current.upsellItems?.length ?? 0, current.upsellStatus === "accepted" ? 1 : 0);
    assert.equal(results.find(result => !result.ok).error, "StorefrontOrderError");
  });

  test("crash before transaction commit leaves no reservation/job/closure and retry succeeds", { timeout: 20000 }, async () => {
    order("crash-recovery");
    const before = state("crash-recovery");
    const child = fork(fileURLToPath(import.meta.url), [], { env: { ...process.env,
      CRM_WORKFLOW_TEST_ACTION: "crash-confirm", CRM_WORKFLOW_TEST_ORDER: "crash-recovery" },
      execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const exit = new Promise(resolve => child.once("exit", resolve));
    await new Promise(resolve => child.once("message", resolve));
    child.send("go");
    assert.equal(await exit, 0);
    assert.deepEqual(state("crash-recovery"), before);
    assert.equal(confirmOrder("crash-recovery", confirmation, actor).created, true);
    assertShipmentMatchesOrder("crash-recovery");
  });

  test("two SQLite processes creating a manual request persist one order/contact/receipt", { timeout: 20000 }, async () => {
    const body = { requestId: randomUUID(), customer: { name: "Commande concurrente", phone: "0612345678" },
      items: [{ variantId: "test-main", qty: 1 }], source: "manual_phone", address: "12 rue test", cityId: 1 };
    process.env.CRM_WORKFLOW_MANUAL_INPUT = JSON.stringify(body);
    const results = await race("unused", ["manual", "manual"]);
    delete process.env.CRM_WORKFLOW_MANUAL_INPUT;
    assert.ok(results.every(result => result.ok), JSON.stringify(results));
    assert.equal(results[0].result.orderId, results[1].result.orderId);
    assert.equal(results.filter(result => result.result.isReplay).length, 1);
    const id = results[0].result.orderId;
    assert.equal(db.prepare("SELECT count(*) n FROM manual_order_requests WHERE order_id = ?").get(id).n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM order_contacts WHERE order_id = ?").get(id).n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM reservations WHERE order_id = ?").get(id).n, 0);
  });
}
