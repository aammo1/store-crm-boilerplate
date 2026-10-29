import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "../test-source.mjs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-remittances-"));
process.env.DB_PATH = path.join(tempDir, "test.db");
process.env.UPLOAD_DIR = path.join(tempDir, "uploads");
process.env.DELIVERY_PROVIDER = "mock";

const { getDb } = loadSource("@/lib/db");
import { createOrder } from "../fulfillment-fixtures.mjs";
const { openStock, reserveForOrder } = loadSource("@/lib/services/inventory");
const { setDeliveryOutcome } = loadSource("@/lib/services/delivery-outcomes");
const svc = loadSource("@/lib/services/cod-remittances");
const db = getDb();
const now = new Date().toISOString();
const agent = { id: "agent1", role: "agent" };

after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

db.prepare(`INSERT INTO users (id, email, name, password_hash, role, created_at)
  VALUES ('admin1', 'a@example.test', 'Admin', 'x', 'admin', ?)`).run(now);
db.prepare(`INSERT INTO products (id, slug, name, category, price, created_at, updated_at)
  VALUES ('p', 'p', 'Sérum', 'soins', 300, ?, ?)`).run(now, now);
db.prepare(`INSERT INTO variants (id, product_id, sku, label, options_json, options_key)
  VALUES ('v', 'p', 'v', '500 ml', '[]', '[]')`).run();
openStock("v", 100, "test");

let n = 0;
function shipped({ delivered = true, refused = false } = {}) {
  const id = `R${++n}`;
  createOrder({
    id, customerName: "Cliente", customerPhone: "+212612345678",
    items: [{ product_id: "p", variant_id: "v", sku: "v", name: "Sérum", variant_label: "500 ml", options: [], quantity: 1, unit_price: 300, line_total: 300 }],
    subtotal: 300, shipping: 29, total: 329,
  });
  reserveForOrder(id, [{ variantId: "v", qty: 1 }], "test", "test");
  db.prepare("UPDATE orders SET confirmation_status = 'confirmed' WHERE id = ?").run(id);
  db.prepare(`INSERT INTO courier_submissions (id, order_id, status, tracking_number, next_retry_at, created_at, updated_at)
    VALUES (?, ?, 'submitted', ?, ?, ?, ?)`).run(`s${id}`, id, `TRK${id}`, now, now, now);
  if (delivered) setDeliveryOutcome(id, "delivered", agent, "agent");
  if (refused) setDeliveryOutcome(id, "refused", agent, "agent");
  return { id, tracking: `TRK${id}` };
}
const meta = { reference: "Relevé 1", receivedOn: "2026-10-20" };
const codStatus = (id) => db.prepare("SELECT cod_status s, cod_paid_at p FROM orders WHERE id = ?").get(id);

test("parseMadAmount handles formats and rejects centimes", () => {
  const ok = (s) => svc.parseMadAmount(s);
  assert.equal(ok("1 234,00").amount, 1234);
  assert.equal(ok("1234.00").amount, 1234);
  assert.equal(ok("1,234.00").amount, 1234);
  assert.equal(ok("1.234,00").amount, 1234);
  assert.equal(ok("1,234").amount, 1234);
  assert.equal(ok("350 DH").amount, 350);
  assert.equal(ok("329").amount, 329);
  for (const bad of ["12,50", "", "abc", "-5", "1,2,3"]) assert.equal(ok(bad).ok, false, bad);
});

test("preview matches, flags mismatches, foreign, invalid and duplicates", () => {
  const a = shipped();
  const b = shipped();
  const csv = [
    "Code suivi;Montant CRBT;Frais",
    `${a.tracking};300;29`,
    `${b.tracking};329;0`,
    "NOPE;100;0",
    `${a.tracking};300;29`,
    "TRKX;12,50;0",
  ].join("\n");
  const p = svc.previewStatement(csv);
  assert.deepEqual(p.mapping, { trackingColumn: 0, amountColumn: 1, feeColumn: 2 });
  assert.deepEqual(p.rows.map((r) => r.status), ["matched", "matched", "foreign", "duplicate", "invalid"]);
  assert.equal(p.rows[2].message, "Colis inconnu dans cette boutique (autre boutique du même compte ?) — ignoré.");
  const bad = svc.previewStatement(`code,montant\n${a.tracking},100`);
  assert.equal(bad.rows[0].status, "mismatch");
  assert.equal(codStatus(a.id).s, "awaiting_payment");
});

test("statement mixing known and unknown tracking numbers: known lines import, unknown are reported as foreign and ignored", () => {
  const a = shipped();
  const b = shipped();
  const unknown1 = "TRK_FOREIGN_1";
  const unknown2 = "TRK_FOREIGN_2";
  const csv = [
    "Code suivi;Montant CRBT;Frais",
    `${a.tracking};300;29`,
    `${unknown1};250;0`,
    `${b.tracking};329;0`,
    `${unknown2};150;15`,
  ].join("\n");

  const preview = svc.previewStatement(csv);
  assert.deepEqual(
    preview.rows.map((r) => ({ tracking: r.trackingNumber, status: r.status })),
    [
      { tracking: a.tracking, status: "matched" },
      { tracking: unknown1, status: "foreign" },
      { tracking: b.tracking, status: "matched" },
      { tracking: unknown2, status: "foreign" },
    ],
  );
  assert.equal(
    preview.rows[1].message,
    "Colis inconnu dans cette boutique (autre boutique du même compte ?) — ignoré.",
  );
  assert.equal(
    preview.rows[3].message,
    "Colis inconnu dans cette boutique (autre boutique du même compte ?) — ignoré.",
  );

  const rows = [
    { trackingNumber: a.tracking, paidAmount: 300, feeAmount: 29 },
    { trackingNumber: unknown1, paidAmount: 250, feeAmount: 0 },
    { trackingNumber: b.tracking, paidAmount: 329, feeAmount: 0 },
    { trackingNumber: unknown2, paidAmount: 150, feeAmount: 15 },
  ];
  const result = svc.commitRemittance({ ...meta, reference: "Relevé Multi-Boutiques", rows }, "admin1");

  assert.equal(result.applied, 2);
  assert.ok(result.remittance);
  assert.equal(result.remittance.lineCount, 2);
  assert.equal(codStatus(a.id).s, "paid");
  assert.equal(codStatus(b.id).s, "paid");

  assert.equal(result.skipped.length, 2);
  assert.equal(result.skipped[0].key, unknown1);
  assert.equal(result.skipped[0].status, "foreign");
  assert.equal(result.skipped[0].reason, "Colis inconnu dans cette boutique (autre boutique du même compte ?) — ignoré.");
  assert.equal(result.skipped[1].key, unknown2);
  assert.equal(result.skipped[1].status, "foreign");
  assert.equal(result.skipped[1].reason, "Colis inconnu dans cette boutique (autre boutique du même compte ?) — ignoré.");
});

test("commit marks paid, records fees, and re-import does not double-apply", () => {
  const a = shipped();
  const rows = [{ trackingNumber: a.tracking.toLowerCase(), paidAmount: 300, feeAmount: 29 }];
  const first = svc.commitRemittance({ ...meta, rows }, "admin1");
  assert.equal(first.applied, 1);
  assert.equal(first.remittance.feesTotal, 29);
  assert.equal(codStatus(a.id).s, "paid");
  assert.ok(codStatus(a.id).p);
  const second = svc.commitRemittance({ ...meta, rows }, "admin1");
  assert.equal(second.applied, 0);
  assert.equal(second.remittance, null);
  assert.equal(second.skipped[0].reason, "Déjà encaissée.");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM cod_remittance_lines WHERE order_id = ?").get(a.id).n, 1);
  const pv = svc.previewStatement(`code,montant,frais\n${a.tracking},300,29`);
  assert.equal(pv.rows[0].status, "already_paid");
});

test("mismatches are refused unless accepted, and recorded when accepted", () => {
  const a = shipped();
  const rows = [{ trackingNumber: a.tracking, paidAmount: 300, feeAmount: 0 }];
  const refused = svc.commitRemittance({ ...meta, rows }, "admin1");
  assert.equal(refused.applied, 0);
  assert.match(refused.skipped[0].reason, /Écart/);
  assert.equal(codStatus(a.id).s, "awaiting_payment");
  const accepted = svc.commitRemittance({ ...meta, rows: [{ ...rows[0], acceptMismatch: true }] }, "admin1");
  assert.equal(accepted.applied, 1);
  assert.equal(accepted.remittance.mismatchCount, 1);
  const line = db.prepare("SELECT expected_amount e, paid_amount p FROM cod_remittance_lines WHERE order_id = ?").get(a.id);
  assert.deepEqual({ ...line }, { e: 329, p: 300 });
});

test("only delivered orders are paid; markDelivered sets the outcome first; refused never", () => {
  const undelivered = shipped({ delivered: false });
  const refused = shipped({ delivered: false, refused: true });
  const r1 = svc.commitRemittance({ ...meta, rows: [
    { trackingNumber: undelivered.tracking, paidAmount: 329 },
    { trackingNumber: refused.tracking, paidAmount: 329, markDelivered: true },
  ] }, "admin1");
  assert.equal(r1.applied, 0);
  assert.equal(codStatus(refused.id).s, "awaiting_payment");
  const pv = svc.previewStatement(`code,montant\n${undelivered.tracking},329\n${refused.tracking},329`);
  assert.deepEqual(pv.rows.map((r) => r.status), ["needs_delivery", "not_deliverable"]);
  const r2 = svc.commitRemittance({ ...meta, rows: [{ trackingNumber: undelivered.tracking, paidAmount: 329, markDelivered: true }] }, "admin1");
  assert.equal(r2.applied, 1);
  assert.equal(codStatus(undelivered.id).s, "paid");
  assert.equal(db.prepare("SELECT delivery_outcome o FROM orders WHERE id = ?").get(undelivered.id).o, "delivered");
});

test("markDelivered with a rejected amount mismatch changes nothing; accepted mismatch applies", () => {
  const o = shipped({ delivered: false });
  const moves = () => db.prepare("SELECT COUNT(*) c FROM stock_movements").get().c;
  const outcome = () => db.prepare("SELECT delivery_outcome o FROM orders WHERE id = ?").get(o.id).o;
  const before = moves();
  const bad = svc.commitRemittance({ ...meta, rows: [{ trackingNumber: o.tracking, paidAmount: 100, markDelivered: true }] }, "admin1");
  assert.equal(bad.applied, 0);
  assert.match(bad.skipped[0].reason, /Écart/);
  assert.equal(outcome(), null);
  assert.equal(moves(), before);
  assert.equal(codStatus(o.id).s, "awaiting_payment");
  const ok = svc.commitRemittance({ ...meta, rows: [{ trackingNumber: o.tracking, paidAmount: 100, acceptMismatch: true, markDelivered: true }] }, "admin1");
  assert.equal(ok.applied, 1);
  assert.equal(outcome(), "delivered");
  assert.equal(codStatus(o.id).s, "paid");
  const again = svc.commitRemittance({ ...meta, rows: [{ trackingNumber: o.tracking, paidAmount: 100, acceptMismatch: true, markDelivered: true }] }, "admin1");
  assert.equal(again.applied, 0);
});

test("manual selection pays full totals", () => {
  const a = shipped();
  const res = svc.commitRemittance({ ...meta, orderIds: [a.id, a.id, "missing"] }, "admin1");
  assert.equal(res.applied, 1);
  assert.equal(res.remittance.paidTotal, 329);
  assert.equal(res.skipped.length, 2);
});

test("delete within 24h reverts to awaiting_payment, later is refused", () => {
  const a = shipped();
  const res = svc.commitRemittance({ ...meta, orderIds: [a.id] }, "admin1");
  assert.equal(svc.deleteRemittance(res.remittance.id).reverted, 1);
  assert.deepEqual({ ...codStatus(a.id) }, { s: "awaiting_payment", p: null });
  assert.equal(svc.commitRemittance({ ...meta, orderIds: [a.id] }, "admin1").applied, 1);
  const again = db.prepare("SELECT remittance_id id FROM cod_remittance_lines WHERE order_id = ?").get(a.id).id;
  assert.throws(() => svc.deleteRemittance(again, new Date(Date.now() + 25 * 3600_000)), (e) => e.status === 409);
  assert.equal(codStatus(a.id).s, "paid");
  assert.throws(() => svc.deleteRemittance("nope"), (e) => e.status === 404);
});

test("invalid metadata is rejected", () => {
  assert.throws(() => svc.commitRemittance({ reference: "", receivedOn: "2026-10-20", orderIds: ["x"] }, null), (e) => e.status === 400);
  assert.throws(() => svc.commitRemittance({ ...meta, receivedOn: "2026-13-40", orderIds: ["x"] }, null), (e) => e.status === 400);
});

test("aging groups unpaid delivered orders by delivery date", () => {
  const ids = [shipped().id, shipped().id, shipped().id, shipped().id];
  const base = Date.now();
  [3, 10, 20, 45].forEach((days, i) => {
    db.prepare("UPDATE orders SET delivery_outcome_at = ?, cod_status = 'awaiting_payment' WHERE id = ?")
      .run(new Date(base - days * 86_400_000).toISOString(), ids[i]);
    db.prepare("DELETE FROM cod_remittance_lines WHERE order_id = ?").run(ids[i]);
  });
  const buckets = svc.getUnpaidAging(new Date(base));
  assert.deepEqual(buckets.map((b) => b.label), ["0–7 j", "8–15 j", "16–30 j", "> 30 j"]);
  for (const [i, id] of ids.entries()) assert.ok(buckets[i].orders.some((o) => o.orderId === id), `bucket ${i}`);
});
