import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "../test-source.mjs";
import { genericProduct, orderFixture } from "../order-operations-fixtures.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-notify-"));
process.env.DELIVERY_PROVIDER = "mock";
process.env.DB_PATH = path.join(dir, "crm.db");
process.env.AUTH_SECRET = "x".repeat(40);
process.env.EVOLUTION_BASE_URL = "http://evolution.internal:8080";
process.env.EVOLUTION_INSTANCE = "test-instance";
process.env.EVOLUTION_API_KEY = "evolution-ephemeral-key";
process.env.WHATSAPP_WEBHOOK_SECRET = "w".repeat(40);
process.env.CRM_PUBLIC_URL = "https://crm.example.test";
process.env.SECURITY_ALLOWED_ORIGINS = "https://crm.example.test";

const originalLoad = Module._load;
Module._load = function (name, ...args) {
  return name === "server-only" ? {} : originalLoad.call(this, name, ...args);
};

const { getDb } = loadSource("@/lib/db");
const settingsService = loadSource("@/lib/services/whatsapp-settings");
const outbox = loadSource("@/lib/services/whatsapp-outbox");
const conversations = loadSource("@/lib/services/whatsapp-conversations");
const { confirmOrder, cancelOrder } = loadSource("@/lib/services/confirmation");
const { insertContact } = loadSource("@/lib/services/orders");
const { setDeliveryOutcome } = loadSource("@/lib/services/delivery-outcomes");
const { changeOrderLifecycle } = loadSource("@/lib/services/order-lifecycle");
const { drainSubmissions } = loadSource("@/lib/workers/submission");
const { createMockProvider } = loadSource("@/lib/shipping/mock");
const { openStock } = loadSource("@/lib/services/inventory");
const db = getDb();

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- fixtures

const now = new Date().toISOString();
db.prepare("INSERT INTO cities (id, name, updated_at, provider) VALUES (1, 'Casablanca', ?, 'mock')").run(now);
db.prepare("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('agent-1', 'agent@example.test', 'x', 'Salma', 'agent', ?)").run(now);
genericProduct(db, "prod-a", 300, [["var-a", []]]);
openStock("var-a", 50, "agent-1");

const ACTOR = { id: "agent-1", name: "Salma" };
const ADMIN_ACTOR = { id: ACTOR.id, role: "agent" };
const DELETE_ADMIN = { id: ACTOR.id, role: "admin" };
const CONFIRM_INPUT = { lines: [], address: "12 rue de test", cityId: 1 };
const BASE_PHONE = "+212612345678"; // phone used by orderFixture

const setSettings = (patch = {}) => settingsService.updateWhatsAppSettings(patch);
const outboxCount = () => db.prepare("SELECT COUNT(*) AS n FROM wa_outbox").get().n;
const rowByKey = (key) => db.prepare("SELECT * FROM wa_outbox WHERE dedupe_key = ?").get(key);
const countByKey = (key) => db.prepare("SELECT COUNT(*) AS n FROM wa_outbox WHERE dedupe_key = ?").get(key).n;

function makeOrder(id, phone = BASE_PHONE) {
  orderFixture(db, id, { productId: "prod-a", variantId: "var-a" });
  if (phone !== BASE_PHONE) {
    db.prepare("UPDATE orders SET customer_phone = ? WHERE id = ?").run(phone, id);
  }
  return id;
}

function noAnswer(orderId) {
  return insertContact({ orderId, agentId: ACTOR.id, channel: "phone", outcome: "no_answer" });
}

/** Backdates every no_answer contact of the order so spread checks are deterministic. */
function backdateNoAnswers(orderId, deltaMs) {
  db.prepare("UPDATE order_contacts SET created_at = ? WHERE order_id = ? AND outcome = 'no_answer'")
    .run(new Date(Date.now() + deltaMs).toISOString(), orderId);
}

const refOf = (orderId) => orderId.slice(0, 8).toUpperCase();

// ---------------------------------------------------------------- tests

test("with WhatsApp disabled (default), lifecycle hooks enqueue nothing and strike nothing", async () => {
  const id = makeOrder("ord-off");
  noAnswer(id);
  backdateNoAnswers(id, -3 * 3600_000);
  noAnswer(id); // would-be relance if enabled
  confirmOrder(id, CONFIRM_INPUT, ACTOR);
  await drainSubmissions(createMockProvider());
  setDeliveryOutcome(id, "refused", ADMIN_ACTOR, "agent");

  assert.equal(outboxCount(), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wa_strikes").get().n, 0);
});

test("enabled: confirmation enqueues one customer row plus one row per admin phone, once", () => {
  setSettings({ enabled: true, notificationsEnabled: true, adminPhones: ["+212700000001", "+212700000002"] });
  const id = makeOrder("ord-confirm");
  db.prepare("INSERT INTO wa_order_drafts (order_id, address, ready_to_confirm, updated_at) VALUES (?, 'brouillon', 0, ?)")
    .run(id, new Date().toISOString());

  confirmOrder(id, CONFIRM_INPUT, ACTOR);

  assert.equal(outboxCount(), 3);
  const customer = rowByKey(`order:${id}:confirmed`);
  assert.ok(customer, "customer row");
  assert.equal(customer.purpose, "notify_confirmed");
  assert.equal(customer.phone, BASE_PHONE);
  assert.ok(customer.body.includes(`#${refOf(id)}`));
  assert.ok(customer.body.includes("329 DH"));
  assert.ok(!customer.body.includes("12 rue"), "address never leaks");
  assert.equal(customer.order_id, id);

  for (const adminPhone of ["+212700000001", "+212700000002"]) {
    const admin = rowByKey(`admin:${id}:confirmed:${adminPhone}`);
    assert.ok(admin, `admin row ${adminPhone}`);
    assert.equal(admin.purpose, "admin_alert");
    assert.equal(admin.phone, adminPhone);
    assert.ok(admin.body.includes("Confirmée #"));
    assert.ok(admin.body.includes("Casablanca")); // city only
    assert.ok(admin.body.includes("par Salma"));
    assert.ok(!admin.body.includes("12 rue"), "address never leaks");
  }
  // The confirmation cleared the staged draft.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wa_order_drafts WHERE order_id = ?").get(id).n, 0);

  // Idempotent early return: a second confirmation enqueues nothing more.
  confirmOrder(id, CONFIRM_INPUT, ACTOR);
  assert.equal(outboxCount(), 3);

  // notificationsEnabled=false gates the customer message but not admin alerts.
  setSettings({ notificationsEnabled: false, adminPhones: ["+212700000001", "+212700000002"] });
  const id2 = makeOrder("ord-confirm-2", "+212600000099");
  confirmOrder(id2, CONFIRM_INPUT, ACTOR);
  assert.equal(rowByKey(`order:${id2}:confirmed`), undefined);
  assert.ok(rowByKey(`admin:${id2}:confirmed:+212700000001`));
});

test("enabled: parcel submission success enqueues one shipped row with tracking and suivi link", async () => {
  setSettings({ enabled: true, notificationsEnabled: true, adminPhones: [] });
  const id = makeOrder("ord-ship", "+212600000101");
  confirmOrder(id, CONFIRM_INPUT, ACTOR);

  await drainSubmissions(createMockProvider());

  const row = rowByKey(`order:${id}:shipped`);
  assert.ok(row, "shipped row");
  assert.equal(row.purpose, "notify_shipped");
  const submission = db.prepare("SELECT tracking_number FROM courier_submissions WHERE order_id = ?").get(id);
  assert.ok(submission.tracking_number);
  assert.ok(row.body.includes(submission.tracking_number));
  assert.ok(row.body.includes(`https://crm.example.test/suivi?ref=${refOf(id)}`));

  // A further drain (nothing due) never duplicates the notification.
  await drainSubmissions(createMockProvider());
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM wa_outbox WHERE order_id = ? AND purpose = 'notify_shipped'").get(id).n,
    1,
  );
});

test("enabled: delivered outcome enqueues one delivered row, no-op on repeat", async () => {
  setSettings({ enabled: true, notificationsEnabled: true, adminPhones: [] });
  const id = makeOrder("ord-deliv", "+212600000102");
  confirmOrder(id, CONFIRM_INPUT, ACTOR);
  await drainSubmissions(createMockProvider());

  setDeliveryOutcome(id, "delivered", ADMIN_ACTOR, "agent");
  const row = rowByKey(`order:${id}:delivered`);
  assert.ok(row, "delivered row");
  assert.equal(row.purpose, "notify_delivered");
  assert.ok(row.body.includes(`#${refOf(id)}`));

  // Same outcome again is a no-op write: no second enqueue attempt.
  setDeliveryOutcome(id, "delivered", ADMIN_ACTOR, "agent");
  assert.equal(countByKey(`order:${id}:delivered`), 1);
});

test("enabled: refused outcome alerts admins and strikes the customer, without a customer row", async () => {
  setSettings({ enabled: true, notificationsEnabled: true, adminPhones: ["+212700000001"] });
  const id = makeOrder("ord-refuse", "+212600000103");
  confirmOrder(id, CONFIRM_INPUT, ACTOR);
  await drainSubmissions(createMockProvider());

  setDeliveryOutcome(id, "refused", ADMIN_ACTOR, "agent");

  const admin = rowByKey(`admin:${id}:refused:+212700000001`);
  assert.ok(admin, "admin refused alert");
  assert.equal(admin.purpose, "admin_alert");
  assert.ok(admin.body.includes("Refusée #"));
  assert.ok(admin.body.includes("Casablanca"));
  assert.equal(rowByKey(`order:${id}:refused`), undefined, "no customer message on refusal");
  const strike = db.prepare("SELECT * FROM wa_strikes WHERE order_id = ? AND reason_code = 'refused_delivery'").get(id);
  assert.ok(strike, "refused_delivery strike");
  assert.equal(strike.phone, "+212600000103");
});

test("enabled: cancelling cancels queued confirmed/relance rows; toggle adds the customer message", () => {
  setSettings({ enabled: true, notificationsEnabled: true, adminPhones: [] });
  const id = makeOrder("ord-cancel", "+212600000104");
  confirmOrder(id, CONFIRM_INPUT, ACTOR); // queues notify_confirmed
  outbox.enqueueOutbox({
    dedupeKey: `order:${id}:relance`,
    phone: "+212600000104",
    purpose: "relance_no_answer",
    body: "relance",
    orderId: id,
  });

  cancelOrder(id, { reason: "Client a annulé" }, ACTOR);

  assert.equal(rowByKey(`order:${id}:confirmed`).status, "cancelled");
  assert.equal(rowByKey(`order:${id}:relance`).status, "cancelled");
  assert.equal(rowByKey(`order:${id}:cancelled`), undefined, "notifyCancelled is OFF by default");

  setSettings({ notifyCancelled: true });
  const id2 = makeOrder("ord-cancel-2", "+212600000105");
  confirmOrder(id2, CONFIRM_INPUT, ACTOR);
  cancelOrder(id2, { reason: "Autre motif" }, ACTOR);
  const cancelled = rowByKey(`order:${id2}:cancelled`);
  assert.ok(cancelled, "customer cancel message");
  assert.equal(cancelled.purpose, "notify_cancelled");
});

test("enabled: three cancellations after confirmation strike the phone once", () => {
  setSettings({ enabled: true, notificationsEnabled: true, adminPhones: [] });
  const phone = "+212600000106";
  for (let i = 1; i <= 3; i += 1) {
    const id = makeOrder(`ord-cancel-run-${i}`, phone);
    confirmOrder(id, CONFIRM_INPUT, ACTOR);
    cancelOrder(id, { reason: "Annulation" }, ACTOR);
    if (i < 3) {
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM wa_strikes WHERE phone = ? AND reason_code = 'repeated_cancel'").get(phone).n,
        0,
      );
    }
  }
  const strike = db.prepare("SELECT * FROM wa_strikes WHERE phone = ? AND reason_code = 'repeated_cancel'").get(phone);
  assert.ok(strike, "repeated_cancel strike after the 3rd cancel");
  assert.equal(strike.order_id, "ord-cancel-run-3");
  // The unique (order_id, reason) index keeps it at exactly one row.
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM wa_strikes WHERE phone = ? AND reason_code = 'repeated_cancel'").get(phone).n,
    1,
  );
});

test("enabled: two no_answer contacts 2h+ apart enqueue exactly one relance", () => {
  setSettings({ enabled: true, notificationsEnabled: true, adminPhones: [] });
  const id = makeOrder("ord-relance", "+212600000107");

  noAnswer(id);
  assert.equal(rowByKey(`order:${id}:relance`), undefined, "a single no_answer is not enough");
  backdateNoAnswers(id, -3 * 3600_000);
  noAnswer(id);

  const relance = rowByKey(`order:${id}:relance`);
  assert.ok(relance, "relance row");
  assert.equal(relance.purpose, "relance_no_answer");
  assert.equal(relance.phone, "+212600000107");
  assert.ok(relance.body.includes(`#${refOf(id)}`));

  // Further no_answer contacts never duplicate the relance.
  noAnswer(id);
  assert.equal(countByKey(`order:${id}:relance`), 1);
});

test("enabled: two no_answer contacts within an hour enqueue nothing", () => {
  setSettings({ enabled: true, notificationsEnabled: true, adminPhones: [] });
  const id = makeOrder("ord-relance-fast", "+212600000108");
  noAnswer(id);
  noAnswer(id);
  assert.equal(rowByKey(`order:${id}:relance`), undefined);
});

test("enabled: a customer who already wrote never receives a relance", () => {
  setSettings({ enabled: true, notificationsEnabled: true, adminPhones: [] });
  const id = makeOrder("ord-relance-wrote", "+212600000109");
  const conv = conversations.getOrCreateConversation("+212600000109", "212600000109@s.whatsapp.net", "Client");
  conversations.insertInboundMessage({
    conversationId: conv.id,
    waMessageId: "wamid-inbound-1",
    kind: "text",
    body: "salam, je veux ma commande",
  });

  noAnswer(id);
  backdateNoAnswers(id, -3 * 3600_000);
  noAnswer(id);
  assert.equal(rowByKey(`order:${id}:relance`), undefined);
});

test("customer copy follows the conversation language; admin alerts stay French", () => {
  setSettings({ enabled: true, notificationsEnabled: true, adminPhones: ["+212700000001"] });
  const id = makeOrder("ord-locale", "+212600000110");
  const conv = conversations.getOrCreateConversation("+212600000110", "212600000110@s.whatsapp.net", "Client");
  conversations.setLanguage(conv.id, "darija_arabic");

  confirmOrder(id, CONFIRM_INPUT, ACTOR);
  const customer = rowByKey(`order:${id}:confirmed`);
  assert.ok(/\p{Script=Arabic}/u.test(customer.body), "arabic copy for the customer");
  assert.ok(!/\p{Script=Arabic}/u.test(rowByKey(`admin:${id}:confirmed:+212700000001`).body), "french admin alert");
});

test("enabled: an automatic block after a refusal sends one deduplicated admin alert", async () => {
  setSettings({
    enabled: true,
    notificationsEnabled: true,
    adminPhones: ["+212700000001"],
    autoBlockEnabled: true,
  });
  const phone = "+212600000114";
  const id = makeOrder("ord-autoblock", phone);
  confirmOrder(id, CONFIRM_INPUT, ACTOR);
  await drainSubmissions(createMockProvider());
  // One prior strike point: refused_delivery (2 pts) then reaches the block threshold (3).
  db.prepare("INSERT INTO wa_strikes (id, phone, points, reason_code, created_at, expires_at) VALUES (?, ?, 1, 'spam_burst', ?, ?)")
    .run("seed-strike", phone, new Date().toISOString(), new Date(Date.now() + 90 * 86400_000).toISOString());

  setDeliveryOutcome(id, "refused", ADMIN_ACTOR, "agent");

  const blocked = db.prepare("SELECT * FROM blocked_phones WHERE phone = ?").get(phone);
  assert.ok(blocked, "phone auto-blocked");
  const alert = rowByKey(`admin:autoblock:${phone}:${new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Casablanca" }).format(new Date())}:+212700000001`);
  assert.ok(alert, "auto-block admin alert");
  assert.ok(alert.body.includes("bloqué"));
  assert.equal(countByKey(alert.dedupe_key), 1);
});

test("enabled: an automatic block alerts every admin phone once", async () => {
  setSettings({
    enabled: true,
    notificationsEnabled: true,
    adminPhones: ["+212700000001", "+212700000002"],
    autoBlockEnabled: true,
  });
  const phone = "+212600000115";
  const id = makeOrder("ord-autoblock-2", phone);
  confirmOrder(id, CONFIRM_INPUT, ACTOR);
  await drainSubmissions(createMockProvider());
  db.prepare("INSERT INTO wa_strikes (id, phone, points, reason_code, created_at, expires_at) VALUES (?, ?, 1, 'spam_burst', ?, ?)")
    .run("seed-strike-2", phone, new Date().toISOString(), new Date(Date.now() + 90 * 86400_000).toISOString());

  setDeliveryOutcome(id, "refused", ADMIN_ACTOR, "agent");

  const rows = db.prepare("SELECT phone, dedupe_key FROM wa_outbox WHERE dedupe_key LIKE ?").all(`admin:autoblock:${phone}:%`);
  assert.deepEqual(rows.map((r) => r.phone).sort(), ["+212700000001", "+212700000002"]);
  assert.equal(new Set(rows.map((r) => r.dedupe_key)).size, 2);
});

test("an outbox failure never breaks the confirmation", () => {
  setSettings({ enabled: true, notificationsEnabled: true, adminPhones: ["+212700000001"] });
  const id = makeOrder("ord-crash", "+212600000111");
  db.prepare("ALTER TABLE wa_outbox RENAME TO wa_outbox_broken").run();
  try {
    const result = confirmOrder(id, CONFIRM_INPUT, ACTOR);
    assert.equal(result.created, true);
    assert.equal(db.prepare("SELECT confirmation_status FROM orders WHERE id = ?").get(id).confirmation_status, "confirmed");
    assert.ok(db.prepare("SELECT 1 FROM courier_submissions WHERE order_id = ?").get(id), "submission still created");
    assert.ok(db.prepare("SELECT confirmation_status FROM orders WHERE id = ?").get(id));
  } finally {
    db.prepare("ALTER TABLE wa_outbox_broken RENAME TO wa_outbox").run();
  }
  // The outbox works again afterwards.
  assert.equal(
    outbox.enqueueOutbox({ dedupeKey: "post-crash", phone: "+212600000111", purpose: "ai_reply", body: "ok" }),
    true,
  );
});

test("archiving cancels queued rows; deleting removes WhatsApp rows with a clean FK check", () => {
  setSettings({ enabled: true, notificationsEnabled: true, adminPhones: [] });

  // Archive: queued notifications are cancelled.
  const archived = makeOrder("ord-arch", "+212600000112");
  outbox.enqueueOutbox({
    dedupeKey: `order:${archived}:confirmed`,
    phone: "+212600000112",
    purpose: "notify_confirmed",
    body: "confirmee",
    orderId: archived,
  });
  changeOrderLifecycle([archived], "archive", ADMIN_ACTOR);
  assert.equal(rowByKey(`order:${archived}:confirmed`).status, "cancelled");

  // Delete: every WhatsApp row tied to the order goes with it.
  const deleted = makeOrder("ord-del", "+212600000113");
  const conv = conversations.getOrCreateConversation("+212600000113", null, null);
  const stamp = new Date().toISOString();
  outbox.enqueueOutbox({
    dedupeKey: `order:${deleted}:confirmed`,
    phone: "+212600000113",
    purpose: "notify_confirmed",
    body: "confirmee",
    orderId: deleted,
  });
  db.prepare("INSERT INTO wa_order_drafts (order_id, ready_to_confirm, updated_at) VALUES (?, 0, ?)").run(deleted, stamp);
  db.prepare("INSERT INTO wa_proposals (id, order_id, kind, payload_json, summary, status, created_at) VALUES (?, ?, 'cancel', '{}', 'annulation', 'pending', ?)")
    .run(`prop-${deleted}`, deleted, stamp);
  db.prepare("INSERT INTO wa_requests (id, conversation_id, phone, items_json, status, order_id, created_at, updated_at) VALUES (?, ?, '+212600000113', '[]', 'converted', ?, ?, ?)")
    .run(`req-${deleted}`, conv.id, deleted, stamp, stamp);

  changeOrderLifecycle([deleted], "archive", ADMIN_ACTOR);
  changeOrderLifecycle([deleted], "delete", DELETE_ADMIN);

  for (const table of ["wa_outbox", "wa_conversation_orders", "wa_order_drafts", "wa_proposals"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE order_id = ?`).get(deleted).n, 0, table);
  }
  const request = db.prepare("SELECT order_id FROM wa_requests WHERE id = ?").get(`req-${deleted}`);
  assert.ok(request, "wa_requests row survives");
  assert.equal(request.order_id, null);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
});
