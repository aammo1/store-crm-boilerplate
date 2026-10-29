import assert from "node:assert/strict";
import { fork } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadSource } from "./test-source.mjs";

const childAction = process.env.CRM_MANUAL_TEST_ACTION;
const tempDir = childAction
  ? null
  : fs.mkdtempSync(path.join(os.tmpdir(), "crm-manual-order-test-"));
if (tempDir) process.env.DB_PATH = path.join(tempDir, "test.db");
process.env.DELIVERY_PROVIDER = "mock";

const { getDb } = loadSource("@/lib/db");
const { createManualOrder, ManualOrderError } =
  loadSource("@/lib/services/manual-orders");
const { manualOrderInputSchema } =
  loadSource("@/lib/manual-order-schema");
const { confirmOrder } = loadSource("@/lib/services/confirmation");

const db = getDb();
const actorA = { id: "agent-1" };
const actorB = { id: "agent-2" };

if (childAction) {
  process.once("message", (msg) => {
    try {
      const res = createManualOrder(msg.input, msg.actor);
      process.send({ ok: true, result: res });
    } catch (error) {
      process.send({
        ok: false,
        error: error.name,
        status: error.status,
        message: error.message,
      });
    } finally {
      db.close();
      process.disconnect();
    }
  });
  process.send({ ready: true });
} else {
  after(() => {
    db.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // Seed cities, active product & variants, inactive variant, inactive product
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO cities (id, name, updated_at, provider) VALUES (1, 'Casablanca', ?, 'mock')`).run(now);
  db.prepare(`INSERT INTO cities (id, name, updated_at, provider) VALUES (2, 'Rabat', ?, 'mock')`).run(now);

  db.prepare(`INSERT INTO products (id, slug, name, category, price, active, created_at, updated_at)
    VALUES ('prod-boots', 'prod-boots', 'Sérum test', 'soins', 350, 1, ?, ?)`).run(now, now);
  for (const [id, value, sku, active] of [["var-38", "250 ml", "SKU-38", 1], ["var-39", "500 ml", "SKU-39", 1], ["var-inactive", "1 l", "SKU-40", 0]]) {
    db.prepare(`INSERT INTO variants (id, product_id, sku, label, options_json, options_key, active)
      VALUES (?, 'prod-boots', ?, ?, ?, ?, ?)`).run(id, sku, value, JSON.stringify([{ name: "Volume", value }]), JSON.stringify([["volume", value]]), active);
  }

  db.prepare(`INSERT INTO products (id, slug, name, category, price, active, created_at, updated_at)
    VALUES ('prod-inactive', 'prod-inactive', 'Produit Inactif', 'objets', 200, 0, ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO variants (id, product_id, sku, label, options_json, options_key, active)
    VALUES ('var-inactive-prod', 'prod-inactive', 'SKU-INACT', 'Standard', '[]', '[]', 1)`).run();

  // Ensure balance for inventory confirmation later
  const { openStock } = loadSource("@/lib/services/inventory");
  openStock("var-38", 10, "test");
  openStock("var-39", 10, "test");

  test("valid authenticated request creates manual order with correct attribution and totals", () => {
    const requestId = crypto.randomUUID();
    const rawInput = {
      requestId,
      customer: { name: "  Karim Alami  ", phone: "06 12 34 56 78" },
      items: [{ variantId: "var-38", qty: 1 }],
      source: "manual_whatsapp",
      address: "  12 Boulevard d'Anfa  ",
      cityId: 1,
      note: "  Livraison l'après-midi  ",
    };

    const parsed = manualOrderInputSchema.parse(rawInput);
    const result = createManualOrder(parsed, actorA);

    assert.equal(result.isReplay, false);
    assert.match(result.orderId, /^ord_/);
    // Subtotal: 1 * 350 = 350 (< 400 => shipping 29 => total 379)
    assert.equal(result.totals.itemsSubtotal, 350);
    assert.equal(result.totals.shipping, 29);
    assert.equal(result.totals.total, 379);

    // Verify order in database
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(result.orderId);
    assert.ok(order);
    assert.equal(order.customer_name, "Karim Alami");
    assert.equal(order.customer_phone, "+212612345678");
    assert.equal(order.upsell_status, "declined");
    assert.equal(order.upsell_offer_json, null);
    assert.equal(order.upsell_items_json, null);
    assert.equal(order.confirmation_status, "new");
    assert.equal(order.cod_status, "awaiting_payment");
    assert.equal(order.source, "manual_whatsapp");
    assert.equal(order.address, "12 Boulevard d'Anfa");
    assert.equal(order.city_id, 1);
    assert.equal(order.city_name, "Casablanca");
    assert.equal(order.assigned_to, null);

    // Verify OrderItem snapshot format
    const items = JSON.parse(order.items_json);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0], {
      product_id: "prod-boots",
      variant_id: "var-38", sku: "SKU-38", name: "Sérum test",
      variant_label: "250 ml", options: [{ name: "Volume", value: "250 ml" }],
      quantity: 1,
      unit_price: 350,
      line_total: 350,
    });

    // Verify order_contacts journal entry
    const contacts = db.prepare("SELECT * FROM order_contacts WHERE order_id = ?").all(result.orderId);
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].agent_id, "agent-1");
    assert.equal(contacts[0].channel, "note");
    assert.equal(contacts[0].outcome, "note");
    assert.ok(contacts[0].note.includes("WhatsApp"));
    assert.ok(contacts[0].note.includes("Livraison l'après-midi"));

    // Verify manual_order_requests
    const req = db.prepare("SELECT * FROM manual_order_requests WHERE request_id = ?").get(requestId);
    assert.ok(req);
    assert.equal(req.order_id, result.orderId);
    assert.equal(req.agent_id, "agent-1");

    // Verify no stock reservation and no courier submission
    const resCount = db.prepare("SELECT count(*) as count FROM reservations WHERE order_id = ?").get(result.orderId);
    assert.equal(resCount.count, 0);
    const subCount = db.prepare("SELECT count(*) as count FROM courier_submissions WHERE order_id = ?").get(result.orderId);
    assert.equal(subCount.count, 0);
  });

  test("free shipping applied when subtotal >= 400 MAD", () => {
    const requestId = crypto.randomUUID();
    const rawInput = {
      requestId,
      customer: { name: "Sara Bennani", phone: "0711223344" },
      items: [{ variantId: "var-38", qty: 2 }], // 2 * 350 = 700 >= 400
      source: "manual_phone",
    };

    const parsed = manualOrderInputSchema.parse(rawInput);
    const result = createManualOrder(parsed, actorA);

    assert.equal(result.totals.itemsSubtotal, 700);
    assert.equal(result.totals.shipping, 0);
    assert.equal(result.totals.total, 700);

    const order = db.prepare("SELECT shipping, total, address, city_id, city_name FROM orders WHERE id = ?").get(result.orderId);
    assert.equal(order.shipping, 0);
    assert.equal(order.total, 700);
    assert.equal(order.address, null);
    assert.equal(order.city_id, null);
    assert.equal(order.city_name, null);
  });

  test("identical replay returns existing order and snapshot totals", () => {
    const requestId = crypto.randomUUID();
    const rawInput = {
      requestId,
      customer: { name: "Reda Tazi", phone: "+212 600000000" },
      items: [{ variantId: "var-38", qty: 1 }],
      source: "manual_instagram",
      note: "Replay test",
    };

    const parsed = manualOrderInputSchema.parse(rawInput);
    const firstResult = createManualOrder(parsed, actorA);
    assert.equal(firstResult.isReplay, false);

    // Replay with identical input and same actor
    const replayResult = createManualOrder(parsed, actorA);
    assert.equal(replayResult.isReplay, true);
    assert.equal(replayResult.orderId, firstResult.orderId);
    assert.deepEqual(replayResult.totals, firstResult.totals);

    // Verify only one order and one contact entry exist
    const count = db.prepare("SELECT count(*) as c FROM orders WHERE id = ?").get(firstResult.orderId);
    assert.equal(count.c, 1);
    const contactCount = db.prepare("SELECT count(*) as c FROM order_contacts WHERE order_id = ?").get(firstResult.orderId);
    assert.equal(contactCount.c, 1);
  });

  test("price change after identical successful request still replays original snapshot", () => {
    const requestId = crypto.randomUUID();
    const rawInput = {
      requestId,
      customer: { name: "Nadia Filali", phone: "0622334455" },
      items: [{ variantId: "var-38", qty: 1 }],
      source: "manual_other",
    };

    const parsed = manualOrderInputSchema.parse(rawInput);
    const original = createManualOrder(parsed, actorA);
    assert.equal(original.totals.itemsSubtotal, 350);

    // Simulate price increase in catalog to 450 MAD
    db.prepare("UPDATE products SET price = 450 WHERE id = 'prod-boots'").run();

    try {
      // Replay same request
      const replayed = createManualOrder(parsed, actorA);
      assert.equal(replayed.isReplay, true);
      assert.equal(replayed.orderId, original.orderId);
      // Still the original 350 snapshot!
      assert.equal(replayed.totals.itemsSubtotal, 350);
      assert.equal(replayed.totals.shipping, 29);
      assert.equal(replayed.totals.total, 379);
    } finally {
      // Restore price back to 350
      db.prepare("UPDATE products SET price = 350 WHERE id = 'prod-boots'").run();
    }
  });

  test("conflicting requestId returns 409 without revealing original order", () => {
    const requestId = crypto.randomUUID();
    const rawInput = {
      requestId,
      customer: { name: "Amine Radi", phone: "0699887766" },
      items: [{ variantId: "var-38", qty: 1 }],
      source: "manual_phone",
    };

    const parsed = manualOrderInputSchema.parse(rawInput);
    createManualOrder(parsed, actorA);

    // 1. Different actor with same requestId
    assert.throws(
      () => createManualOrder(parsed, actorB),
      (err) => {
        assert.ok(err instanceof ManualOrderError);
        assert.equal(err.status, 409);
        assert.doesNotMatch(err.message, /ord_/);
        return true;
      },
    );

    // 2. Same actor but modified payload (different qty)
    const modifiedInput = manualOrderInputSchema.parse({
      ...rawInput,
      items: [{ variantId: "var-38", qty: 2 }],
    });
    assert.throws(
      () => createManualOrder(modifiedInput, actorA),
      (err) => {
        assert.ok(err instanceof ManualOrderError);
        assert.equal(err.status, 409);
        assert.doesNotMatch(err.message, /ord_/);
        return true;
      },
    );
  });

  test("duplicate variants in input are aggregated and rejected if sum > 10", () => {
    const requestId = crypto.randomUUID();

    // 1. Duplicate lines sum <= 10 -> aggregates into single OrderItem line
    const okInput = manualOrderInputSchema.parse({
      requestId,
      customer: { name: "Salma Doukkali", phone: "0633445566" },
      items: [
        { variantId: "var-38", qty: 3 },
        { variantId: "var-38", qty: 4 },
      ],
      source: "manual_whatsapp",
    });
    const okResult = createManualOrder(okInput, actorA);
    const order = db.prepare("SELECT items_json FROM orders WHERE id = ?").get(okResult.orderId);
    const items = JSON.parse(order.items_json);
    assert.equal(items.length, 1);
    assert.equal(items[0].quantity, 7);
    assert.equal(items[0].line_total, 7 * 350);

    // 2. Duplicate lines sum > 10 -> rejected
    const badInput = {
      requestId: crypto.randomUUID(),
      customer: { name: "Salma Doukkali", phone: "0633445566" },
      items: [
        { variantId: "var-38", qty: 6 },
        { variantId: "var-38", qty: 5 },
      ],
      source: "manual_whatsapp",
    };
    const parseResult = manualOrderInputSchema.safeParse(badInput);
    assert.equal(parseResult.success, false);
  });

  test("invalid variant, inactive variant, inactive product, or invalid city rejected with 400 and rolled back", () => {
    // Unknown variant
    assert.throws(
      () =>
        createManualOrder(
          manualOrderInputSchema.parse({
            requestId: crypto.randomUUID(),
            customer: { name: "Omar Idrissi", phone: "0611223344" },
            items: [{ variantId: "var-nonexistent", qty: 1 }],
            source: "manual_phone",
          }),
          actorA,
        ),
      (err) => err instanceof ManualOrderError && err.status === 400,
    );

    // Inactive variant
    assert.throws(
      () =>
        createManualOrder(
          manualOrderInputSchema.parse({
            requestId: crypto.randomUUID(),
            customer: { name: "Omar Idrissi", phone: "0611223344" },
            items: [{ variantId: "var-inactive", qty: 1 }],
            source: "manual_phone",
          }),
          actorA,
        ),
      (err) => err instanceof ManualOrderError && err.status === 400,
    );

    // Variant belonging to inactive product
    assert.throws(
      () =>
        createManualOrder(
          manualOrderInputSchema.parse({
            requestId: crypto.randomUUID(),
            customer: { name: "Omar Idrissi", phone: "0611223344" },
            items: [{ variantId: "var-inactive-prod", qty: 1 }],
            source: "manual_phone",
          }),
          actorA,
        ),
      (err) => err instanceof ManualOrderError && err.status === 400,
    );

    // Unknown city ID
    const cityReqId = crypto.randomUUID();
    assert.throws(
      () =>
        createManualOrder(
          manualOrderInputSchema.parse({
            requestId: cityReqId,
            customer: { name: "Omar Idrissi", phone: "0611223344" },
            items: [{ variantId: "var-38", qty: 1 }],
            source: "manual_phone",
            cityId: 99999,
          }),
          actorA,
        ),
      (err) => err instanceof ManualOrderError && err.status === 400,
    );

    // Verify rollback: no request recorded for cityReqId
    const req = db.prepare("SELECT 1 FROM manual_order_requests WHERE request_id = ?").get(cityReqId);
    assert.equal(req, undefined);
  });

  test("manually created order proceeds through standard confirmation flow", () => {
    const requestId = crypto.randomUUID();
    const rawInput = {
      requestId,
      customer: { name: "Hassan Slaoui", phone: "0677665544" },
      items: [{ variantId: "var-38", qty: 1 }],
      source: "manual_whatsapp",
    };

    const parsed = manualOrderInputSchema.parse(rawInput);
    const created = createManualOrder(parsed, actorA);

    // Confirmation requires city and address
    const confirmInput = {
      lines: [{ lineIndex: 0, variantId: "var-38" }],
      address: "45 Rue Al Massira",
      cityId: 1,
    };

    const confirmResult = confirmOrder(created.orderId, confirmInput, actorA);
    assert.equal(confirmResult.created, true);
    assert.ok(confirmResult.submissionId);

    // Verify order is confirmed
    const order = db.prepare("SELECT confirmation_status, address, city_id FROM orders WHERE id = ?").get(created.orderId);
    assert.equal(order.confirmation_status, "confirmed");
    assert.equal(order.address, "45 Rue Al Massira");
    assert.equal(order.city_id, 1);

    // Verify reservation was created
    const res = db.prepare("SELECT * FROM reservations WHERE order_id = ?").all(created.orderId);
    assert.equal(res.length, 1);
    assert.equal(res[0].status, "active");

    // Verify courier submission was queued
    const sub = db.prepare("SELECT * FROM courier_submissions WHERE order_id = ?").all(created.orderId);
    assert.equal(sub.length, 1);
    assert.equal(sub[0].status, "queued");
  });

  test("manual order applies the quantity pack like checkout and survives deletion as a tombstone", () => {
    const { changeOrderLifecycle } = loadSource("@/lib/services/order-lifecycle");
    const ts = new Date().toISOString();
    db.prepare(`INSERT INTO product_packs (id, product_id, quantity, price_mad, highlight, active, created_at, updated_at)
      VALUES ('pack-3', 'prod-boots', 3, 900, 0, 1, ?, ?)`).run(ts, ts);
    const requestId = crypto.randomUUID();
    const input = manualOrderInputSchema.parse({
      requestId,
      customer: { name: "Pack Client", phone: "0699887766" },
      items: [{ variantId: "var-38", qty: 2 }, { variantId: "var-39", qty: 1 }],
      source: "manual_phone",
    });
    const result = createManualOrder(input, actorA);
    // 3 * 350 = 1050 regular, pack 900 -> 150 saved, free shipping.
    assert.deepEqual(result.totals, { itemsSubtotal: 1050, shipping: 0, total: 900, packDiscount: 150 });
    const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(result.orderId);
    assert.deepEqual([row.subtotal, row.discount_type, row.discount_value, row.discount_amount, row.total],
      [1050, "fixed", 150, 150, 900]);
    assert.equal(JSON.parse(row.pack_snapshot_json)[0].packId, "pack-3");
    assert.equal(createManualOrder(input, actorA).totals.packDiscount, 150);

    changeOrderLifecycle([result.orderId], "archive", { id: "admin", role: "admin" });
    changeOrderLifecycle([result.orderId], "delete", { id: "admin", role: "admin" });
    assert.equal(db.prepare("SELECT 1 FROM orders WHERE id = ?").get(result.orderId), undefined);
    const before = db.prepare("SELECT COUNT(*) AS n FROM orders").get().n;
    assert.throws(() => createManualOrder(input, actorA),
      (e) => e instanceof ManualOrderError && e.status === 409 && /supprimée depuis/.test(e.message));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders").get().n, before);
    db.prepare("DELETE FROM product_packs WHERE id = 'pack-3'").run();
  });

  test("two concurrent processes competing for same requestId create exactly one order", async () => {
    const requestId = crypto.randomUUID();
    const input = {
      requestId,
      customer: { name: "Concurrent Test", phone: "0655443322" },
      items: [{ variantId: "var-38", qty: 1 }],
      source: "manual_phone",
    };

    const currentFile = fileURLToPath(import.meta.url);

    const runWorker = () =>
      new Promise((resolve, reject) => {
        const child = fork(currentFile, [], {
          env: {
            ...process.env,
            CRM_MANUAL_TEST_ACTION: "create",
          },
        });
        child.on("message", (msg) => {
          if (msg.ready) {
            child.send({ input, actor: actorA });
          } else {
            resolve(msg);
          }
        });
        child.on("error", reject);
      });

    const [res1, res2] = await Promise.all([runWorker(), runWorker()]);

    assert.equal(res1.ok, true);
    assert.equal(res2.ok, true);
    assert.equal(res1.result.orderId, res2.result.orderId);
    // Exactly one was new, one was replay
    const replays = [res1.result.isReplay, res2.result.isReplay];
    assert.ok(replays.includes(false));
    assert.ok(replays.includes(true));

    // Verify in DB only 1 order exists
    const orderCount = db.prepare("SELECT count(*) as c FROM orders WHERE id = ?").get(res1.result.orderId);
    assert.equal(orderCount.c, 1);
  });
}
