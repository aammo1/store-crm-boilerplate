import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "../test-source.mjs";
import { genericProduct, orderFixture, upsellService } from "../order-operations-fixtures.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-staging-"));
process.env.DELIVERY_PROVIDER = "mock";
process.env.DB_PATH = path.join(dir, "crm.db");
process.env.UPLOAD_DIR = path.join(dir, "uploads");
process.env.AUTH_SECRET = "isolated-whatsapp-staging-test-secret-32-chars";
process.env.CRM_PUBLIC_URL = "https://crm.example.test";
process.env.SECURITY_ALLOWED_ORIGINS = "https://crm.example.test";

const originalLoad = Module._load;
Module._load = function (name, ...args) {
  return name === "server-only" ? {} : originalLoad.call(this, name, ...args);
};

const { getDb } = loadSource("@/lib/db");
const staging = loadSource("@/lib/services/whatsapp-staging");
const { getOrderEditState, editOrder } = loadSource("@/lib/services/order-edits");
const { getCrmOrder } = loadSource("@/lib/services/orders");
const { openStock } = loadSource("@/lib/services/inventory");
const { deriveOrderToken } = loadSource("@/lib/order-token");
const db = getDb();
const actor = { id: "agent-1", name: "Agent Test" };

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const now = new Date().toISOString();
db.prepare(`INSERT INTO users (id, email, password_hash, name, role, created_at)
  VALUES ('agent-1', 'agent@example.test', 'x', 'Agent Test', 'agent', ?)`).run(now);

for (const [product, price] of [["p", 300], ["other", 150]]) {
  genericProduct(db, product, price, [
    [`${product}-38`, [{ name: "Format", value: "XL" }]],
    [`${product}-39`, [{ name: "Format", value: "500 ml" }]],
  ]);
  for (const variant of [`${product}-38`, `${product}-39`]) openStock(variant, 20, actor.id);
}

db.prepare("INSERT INTO cities (id, name, arabic_name, updated_at, provider) VALUES (1, 'Casablanca', NULL, ?, 'mock')").run(now);
db.prepare("INSERT INTO cities (id, name, arabic_name, updated_at, provider) VALUES (2, 'Fès', NULL, ?, 'mock')").run(now);

for (const [id, phone] of [["conv1", "+212600000001"], ["conv2", "+212600000002"]]) {
  db.prepare("INSERT INTO wa_conversations (id, phone, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, phone, now, now);
}

const isStagingError = (status, message) => (err) =>
  err instanceof staging.StagingError && err.status === status && (message === undefined || err.message === message);

test("a draft on a confirmed, cancelled or archived order is rejected", () => {
  orderFixture(db, "d-locked", { variantId: "p-38" });
  assert.equal(staging.getDraft("d-locked"), null);
  db.prepare("UPDATE orders SET confirmation_status = 'confirmed' WHERE id = 'd-locked'").run();
  assert.throws(
    () => staging.upsertDraft("d-locked", null, { address: "12 rue des Oules, Casablanca" }),
    isStagingError(409, "Commande déjà confirmée ou annulée"),
  );
  assert.throws(() => staging.markReadyToConfirm("d-locked"), isStagingError(409));
  assert.equal(staging.getDraft("d-locked"), null);
  db.prepare("UPDATE orders SET confirmation_status = 'cancelled' WHERE id = 'd-locked'").run();
  assert.throws(() => staging.upsertDraft("d-locked", null, { note: "relancer" }), isStagingError(409));
  db.prepare("UPDATE orders SET confirmation_status = 'new', archived_at = ? WHERE id = 'd-locked'").run(now);
  assert.throws(() => staging.upsertDraft("d-locked", null, { note: "relancer" }), isStagingError(409));
  // Unknown order
  assert.throws(() => staging.upsertDraft("ghost", null, { note: "x" }), isStagingError(404));
  // Address bounds are enforced
  orderFixture(db, "d-bounds", { variantId: "p-38" });
  assert.throws(() => staging.upsertDraft("d-bounds", null, { address: "12 r" }), isStagingError(400));
  assert.throws(() => staging.upsertDraft("d-bounds", null, { address: "a".repeat(501) }), isStagingError(400));
});

test("city name resolution matches accents and 'ville de', keeps unknown names", () => {
  orderFixture(db, "d-city", { variantId: "p-38" });
  let draft = staging.upsertDraft("d-city", null, { cityName: "Fes" });
  assert.equal(draft.cityId, 2);
  assert.equal(draft.cityName, "Fès");
  draft = staging.upsertDraft("d-city", null, { cityName: "Ville de Fès" });
  assert.equal(draft.cityId, 2);
  draft = staging.upsertDraft("d-city", null, { cityName: "  casablanca  " });
  assert.equal(draft.cityId, 1);
  assert.equal(draft.cityName, "Casablanca");
  draft = staging.upsertDraft("d-city", null, { cityName: "Douar Inconnu" });
  assert.equal(draft.cityId, null);
  assert.equal(draft.cityName, "Douar Inconnu");
  assert.throws(() => staging.upsertDraft("d-city", null, { cityName: "x".repeat(81) }), isStagingError(400));
  // An invalid address patch does not clobber the collected city
  assert.throws(() => staging.upsertDraft("d-city", null, { address: "12 r" }), isStagingError(400));
  draft = staging.getDraft("d-city");
  assert.equal(draft.cityName, "Douar Inconnu");
  assert.equal(draft.address, null);
});

test("markReadyToConfirm reports missing fields, then flags the draft ready", () => {
  orderFixture(db, "d-ready", { variantId: "p-38" });
  assert.deepEqual(staging.markReadyToConfirm("d-ready"), { ok: false, missing: ["address", "city"] });
  staging.upsertDraft("d-ready", "conv1", { address: "12 rue des Oules" });
  assert.deepEqual(staging.markReadyToConfirm("d-ready"), { ok: false, missing: ["city"] });
  staging.upsertDraft("d-ready", "conv1", { cityName: "Fès", note: "Appeler après 18h" });
  assert.deepEqual(staging.markReadyToConfirm("d-ready"), { ok: true });
  const draft = staging.getDraft("d-ready");
  assert.equal(draft.readyToConfirm, true);
  assert.equal(draft.conversationId, "conv1");
  assert.equal(draft.note, "Appeler après 18h");
  // Clearing the city resets the flag
  staging.upsertDraft("d-ready", "conv1", { cityName: "Douar Inconnu" });
  assert.equal(staging.getDraft("d-ready").readyToConfirm, false);
  staging.clearDraft("d-ready");
  assert.equal(staging.getDraft("d-ready"), null);
});

test("edit proposal approval applies through editOrder; prices recomputed on the server", () => {
  orderFixture(db, "p-edit", { variantId: "p-38" });
  const proposal = staging.createProposal({
    orderId: "p-edit",
    conversationId: "conv1",
    kind: "edit",
    lines: [{ variantId: "p-39", qty: 2 }],
    summary: "Le client veut 2 pièces de 500 ml.",
  });
  assert.equal(proposal.status, "pending");
  // Staging rows hold no prices, only lines and the captured revision
  assert.deepEqual(Object.keys(proposal.payload).sort(), ["lines", "revision"]);

  const approved = staging.approveProposal(proposal.id, actor);
  assert.equal(approved.status, "approved");
  assert.equal(approved.decidedBy, "agent-1");
  assert.ok(approved.decidedAt);
  const order = getCrmOrder("p-edit");
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].variant_id, "p-39");
  assert.equal(order.items[0].quantity, 2);
  assert.equal(order.items[0].unit_price, 300);
  // 2 × 300 = 600 subtotal crosses the 400 MAD free-shipping threshold of the snapshot rules
  assert.equal(order.subtotal, 600);
  assert.equal(order.shipping, 0);
  assert.equal(order.total, 600);
  const edit = db.prepare(
    "SELECT actor_name, reason FROM order_edits WHERE order_id = 'p-edit' ORDER BY rowid DESC LIMIT 1",
  ).get();
  assert.equal(edit.reason, "Proposition WhatsApp approuvée");
  assert.equal(edit.actor_name, "Agent Test");
  // Approving twice is rejected
  assert.throws(() => staging.approveProposal(proposal.id, actor), isStagingError(409));
});

test("a stale revision gives a failed proposal and leaves the order untouched", () => {
  orderFixture(db, "p-stale", { variantId: "p-38" });
  const proposal = staging.createProposal({
    orderId: "p-stale",
    conversationId: null,
    kind: "edit",
    lines: [{ variantId: "p-39", qty: 1 }],
    summary: "Changer de format.",
  });
  // A concurrent agent edit invalidates the revision captured by the proposal
  const state = getOrderEditState("p-stale");
  editOrder("p-stale", {
    revision: state.revision,
    lines: [{ variantId: "other-38", qty: 1 }],
    discountType: "none",
    discountValue: 0,
    shippingMode: "auto",
    reason: "Ajuste agent",
  }, actor);
  assert.throws(() => staging.approveProposal(proposal.id, actor), isStagingError(409));
  const failed = staging.getProposal(proposal.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.resultNote, "Cette commande a changé. Rechargez la page avant de la modifier.");
  assert.equal(failed.decidedBy, "agent-1");
  const order = getCrmOrder("p-stale");
  assert.equal(order.items[0].variant_id, "other-38");
  assert.equal(order.total, 150 + 29);
});

test("a new proposal supersedes the pending one of the same kind only", () => {
  orderFixture(db, "p-supersede", { variantId: "p-38" });
  const first = staging.createProposal({
    orderId: "p-supersede", conversationId: null, kind: "edit",
    lines: [{ variantId: "p-39", qty: 1 }], summary: "Première proposition.",
  });
  const second = staging.createProposal({
    orderId: "p-supersede", conversationId: null, kind: "edit",
    lines: [{ variantId: "other-39", qty: 2 }], summary: "Le client a changé d'avis.",
  });
  assert.equal(staging.getProposal(first.id).status, "superseded");
  assert.equal(staging.getProposal(second.id).status, "pending");
  // A cancel proposal does not supersede the pending edit
  const cancel = staging.createProposal({
    orderId: "p-supersede", conversationId: null, kind: "cancel",
    reason: "Erreur de commande", summary: "Demande d'annulation.",
  });
  assert.equal(staging.getProposal(second.id).status, "pending");
  assert.equal(cancel.status, "pending");
  assert.equal(staging.listProposals("p-supersede").length, 3);
  assert.deepEqual(staging.listProposals("p-supersede", "superseded").map((p) => p.id), [first.id]);
  assert.equal(staging.listPendingProposals().filter((p) => p.orderId === "p-supersede").length, 2);
  // Rejection records the decision and the note
  const rejected = staging.rejectProposal(cancel.id, actor, "Client rappelé, garde sa commande");
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.resultNote, "Client rappelé, garde sa commande");
  // Invalid edit proposals are rejected with 400
  assert.throws(() => staging.createProposal({
    orderId: "p-supersede", conversationId: null, kind: "edit",
    lines: [{ variantId: "ghost", qty: 1 }], summary: "x",
  }), isStagingError(400));
  assert.throws(() => staging.createProposal({
    orderId: "p-supersede", conversationId: null, kind: "edit",
    lines: [{ variantId: "p-39", qty: 11 }], summary: "x",
  }), isStagingError(400));
});

test("cancel proposal approval cancels the order with the WhatsApp reason", () => {
  orderFixture(db, "p-cancel", { variantId: "p-38" });
  const proposal = staging.createProposal({
    orderId: "p-cancel", conversationId: "conv1", kind: "cancel",
    reason: "Le client a trouvé moins cher ailleurs", summary: "Demande d'annulation.",
  });
  const approved = staging.approveProposal(proposal.id, actor);
  assert.equal(approved.status, "approved");
  assert.equal(approved.resultNote, null);
  assert.equal(getCrmOrder("p-cancel").confirmationStatus, "cancelled");
  const contact = db.prepare(
    "SELECT note FROM order_contacts WHERE order_id = 'p-cancel' ORDER BY rowid DESC LIMIT 1",
  ).get();
  assert.ok(contact.note.includes("Demande client WhatsApp : Le client a trouvé moins cher ailleurs"));
  // A cancel proposal on an already cancelled order is rejected
  assert.throws(() => staging.createProposal({
    orderId: "p-cancel", conversationId: null, kind: "cancel", reason: "encore", summary: "x",
  }), isStagingError(409));
  // Edit proposals cannot be created on a cancelled order either
  assert.throws(() => staging.createProposal({
    orderId: "p-cancel", conversationId: null, kind: "edit",
    lines: [{ variantId: "p-38", qty: 1 }], summary: "x",
  }), (err) => err instanceof staging.StagingError && err.status === 409);
});

test("requests upsert per conversation, then convert or dismiss", () => {
  const first = staging.createRequest({
    conversationId: "conv1",
    phone: "+212600000001",
    items: [{ variantId: "p-38", qty: 1, label: "Produit p — XL" }],
    cityName: "Fès",
    address: "12 rue des Oules",
  });
  assert.equal(first.status, "open");
  assert.equal(first.cityName, "Fès");
  const updated = staging.createRequest({
    conversationId: "conv1",
    phone: "+212600000001",
    customerName: "Youssef",
    items: [{ variantId: "p-39", qty: 2, label: "Produit p — 500 ml" }],
  });
  assert.equal(updated.id, first.id);
  assert.equal(updated.customerName, "Youssef");
  assert.deepEqual(updated.items, [{ variantId: "p-39", qty: 2, label: "Produit p — 500 ml" }]);
  assert.equal(updated.cityName, null);
  assert.equal(staging.listOpenRequests().filter((r) => r.conversationId === "conv1").length, 1);

  const other = staging.createRequest({
    conversationId: "conv2",
    phone: "+212600000002",
    items: [{ variantId: "p-38", qty: 1, label: "Produit p — XL" }],
  });
  assert.notEqual(other.id, first.id);
  assert.equal(staging.listOpenRequests().length, 2);

  // Validation
  assert.throws(() => staging.createRequest({
    conversationId: "ghost", phone: "+212600000003",
    items: [{ variantId: "p-38", qty: 1, label: "x" }],
  }), isStagingError(404));
  assert.throws(() => staging.createRequest({
    conversationId: "conv2", phone: "+212600000002",
    items: [{ variantId: "ghost", qty: 1, label: "x" }],
  }), isStagingError(400));
  assert.throws(() => staging.createRequest({
    conversationId: "conv2", phone: "+212600000002",
    items: [{ variantId: "p-38", qty: 0, label: "x" }],
  }), isStagingError(400));
  assert.throws(() => staging.createRequest({
    conversationId: "conv2", phone: "+212600000002",
    items: [{ variantId: "p-38", qty: 1, label: "x".repeat(121) }],
  }), isStagingError(400));

  orderFixture(db, "req-order", { variantId: "p-38" });
  staging.convertRequest(first.id, "req-order", "agent-1");
  const converted = staging.getRequest(first.id);
  assert.equal(converted.status, "converted");
  assert.equal(converted.orderId, "req-order");
  assert.equal(converted.handledBy, "agent-1");
  staging.dismissRequest(other.id, "agent-1");
  assert.equal(staging.getRequest(other.id).status, "dismissed");
  assert.throws(() => staging.dismissRequest(other.id, "agent-1"), isStagingError(409));
  // A converted request frees the conversation slot for a new open request
  const again = staging.createRequest({
    conversationId: "conv1",
    phone: "+212600000001",
    items: [{ variantId: "p-38", qty: 1, label: "Produit p — XL" }],
  });
  assert.notEqual(again.id, first.id);
  assert.equal(staging.getRequest(first.id).status, "converted");
});

test("approving an edit proposal keeps the accepted upsell line and its discounted price", () => {
  orderFixture(db, "p-upsell", { variantId: "p-39", offerVariantId: "p-38" });
  upsellService(db).resolveUpsell("p-upsell", "request-accept", deriveOrderToken("p-upsell", "nonce-p-upsell"),
    { action: "accept", variantId: "p-38" });
  const before = getOrderEditState("p-upsell").snapshot;
  assert.equal(before.upsellItems.length, 1);
  assert.equal(before.upsellItems[0].unit_price, 210);

  const proposal = staging.createProposal({
    orderId: "p-upsell",
    conversationId: "conv1",
    kind: "edit",
    lines: [{ variantId: "p-39", qty: 2 }],
    summary: "Le client veut 2 pièces de 500 ml.",
  });
  assert.equal(staging.approveProposal(proposal.id, actor).status, "approved");

  const after = getOrderEditState("p-upsell").snapshot;
  assert.equal(after.items.length, 1);
  assert.equal(after.items[0].variant_id, "p-39");
  assert.equal(after.items[0].quantity, 2);
  assert.equal(after.upsellItems.length, 1);
  assert.equal(after.upsellItems[0].variant_id, "p-38");
  assert.equal(after.upsellItems[0].unit_price, 210);
  assert.equal(after.subtotal, 300 * 2 + 210);
  assert.equal(getCrmOrder("p-upsell").upsellStatus, "accepted");
});
