import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "./test-source.mjs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-resolution-"));
process.env.DB_PATH = path.join(tempDir, "test.db");
process.env.UPLOAD_DIR = path.join(tempDir, "uploads");
process.env.DELIVERY_PROVIDER = "mock";
process.env.OZON_CLIENT_ID = "";
process.env.OZON_API_KEY = "";
globalThis.fetch = async () => { throw new Error("HTTP disabled in isolated fulfillment tests"); };

const { getDb } = loadSource("@/lib/db");
import { createOrder } from "./fulfillment-fixtures.mjs";
const { confirmOrder, cancelOrder, ConfirmationError } = loadSource("@/lib/services/confirmation");
const { openStock } = loadSource("@/lib/services/inventory");
const { resolveSubmission, resolveSubmissionSchema, SubmissionResolutionError } =
  loadSource("@/lib/services/submission-resolution");
const db = getDb();
const actor = { id: "agent-1" };
const now = new Date().toISOString();
const evidence = "Portail Ozon consulté : vérification effectuée avec le support.";

after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

db.prepare(`INSERT INTO products (id, slug, name, category, price, created_at, updated_at)
  VALUES ('p', 'p', 'Chargeur test', 'accessoires', 300, ?, ?)`).run(now, now);
db.prepare("INSERT INTO variants (id, product_id, sku, label, options_json, options_key) VALUES ('v', 'p', 'v', 'Standard', '[]', '[]')").run();
openStock("v", 50, actor.id);
db.prepare("INSERT INTO cities (id, name, updated_at, provider) VALUES (1, 'Casablanca', ?, 'mock')").run(now);

let n = 0;
function confirmed(status) {
  const id = `r${++n}`;
  createOrder({ id, customerName: "Cliente", customerPhone: "+212612345678",
    items: [{ product_id: "p", variant_id: "v", sku: "v", name: "Chargeur test", variant_label: "Standard", options: [], quantity: 1, unit_price: 300, line_total: 300 }],
    upsellOffer: null, subtotal: 300, shipping: 29, total: 329 });
  const { submissionId } = confirmOrder(id, { lines: [{ lineIndex: 0, variantId: "v" }], address: "12 rue test", cityId: 1 }, actor);
  if (status !== "queued") db.prepare("UPDATE courier_submissions SET status = ?, last_error = 'timeout' WHERE id = ?").run(status, submissionId);
  return { id, submissionId };
}
const sub = (id) => db.prepare("SELECT status, tracking_number FROM courier_submissions WHERE id = ?").get(id);
const reserved = (id) => db.prepare("SELECT status FROM reservations WHERE order_id = ?").all(id).map((r) => r.status);
const audit = (id) => db.prepare("SELECT * FROM submission_resolutions WHERE submission_id = ?").all(id);
const rejects = (fn, status) => assert.throws(fn, (e) => e instanceof SubmissionResolutionError && e.status === status);

test("existing parcel is attached as submitted with an attributed audit row", () => {
  const { id, submissionId } = confirmed("needs_review");
  const result = resolveSubmission(submissionId, { outcome: "parcel_exists", trackingNumber: "OZ-123456", evidence }, actor);
  assert.equal(result.status, "submitted");
  assert.deepEqual(sub(submissionId), { status: "submitted", tracking_number: "OZ-123456" });
  const [row] = audit(submissionId);
  assert.deepEqual([row.actor_id, row.outcome, row.previous_status, row.tracking_number], ["agent-1", "parcel_exists", "needs_review", "OZ-123456"]);
  assert.match(row.evidence, /Portail Ozon/);
  assert.deepEqual(reserved(id), ["active"]);
  // Resolved submissions cannot be resolved twice.
  rejects(() => resolveSubmission(submissionId, { outcome: "no_parcel", evidence }, actor), 409);
});

test("no parcel requeues a needs_review or failed job without creating anything itself", () => {
  for (const status of ["needs_review", "failed"]) {
    const { submissionId } = confirmed(status);
    const result = resolveSubmission(submissionId, { outcome: "no_parcel", evidence }, actor);
    assert.equal(result.status, "queued");
    assert.deepEqual(sub(submissionId), { status: "queued", tracking_number: null });
    assert.equal(audit(submissionId).length, 1);
  }
});

test("only needs_review/failed jobs of confirmed, still-reserved orders can be resolved", () => {
  for (const status of ["queued", "submitting", "submitted"]) {
    const { submissionId } = confirmed(status);
    rejects(() => resolveSubmission(submissionId, { outcome: "no_parcel", evidence }, actor), 409);
    assert.equal(audit(submissionId).length, 0);
  }
  rejects(() => resolveSubmission("missing", { outcome: "no_parcel", evidence }, actor), 404);

  const released = confirmed("needs_review");
  db.prepare("UPDATE reservations SET status = 'released' WHERE order_id = ?").run(released.id);
  rejects(() => resolveSubmission(released.submissionId, { outcome: "no_parcel", evidence }, actor), 409);

  const cancelledOrder = confirmed("needs_review");
  db.prepare("UPDATE orders SET confirmation_status = 'cancelled' WHERE id = ?").run(cancelledOrder.id);
  rejects(() => resolveSubmission(cancelledOrder.submissionId, { outcome: "no_parcel", evidence }, actor), 409);
});

test("another active job or a reused tracking number blocks resolution", () => {
  const first = confirmed("needs_review");
  db.prepare(`INSERT INTO courier_submissions (id, order_id, status, next_retry_at, created_at, updated_at)
    VALUES ('dup-active', ?, 'queued', ?, ?, ?)`).run(first.id, now, now, now);
  rejects(() => resolveSubmission(first.submissionId, { outcome: "no_parcel", evidence }, actor), 409);

  const a = confirmed("needs_review");
  resolveSubmission(a.submissionId, { outcome: "parcel_exists", trackingNumber: "OZ-SHARED", evidence }, actor);
  const b = confirmed("needs_review");
  rejects(() => resolveSubmission(b.submissionId, { outcome: "parcel_exists", trackingNumber: "OZ-SHARED", evidence }, actor), 409);
  assert.equal(sub(b.submissionId).status, "needs_review");
  assert.equal(audit(b.submissionId).length, 0);
});

test("input validation requires evidence and a plain tracking number", () => {
  assert.equal(resolveSubmissionSchema.safeParse({ outcome: "no_parcel", evidence: "court" }).success, false);
  assert.equal(resolveSubmissionSchema.safeParse({ outcome: "parcel_exists", evidence }).success, false);
  assert.equal(resolveSubmissionSchema.safeParse({ outcome: "parcel_exists", trackingNumber: "https://x/a/b", evidence }).success, false);
  assert.equal(resolveSubmissionSchema.safeParse({ outcome: "parcel_exists", trackingNumber: "OZ-1", evidence }).success, true);
});

test("cancelling a needs_review order keeps stock reserved until resolved; queued/failed still cancel", () => {
  const uncertain = confirmed("needs_review");
  assert.throws(() => cancelOrder(uncertain.id, { reason: "client" }, actor),
    (e) => e instanceof ConfirmationError && e.status === 409 && /incertain/.test(e.message));
  assert.deepEqual(reserved(uncertain.id), ["active"]);

  // After the agent verifies "no parcel", the job is queued and cancellation works again.
  resolveSubmission(uncertain.submissionId, { outcome: "no_parcel", evidence }, actor);
  cancelOrder(uncertain.id, { reason: "client" }, actor);
  assert.deepEqual(reserved(uncertain.id), ["released"]);

  const queued = confirmed("queued");
  cancelOrder(queued.id, { reason: "client" }, actor);
  assert.deepEqual(reserved(queued.id), ["released"]);

  const failed = confirmed("failed"); // permanent provider refusal: no parcel exists
  cancelOrder(failed.id, { reason: "client" }, actor);
  assert.deepEqual(reserved(failed.id), ["released"]);
});
