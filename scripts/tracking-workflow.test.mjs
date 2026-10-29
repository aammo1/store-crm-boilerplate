import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "./test-source.mjs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-tracking-workflow-"));
process.env.DB_PATH = path.join(tempDir, "test.db");
process.env.UPLOAD_DIR = path.join(tempDir, "uploads");
process.env.DELIVERY_PROVIDER = "mock";
process.env.OZON_CLIENT_ID = "";
process.env.OZON_API_KEY = "";
globalThis.fetch = async () => { throw new Error("HTTP disabled in isolated fulfillment tests"); };

const { getDb } = loadSource("@/lib/db");
import { createOrder } from "./fulfillment-fixtures.mjs";
const { openStock, reserveForOrder, dispatchOrder } = loadSource("@/lib/services/inventory");
const { pollOnce } = loadSource("@/lib/services/tracking");
const { STATUS_MAP } = loadSource("@/lib/shipping/status-map");
const { createMockProvider } = loadSource("@/lib/shipping/mock");
const db = getDb();
const now = new Date().toISOString();
assert.deepEqual(Object.keys(STATUS_MAP), [], "live mappings must stay unverified");

// Temporary, test-only mappings: the production STATUS_MAP is intentionally
// empty until Ozon statuses are verified live.
Object.assign(STATUS_MAP, {
  T_DELIVERED: "delivered", T_TRANSIT: "in_transit", T_REFUSED: "refused",
});

after(() => {
  for (const key of ["T_DELIVERED", "T_TRANSIT", "T_REFUSED"]) delete STATUS_MAP[key];
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

db.prepare(`INSERT INTO products (id, slug, name, category, price, created_at, updated_at)
  VALUES ('p', 'p', 'Sérum test', 'soins', 300, ?, ?)`).run(now, now);
db.prepare(`INSERT INTO variants (id, product_id, sku, label, options_json, options_key)
  VALUES ('v', 'p', 'v', '500 ml', '[{"name":"Contenance","value":"500 ml"}]', '[["contenance","500 ml"]]')`).run();
openStock("v", 50, "test");

let n = 0;
function submitted(dispatch = true, provider = "mock", customCode = null, confirmed = false) {
  const id = `T${++n}`;
  createOrder({
    id, customerName: "Cliente", customerPhone: "+212612345678",
    items: [{ product_id: "p", variant_id: "v", sku: "v", name: "Sérum test", variant_label: "500 ml", options: [{ name: "Contenance", value: "500 ml" }], quantity: 1, unit_price: 300, line_total: 300 }],
    subtotal: 300, shipping: 29, total: 329,
  });
  if (confirmed) {
    db.prepare("UPDATE orders SET confirmation_status = 'confirmed' WHERE id = ?").run(id);
  }
  reserveForOrder(id, [{ variantId: "v", qty: 1 }], "test", "test");
  if (dispatch) dispatchOrder(id, "test");
  const code = customCode ?? `TRK${id}`;
  db.prepare(`INSERT INTO courier_submissions (id, order_id, provider, status, tracking_number, next_retry_at, created_at, updated_at)
    VALUES (?, ?, ?, 'submitted', ?, ?, ?, ?)`).run(`s${id}`, id, provider, code, now, now, now);
  return { sub: `s${id}`, code, orderId: id };
}
const poll = (code, rawStatus, date) =>
  pollOnce({ track: async () => [{ trackingNumber: code, rawStatus, raw: date ? { date } : {} }] });
const current = (sub) => db.prepare("SELECT normalized_status s, raw_status r FROM courier_submissions WHERE id = ?").get(sub);
const events = (sub) => db.prepare("SELECT COUNT(*) n FROM tracking_events WHERE submission_id = ?").get(sub).n;
const returns = (sub) => db.prepare("SELECT COUNT(*) n FROM returns WHERE submission_id = ?").get(sub).n;

test("unknown courier statuses preserve stock, reservations and return state", async () => {
  for (const dispatch of [true, false]) {
    const { sub, code } = submitted(dispatch);
    const before = {
      stock: db.prepare("SELECT * FROM stock_balances ORDER BY variant_id").all(),
      movements: db.prepare("SELECT * FROM stock_movements ORDER BY id").all(),
      reservations: db.prepare("SELECT * FROM reservations ORDER BY id").all(),
    };
    await poll(code, "UNVERIFIED_RETURN_DELIVERED");
    assert.equal(current(sub).s, "unknown");
    assert.equal(returns(sub), 0);
    assert.deepEqual({
      stock: db.prepare("SELECT * FROM stock_balances ORDER BY variant_id").all(),
      movements: db.prepare("SELECT * FROM stock_movements ORDER BY id").all(),
      reservations: db.prepare("SELECT * FROM reservations ORDER BY id").all(),
    }, before);
  }
});

test("an older in-transit observation cannot replace a newer delivered one", async () => {
  const { sub, code } = submitted();
  await poll(code, "T_DELIVERED", "2026-10-14T10:00:00Z");
  await poll(code, "T_TRANSIT", "2026-10-13T10:00:00Z");
  assert.deepEqual(current(sub), { s: "delivered", r: "T_DELIVERED" });
  assert.equal(events(sub), 2); // raw history kept
});

test("an older refusal cannot create return work after a newer delivery", async () => {
  const { sub, code } = submitted();
  await poll(code, "T_DELIVERED", "2026-10-14T10:00:00Z");
  await poll(code, "T_REFUSED", "2026-10-12T10:00:00Z");
  assert.equal(current(sub).s, "delivered");
  assert.equal(returns(sub), 0);
  assert.equal(events(sub), 2);
});

test("newer observations still apply, and a newer refusal opens a return", async () => {
  const { sub, code } = submitted();
  await poll(code, "T_TRANSIT", "2026-10-13T10:00:00Z");
  await poll(code, "T_REFUSED", "2026-10-14T10:00:00Z");
  assert.equal(current(sub).s, "refused");
  assert.equal(returns(sub), 1);
});

test("without timestamps a delivered parcel is sticky but other statuses follow the latest poll", async () => {
  const sticky = submitted();
  await poll(sticky.code, "T_DELIVERED");
  await poll(sticky.code, "T_TRANSIT");
  assert.equal(current(sticky.sub).s, "delivered");

  const moving = submitted();
  await poll(moving.code, "T_TRANSIT");
  await poll(moving.code, "T_REFUSED");
  assert.equal(current(moving.sub).s, "refused");
});

test("unparseable timestamps are stored but give no ordering evidence", async () => {
  const { sub, code } = submitted();
  await poll(code, "T_DELIVERED", "2026-10-14T10:00:00Z");
  await poll(code, "T_TRANSIT", "not-a-date");
  assert.equal(current(sub).s, "delivered");
  // A genuinely newer, parseable observation may override a terminal status.
  await poll(code, "T_REFUSED", "2026-10-15T10:00:00Z");
  assert.equal(current(sub).s, "refused");
});

test("replaying an exact observation is idempotent", async () => {
  const { sub, code } = submitted();
  await poll(code, "T_DELIVERED", "2026-10-14T10:00:00Z");
  await poll(code, "T_DELIVERED", "2026-10-14T10:00:00Z");
  assert.equal(events(sub), 1);
  assert.equal(current(sub).s, "delivered");
});

test("Sendit courier profile normalizes vendor statuses and triggers expected side effects", async () => {
  process.env.MOCK_COURIER_PROFILE = "sendit";
  try {
    const mock = createMockProvider({ profile: "sendit" });

    // DELIVERED → delivered outcome + dispatch recovery (created without dispatch)
    const deliv = submitted(false, "mock", `SNDMOCK_DEL_${n}`, true);
    mock.setTrackingStatus(deliv.code, "DELIVERED");
    await pollOnce(mock);
    assert.equal(current(deliv.sub).s, "delivered");
    assert.equal(current(deliv.sub).r, "DELIVERED");
    assert.equal(
      db.prepare("SELECT delivery_outcome FROM orders WHERE id = ?").get(deliv.orderId).delivery_outcome,
      "delivered",
    );
    const delivMovements = db
      .prepare("SELECT kind, ref FROM stock_movements WHERE order_id = ?")
      .all(deliv.orderId);
    assert.ok(
      delivMovements.some((m) => m.kind === "dispatch" || m.ref.startsWith("disp")),
      "missed dispatch was recovered",
    );

    // REJECTED → return + refused
    const rej = submitted(true, "mock", `SNDMOCK_REJ_${n}`, true);
    mock.setTrackingStatus(rej.code, "REJECTED");
    await pollOnce(mock);
    assert.equal(current(rej.sub).s, "refused");
    assert.equal(current(rej.sub).r, "REJECTED");
    assert.equal(returns(rej.sub), 1);
    assert.equal(
      db.prepare("SELECT delivery_outcome FROM orders WHERE id = ?").get(rej.orderId).delivery_outcome,
      "refused",
    );

    // UNREACHABLE → delivery_issue with no outcome
    const unr = submitted(true, "mock", `SNDMOCK_UNR_${n}`, true);
    mock.setTrackingStatus(unr.code, "UNREACHABLE");
    await pollOnce(mock);
    assert.equal(current(unr.sub).s, "delivery_issue");
    assert.equal(current(unr.sub).r, "UNREACHABLE");
    assert.equal(returns(unr.sub), 0);
    assert.equal(
      db.prepare("SELECT delivery_outcome FROM orders WHERE id = ?").get(unr.orderId).delivery_outcome,
      null,
    );

    // picked_up alias → in_transit
    const pck = submitted(true, "mock", `SNDMOCK_PCK_${n}`, true);
    mock.setTrackingStatus(pck.code, "picked_up");
    await pollOnce(mock);
    assert.equal(current(pck.sub).s, "in_transit");
    assert.equal(current(pck.sub).r, "picked_up");
    assert.equal(returns(pck.sub), 0);
    assert.equal(
      db.prepare("SELECT delivery_outcome FROM orders WHERE id = ?").get(pck.orderId).delivery_outcome,
      null,
    );

    // unknown code → unknown
    const unk = submitted(true, "mock", `SNDMOCK_UNK_${n}`, true);
    mock.setTrackingStatus(unk.code, "NON_EXISTENT_STATUS_CODE");
    await pollOnce(mock);
    assert.equal(current(unk.sub).s, "unknown");
    assert.equal(current(unk.sub).r, "NON_EXISTENT_STATUS_CODE");
    assert.equal(returns(unk.sub), 0);

    // Submission with different provider (ozon) is not polled when active provider is mock
    const otherProvider = submitted(true, "ozon", `SNDMOCK_OTH_${n}`, true);
    mock.setTrackingStatus(otherProvider.code, "DELIVERED");
    await pollOnce(mock);
    assert.equal(current(otherProvider.sub).s, null);
    assert.equal(current(otherProvider.sub).r, null);
    assert.equal(events(otherProvider.sub), 0);
  } finally {
    delete process.env.MOCK_COURIER_PROFILE;
  }
});

