import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "../test-source.mjs";
import { createOrder } from "../fulfillment-fixtures.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-conversations-"));
process.env.DELIVERY_PROVIDER = "mock";
process.env.DB_PATH = path.join(dir, "crm.db");
process.env.AUTH_SECRET = "x".repeat(40);
process.env.CRM_PUBLIC_URL = "https://crm.example.test";
process.env.SECURITY_ALLOWED_ORIGINS = "https://crm.example.test";

const originalLoad = Module._load;
Module._load = function (name, ...args) {
  return name === "server-only" ? {} : originalLoad.call(this, name, ...args);
};

const { getDb } = loadSource("@/lib/db");
const svc = loadSource("@/lib/services/whatsapp-conversations");
const db = getDb();

const PHONE_C1 = "+212612345678"; // conversation C1 (typed as 0612345678)
const O1 = "AAA10001-1111-4000-8000-000000000001";
const O2 = "AAA10002-1111-4000-8000-000000000002";
const O3 = "AAA10003-1111-4000-8000-000000000003"; // archived
const O4 = "BBB20001-2222-4000-8000-000000000004";
const O5 = "CCC30001-3333-4000-8000-000000000005";
const O6 = "AAA10006-1111-4000-8000-000000000006";
const O7 = "DDD40001-4444-4000-8000-000000000007";
const U_ADMIN = "user_admin_1";
const U_AGENT_A = "user_agent_a";
const U_AGENT_B = "user_agent_b";

for (const [id, email, name, role] of [
  [U_ADMIN, "admin@test.example", "Admin", "admin"],
  [U_AGENT_A, "agent-a@test.example", "Agent A", "agent"],
  [U_AGENT_B, "agent-b@test.example", "Agent B", "agent"],
]) {
  db.prepare("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'x', ?, ?, ?)")
    .run(id, email, name, role, new Date().toISOString());
}

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeOrder(id, phone, opts = {}) {
  createOrder({ id, customerName: "Cliente Test", customerPhone: phone, items: [], subtotal: 200, shipping: 30, total: 230 });
  if (opts.assignedTo) db.prepare("UPDATE orders SET assigned_to = ? WHERE id = ?").run(opts.assignedTo, id);
  if (opts.archived) db.prepare("UPDATE orders SET archived_at = ? WHERE id = ?").run("2026-10-01T00:00:00.000Z", id);
}

function insertOutMessage(conversationId, author, body, createdAt, authorUserId = null) {
  const id = `out-${author}-${createdAt}`;
  db.prepare(`INSERT INTO wa_messages (id, conversation_id, direction, author, author_user_id, kind, body, created_at)
    VALUES (?, ?, 'out', ?, ?, 'text', ?, ?)`).run(id, conversationId, author, authorUserId, body, createdAt);
  return id;
}

// ---------------------------------------------------------------- conversations

test("getOrCreateConversation normalizes, reuses and auto-links phone-owned orders", () => {
  makeOrder(O1, PHONE_C1);
  makeOrder(O3, PHONE_C1, { archived: true });

  const c1 = svc.getOrCreateConversation("0612345678", "212612345678@s.whatsapp.net", "Sara B");
  assert.equal(c1.phone, PHONE_C1);
  assert.equal(c1.jid, "212612345678@s.whatsapp.net");
  assert.equal(c1.displayName, "Sara B");
  assert.equal(c1.mode, "ai");
  assert.equal(c1.needsHuman, false);
  assert.equal(c1.blocked, false);
  assert.equal(c1.language, null);
  // Auto-link at creation: non-archived order of the same phone, full access.
  assert.deepEqual(c1.orders.map((o) => o.orderId), [O1]);
  assert.equal(c1.orders[0].access, "full");
  assert.equal(c1.orders[0].ref, "AAA10001");

  // Reuse for the same phone in another format; display name is preserved.
  const again = svc.getOrCreateConversation("+212 612-345-678", null, null);
  assert.equal(again.id, c1.id);
  assert.equal(again.displayName, "Sara B");
});

test("auto-link re-runs on every getOrCreateConversation call (INSERT OR IGNORE)", () => {
  makeOrder(O2, PHONE_C1); // created after the conversation
  const c1 = svc.getOrCreateConversation(PHONE_C1, null, null);
  assert.deepEqual(c1.orders.map((o) => o.orderId), [O1, O2]);
  assert.ok(c1.orders.every((o) => o.access === "full"));
  const rows = db.prepare("SELECT linked_via FROM wa_conversation_orders WHERE conversation_id = ?").all(c1.id);
  assert.ok(rows.every((r) => r.linked_via === "phone"));
});

test("linkOrdersFromMessage: text without refs changes nothing", () => {
  const c1 = svc.getConversationByPhone(PHONE_C1);
  const r = svc.linkOrdersFromMessage(c1.id, "salam khouya, kdayr?");
  assert.deepEqual(r, { linked: [], failed: false, locked: false, newlyLocked: false });
  const row = db.prepare("SELECT identity_failures FROM wa_conversations WHERE id = ?").get(c1.id);
  assert.equal(row.identity_failures, 0);
});

test("ref from the order's own phone grants full access", () => {
  const c1 = svc.getConversationByPhone(PHONE_C1);
  makeOrder(O6, PHONE_C1); // not linked yet (created after auto-link calls)
  const r = svc.linkOrdersFromMessage(c1.id, "salam #AAA10006 fin wsalna ?");
  assert.deepEqual(r, { linked: [{ orderId: O6, access: "full" }], failed: false, locked: false, newlyLocked: false });
  const row = db.prepare("SELECT access, linked_via FROM wa_conversation_orders WHERE conversation_id = ? AND order_id = ?")
    .get(c1.id, O6);
  assert.equal(row.access, "full");
  assert.equal(row.linked_via, "ref_message");

  // Several refs in one message all link.
  const r2 = svc.linkOrdersFromMessage(c1.id, "mes commandes #AAA10006 et #AAA10001");
  assert.deepEqual(r2.linked.map((l) => l.orderId).sort(), [O1, O6]);
  assert.ok(r2.linked.every((l) => l.access === "full"));
});

test("ref + last 4 digits from another phone grants status_only", () => {
  const c1 = svc.getConversationByPhone(PHONE_C1);
  makeOrder(O4, "+212699887766"); // last 4: 7766
  const r = svc.linkOrdersFromMessage(c1.id, "#BBB20001 code 7766");
  assert.deepEqual(r, { linked: [{ orderId: O4, access: "status_only" }], failed: false, locked: false, newlyLocked: false });
  const row = db.prepare("SELECT access, linked_via FROM wa_conversation_orders WHERE conversation_id = ? AND order_id = ?")
    .get(c1.id, O4);
  assert.equal(row.access, "status_only");
  assert.equal(row.linked_via, "ref_last4");
  assert.equal(svc.orderAccess(c1.id, O4), "status_only");
});

test("ref alone from another phone fails and reveals nothing", () => {
  const c1 = svc.getConversationByPhone(PHONE_C1);
  makeOrder(O5, "+212655112233");
  const r = svc.linkOrdersFromMessage(c1.id, "#CCC30001");
  assert.deepEqual(r, { linked: [], failed: true, locked: false, newlyLocked: false });
  // Nothing was linked and no existence hint is leaked.
  assert.equal(svc.orderAccess(c1.id, O5), null);
  const row = db.prepare("SELECT identity_failures FROM wa_conversations WHERE id = ?").get(c1.id);
  assert.equal(row.identity_failures, 1);
});

test("3 failing messages lock identity checks for 24h; success resets the counter", () => {
  const c2 = svc.getOrCreateConversation("0611000002", null, null);
  makeOrder(O7, "+212611000002"); // same phone as c2, created after the conversation

  const t = (m) => new Date(`2026-10-29T08:0${m}:00.000Z`);
  const f1 = svc.linkOrdersFromMessage(c2.id, "#CCC30001", t(0));
  assert.equal(f1.failed, true);
  assert.equal(f1.locked, false);
  const f2 = svc.linkOrdersFromMessage(c2.id, "#CCC30001", t(1));
  assert.equal(f2.failed, true);
  assert.equal(f2.locked, false);

  // A successful link resets the failure counter.
  const ok = svc.linkOrdersFromMessage(c2.id, "#DDD40001", t(2));
  assert.deepEqual(ok.linked, [{ orderId: O7, access: "full" }]);
  assert.equal(ok.failed, false);
  let row = db.prepare("SELECT identity_failures FROM wa_conversations WHERE id = ?").get(c2.id);
  assert.equal(row.identity_failures, 0);

  const f3 = svc.linkOrdersFromMessage(c2.id, "#CCC30001", t(3));
  assert.equal(f3.locked, false);
  const f4 = svc.linkOrdersFromMessage(c2.id, "#CCC30001", t(4));
  assert.equal(f4.locked, false);

  // Third consecutive failure: 24h lock, counter reset, newlyLocked flag.
  const t6 = t(5);
  const f5 = svc.linkOrdersFromMessage(c2.id, "#CCC30001", t6);
  assert.equal(f5.failed, true);
  assert.equal(f5.locked, true);
  assert.equal(f5.newlyLocked, true);
  row = db.prepare("SELECT identity_failures, identity_locked_until FROM wa_conversations WHERE id = ?").get(c2.id);
  assert.equal(row.identity_failures, 0);
  assert.equal(row.identity_locked_until, new Date(t6.getTime() + 24 * 3600 * 1000).toISOString());

  // While locked, refs are not even looked up.
  const f6 = svc.linkOrdersFromMessage(c2.id, "#DDD40001", t(6)); // T6+1h, still locked
  assert.deepEqual(f6, { linked: [], failed: false, locked: true, newlyLocked: false });
  const locked = db.prepare("SELECT identity_locked_until FROM wa_conversations WHERE id = ?").get(c2.id);
  assert.equal(locked.identity_locked_until, new Date(t6.getTime() + 24 * 3600 * 1000).toISOString());
});

// ------------------------------------------------------------------- messages

test("duplicate wa_message_id is ignored; previews and unread counting", () => {
  const c1 = svc.getConversationByPhone(PHONE_C1);
  const longBody = "x".repeat(100);

  const first = svc.insertInboundMessage({
    conversationId: c1.id, waMessageId: "wamid.test-1", kind: "text", body: longBody,
    createdAt: "2026-10-29T10:00:00.000Z",
  });
  assert.equal(first.duplicate, false);
  let count = db.prepare("SELECT COUNT(*) AS n FROM wa_messages WHERE conversation_id = ?").get(c1.id).n;
  assert.equal(count, 1);

  const dup = svc.insertInboundMessage({
    conversationId: c1.id, waMessageId: "wamid.test-1", kind: "text", body: longBody,
    createdAt: "2026-10-29T10:00:01.000Z",
  });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.id, first.id);
  count = db.prepare("SELECT COUNT(*) AS n FROM wa_messages WHERE conversation_id = ?").get(c1.id).n;
  assert.equal(count, 1);

  let conv = svc.getConversation(c1.id);
  assert.equal(conv.unreadCount, 1);
  assert.equal(conv.lastPreview, "x".repeat(80));
  assert.equal(conv.lastInboundAt, "2026-10-29T10:00:00.000Z");

  const audio = svc.insertInboundMessage({
    conversationId: c1.id, waMessageId: "wamid.test-2", kind: "audio",
    createdAt: "2026-10-29T10:01:00.000Z",
  });
  conv = svc.getConversation(c1.id);
  assert.equal(conv.unreadCount, 2);
  assert.equal(conv.lastPreview, "🎤 Audio");

  svc.setMessageTranscript(audio.id, "Salam, fin wsalit commande dyali?");
  conv = svc.getConversation(c1.id);
  assert.equal(conv.lastPreview, "Salam, fin wsalit commande dyali?");
  const msg = db.prepare("SELECT transcript FROM wa_messages WHERE id = ?").get(audio.id);
  assert.equal(msg.transcript, "Salam, fin wsalit commande dyali?");

  svc.insertInboundMessage({
    conversationId: c1.id, waMessageId: "wamid.test-3", kind: "image",
    createdAt: "2026-10-29T10:02:00.000Z",
  });
  conv = svc.getConversation(c1.id);
  assert.equal(conv.unreadCount, 3);
  assert.equal(conv.lastPreview, "📷 Image");
});

test("listMessages returns newest-last with limit and before pagination", () => {
  const c1 = svc.getConversationByPhone(PHONE_C1);
  const all = svc.listMessages(c1.id);
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((m) => m.kind), ["text", "audio", "image"]);

  const lastTwo = svc.listMessages(c1.id, { limit: 2 });
  assert.deepEqual(lastTwo.map((m) => m.kind), ["audio", "image"]);

  const beforeImage = svc.listMessages(c1.id, { before: all[2].id });
  assert.deepEqual(beforeImage.map((m) => m.kind), ["text", "audio"]);
  assert.ok(beforeImage.every((m) => m.createdAt < all[2].createdAt));

  assert.equal(svc.listMessages(c1.id, { limit: 500 }).length, 3);
});

test("recentContext maps customer to user and agent/ai/system to assistant", () => {
  const c3 = svc.getOrCreateConversation("0611000003", null, null);
  svc.insertInboundMessage({
    conversationId: c3.id, waMessageId: "wamid.c3-1", kind: "text", body: "salam",
    createdAt: "2026-10-29T09:00:01.000Z",
  });
  insertOutMessage(c3.id, "ai", "Bonjour !", "2026-10-29T09:00:05.000Z");
  insertOutMessage(c3.id, "agent", "On vérifie votre commande.", "2026-10-29T09:00:09.000Z", U_AGENT_A);
  insertOutMessage(c3.id, "system", "Note interne", "2026-10-29T09:00:12.000Z");
  svc.insertInboundMessage({
    conversationId: c3.id, waMessageId: "wamid.c3-2", kind: "image",
    createdAt: "2026-10-29T09:00:15.000Z",
  });
  const audio = svc.insertInboundMessage({
    conversationId: c3.id, waMessageId: "wamid.c3-3", kind: "audio",
    createdAt: "2026-10-29T09:00:18.000Z",
  });
  svc.setMessageTranscript(audio.id, "Salam, fin wsaliti?");

  const ctx = svc.recentContext(c3.id, 20);
  assert.deepEqual(ctx.map((m) => m.role),
    ["user", "assistant", "assistant", "assistant", "user", "user"]);
  assert.deepEqual(ctx.map((m) => m.text),
    ["salam", "Bonjour !", "On vérifie votre commande.", "Note interne", "[image]", "Salam, fin wsaliti?"]);

  const lastTwo = svc.recentContext(c3.id, 2);
  assert.deepEqual(lastTwo.map((m) => m.text), ["[image]", "Salam, fin wsaliti?"]);
});

// ------------------------------------------------------------- simple setters

test("language, AI pause, read, agent reply and no-WhatsApp flags", () => {
  const c1 = svc.getConversationByPhone(PHONE_C1);
  svc.setLanguage(c1.id, "darija_latin");
  assert.equal(svc.getConversation(c1.id).language, "darija_latin");

  svc.pauseAi(c1.id, "2026-10-30T00:00:00.000Z");
  assert.equal(svc.getConversation(c1.id).aiPausedUntil, "2026-10-30T00:00:00.000Z");

  svc.markRead(c1.id);
  assert.equal(svc.getConversation(c1.id).unreadCount, 0);

  svc.noteAgentReply(c1.id, "2026-10-29T15:00:00.000Z");
  const conv = svc.getConversation(c1.id);
  assert.equal(conv.lastAgentReplyAt, "2026-10-29T15:00:00.000Z");
  assert.equal(conv.lastOutboundAt, "2026-10-29T15:00:00.000Z");

  // Unknown phone: creates the row flagged no_whatsapp.
  svc.markNoWhatsapp("0690000011");
  const nw = svc.getConversationByPhone("+212690000011");
  assert.ok(nw);
  assert.equal(nw.noWhatsapp, true);

  // Existing conversation: same row gets flagged.
  const c4 = svc.getOrCreateConversation("0611000004", null, null);
  svc.markNoWhatsapp("0611000004");
  const c4b = svc.getConversation(c4.id);
  assert.equal(c4b.id, c4.id);
  assert.equal(c4b.noWhatsapp, true);
});

test("flagHandoff, takeOver and releaseToAi lifecycle", () => {
  const c3 = svc.getConversationByPhone("+212611000003");

  svc.flagHandoff(c3.id, "réclamation client");
  let conv = svc.getConversation(c3.id);
  assert.equal(conv.mode, "human"); // AI stops replying
  assert.equal(conv.needsHuman, true);
  assert.equal(conv.handoffReason, "réclamation client");
  assert.equal(conv.takenOverBy, null);

  svc.takeOver(c3.id, U_AGENT_A);
  conv = svc.getConversation(c3.id);
  assert.equal(conv.mode, "human");
  assert.equal(conv.takenOverBy, U_AGENT_A);
  assert.ok(conv.takenOverAt);
  assert.equal(conv.needsHuman, false);
  assert.equal(conv.handoffReason, null);

  svc.releaseToAi(c3.id);
  conv = svc.getConversation(c3.id);
  assert.equal(conv.mode, "ai");
  assert.equal(conv.takenOverBy, null);
  assert.equal(conv.takenOverAt, null);
  assert.equal(conv.needsHuman, false);
});

// ------------------------------------------------------------- order contacts

test("logOrderContact dedupes per Africa/Casablanca calendar day", () => {
  const LG1 = "LOG00001-5555-4000-8000-000000000001";
  const LG2 = "LOG00002-5555-4000-8000-000000000002";
  const LG3 = "LOG00003-5555-4000-8000-000000000003";
  makeOrder(LG1, "+212644000001");
  makeOrder(LG2, "+212644000002");
  makeOrder(LG3, "+212644000003");
  const count = (orderId) =>
    db.prepare("SELECT COUNT(*) AS n FROM order_contacts WHERE order_id = ? AND channel = 'whatsapp'").get(orderId).n;

  svc.logOrderContact(LG1, U_AGENT_A, "WhatsApp : message client", new Date("2026-05-14T10:00:00.000Z"));
  assert.equal(count(LG1), 1);

  // Same Casablanca day (22:00 local) -> deduplicated.
  svc.logOrderContact(LG1, null, "WhatsApp : message client", new Date("2026-05-14T21:00:00.000Z"));
  assert.equal(count(LG1), 1);

  // Next Casablanca day -> a second row.
  svc.logOrderContact(LG1, U_AGENT_A, "WhatsApp : message client", new Date("2026-05-15T10:00:00.000Z"));
  assert.equal(count(LG1), 2);

  // Day boundary pinned to Africa/Casablanca (UTC+1 in May, outside any Ramadan shift),
  // not UTC: 23:30Z is already the next day locally, and 00:30Z the day after stays the same local day.
  svc.logOrderContact(LG2, null, "WhatsApp : message client", new Date("2026-05-14T23:30:00.000Z"));
  svc.logOrderContact(LG2, null, "WhatsApp : message client", new Date("2026-05-15T00:30:00.000Z"));
  assert.equal(count(LG2), 1);

  // Notes are stored with channel whatsapp, outcome note, and truncated to 500 chars.
  svc.logOrderContact(LG3, null, "n".repeat(600), new Date("2026-05-14T10:00:00.000Z"));
  const row = db.prepare("SELECT channel, outcome, note, agent_id FROM order_contacts WHERE order_id = ?").get(LG3);
  assert.equal(row.channel, "whatsapp");
  assert.equal(row.outcome, "note");
  assert.equal(row.note.length, 500);

  // Unknown order: ignored without throwing.
  svc.logOrderContact("NOPE0001-zzzz", null, "WhatsApp : message client");
  assert.equal(count("NOPE0001-zzzz"), 0);
});

// ------------------------------------------------------------- inbox scoping

const CA = "DAA00001-6666-4000-8000-000000000001"; // order assigned to agent A
const OB2 = "DAA00002-6666-4000-8000-000000000002"; // unassigned
const OC = "DAA00003-6666-4000-8000-000000000003"; // order assigned to agent B
let convA, convB, convC, convD;

test("agent visibility scoping, views, search and access checks", () => {
  makeOrder(CA, "+212622000001", { assignedTo: U_AGENT_A });
  makeOrder(OB2, "+212622000002");
  makeOrder(OC, "+212622000003", { assignedTo: U_AGENT_B });
  convA = svc.getOrCreateConversation("0622000001", null, null);
  convB = svc.getOrCreateConversation("0622000002", null, null);
  convC = svc.getOrCreateConversation("0622000003", null, null);
  convD = svc.getOrCreateConversation("0622000004", null, null); // no orders

  const ids = (page) => page.items.map((i) => i.id);
  const all = (filter) => svc.listConversations({ view: "all", limit: 100, ...filter });

  // Agents: linked orders assigned to them, plus conversations with no assigned order.
  const allA = ids(all({ userId: U_AGENT_A, role: "agent" }));
  assert.ok(allA.includes(convA.id));
  assert.ok(allA.includes(convB.id));
  assert.ok(allA.includes(convD.id));
  assert.ok(!allA.includes(convC.id));

  const allB = ids(all({ userId: U_AGENT_B, role: "agent" }));
  assert.ok(allB.includes(convB.id));
  assert.ok(allB.includes(convC.id));
  assert.ok(allB.includes(convD.id));
  assert.ok(!allB.includes(convA.id));

  // Admins see everything.
  const allAdmin = ids(all({ userId: U_ADMIN, role: "admin" }));
  for (const id of [convA.id, convB.id, convC.id, convD.id]) assert.ok(allAdmin.includes(id));

  // todo = needs_human only.
  svc.flagHandoff(convB.id, "attente agent");
  const todoA = ids(svc.listConversations({ view: "todo", userId: U_AGENT_A, role: "agent", limit: 100 }));
  assert.ok(todoA.includes(convB.id));
  assert.ok(!todoA.includes(convA.id));
  const todoAdmin = ids(svc.listConversations({ view: "todo", userId: U_ADMIN, role: "admin", limit: 100 }));
  assert.ok(todoAdmin.includes(convB.id));

  // mine = taken over by the user or a linked order assigned to the user.
  db.prepare("UPDATE orders SET assigned_to = ? WHERE id = ?").run(U_AGENT_A, OB2);
  svc.takeOver(convA.id, U_AGENT_A);
  const mineA = ids(svc.listConversations({ view: "mine", userId: U_AGENT_A, role: "agent", limit: 100 }));
  assert.ok(mineA.includes(convA.id));
  assert.ok(mineA.includes(convB.id));
  assert.ok(!mineA.includes(convC.id));
  const mineB = ids(svc.listConversations({ view: "mine", userId: U_AGENT_B, role: "agent", limit: 100 }));
  assert.ok(mineB.includes(convC.id));
  assert.ok(!mineB.includes(convA.id));

  // Search matches the phone digits and the display name.
  const byDigits = ids(all({ userId: U_ADMIN, role: "admin", q: "5678" }));
  assert.deepEqual(byDigits, [svc.getConversationByPhone(PHONE_C1).id]);
  const byName = ids(all({ userId: U_ADMIN, role: "admin", q: "Sara B" }));
  assert.ok(byName.includes(svc.getConversationByPhone(PHONE_C1).id));
  const shortQuery = ids(all({ userId: U_ADMIN, role: "admin", q: "Sara" }));
  assert.ok(shortQuery.includes(svc.getConversationByPhone(PHONE_C1).id));
  assert.deepEqual(ids(all({ userId: U_ADMIN, role: "admin", q: "inconnu-inexistant" })), []);

  // canAccessConversation mirrors the scoping rules.
  assert.equal(svc.canAccessConversation(convA.id, U_ADMIN, "admin"), true);
  assert.equal(svc.canAccessConversation(convC.id, U_ADMIN, "admin"), true);
  assert.equal(svc.canAccessConversation(convA.id, U_AGENT_A, "agent"), true);
  assert.equal(svc.canAccessConversation(convB.id, U_AGENT_A, "agent"), true);
  assert.equal(svc.canAccessConversation(convD.id, U_AGENT_A, "agent"), true);
  assert.equal(svc.canAccessConversation(convC.id, U_AGENT_A, "agent"), false);
  assert.equal(svc.canAccessConversation("inconnu", U_AGENT_A, "agent"), false);
});

test("listConversations paginates on updated_at|id cursor", () => {
  const p1 = svc.getOrCreateConversation("0633000001", null, null);
  const p2 = svc.getOrCreateConversation("0633000002", null, null);
  const p3 = svc.getOrCreateConversation("0633000003", null, null);
  // Future timestamps make these three the newest conversations.
  db.prepare("UPDATE wa_conversations SET updated_at = ? WHERE id = ?").run("2027-01-01T00:00:00.000Z", p1.id);
  db.prepare("UPDATE wa_conversations SET updated_at = ? WHERE id = ?").run("2026-12-01T00:00:00.000Z", p2.id);
  db.prepare("UPDATE wa_conversations SET updated_at = ? WHERE id = ?").run("2026-11-01T00:00:00.000Z", p3.id);

  const page1 = svc.listConversations({ view: "all", userId: U_ADMIN, role: "admin", limit: 2 });
  assert.deepEqual(page1.items.map((i) => i.id), [p1.id, p2.id]);
  assert.equal(page1.nextCursor, `2026-12-01T00:00:00.000Z|${p2.id}`);

  const page2 = svc.listConversations({
    view: "all", userId: U_ADMIN, role: "admin", limit: 2, cursor: page1.nextCursor,
  });
  // Older conversations (updated before the cursor) follow; the page never repeats p1/p2.
  assert.equal(page2.items[0].id, p3.id);
  assert.ok(!page2.items.some((i) => i.id === p1.id || i.id === p2.id));
  assert.notEqual(page2.nextCursor, page1.nextCursor);
});

// ------------------------------------------------------------------- extras

test("strikePoints counts only non-expired strikes; blocked comes from blocked_phones", () => {
  const c1 = svc.getConversationByPhone(PHONE_C1);
  db.prepare(`INSERT INTO wa_strikes (id, phone, points, reason_code, created_at, expires_at)
    VALUES ('st-active', ?, 2, 'insult', '2026-10-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z')`).run(c1.phone);
  db.prepare(`INSERT INTO wa_strikes (id, phone, points, reason_code, created_at, expires_at)
    VALUES ('st-expired', ?, 5, 'refused_delivery', '2025-12-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run(c1.phone);

  const conv = svc.getConversation(c1.id);
  assert.equal(conv.strikePoints, 2);
  assert.equal(conv.blocked, false);

  db.prepare("INSERT INTO blocked_phones (phone, reason, created_by, created_at) VALUES (?, ?, NULL, ?)")
    .run(c1.phone, "Comportement abusif", "2026-10-29T00:00:00.000Z");
  assert.equal(svc.getConversation(c1.id).blocked, true);
});

test("orderAccess and agent link", () => {
  const c1 = svc.getConversationByPhone(PHONE_C1);
  assert.equal(svc.orderAccess(c1.id, O5), null);
  svc.linkOrderByAgent(c1.id, O5);
  assert.equal(svc.orderAccess(c1.id, O5), "full");
  const row = db.prepare("SELECT access, linked_via FROM wa_conversation_orders WHERE conversation_id = ? AND order_id = ?")
    .get(c1.id, O5);
  assert.equal(row.access, "full");
  assert.equal(row.linked_via, "agent");

  assert.throws(() => svc.linkOrderByAgent(c1.id, "NOPE0001-zzzz"));
  assert.equal(svc.orderAccess(c1.id, "NOPE0001-zzzz"), null);
});

test("autoReleaseStale releases stale human conversations but not flagged ones", () => {
  const c4 = svc.getConversationByPhone("+212611000004");
  svc.takeOver(c4.id, U_AGENT_B);
  // Backdate so the conversation is stale at the fixed reference time.
  db.prepare("UPDATE wa_conversations SET taken_over_at = ?, last_agent_reply_at = NULL WHERE id = ?")
    .run("2026-10-28T00:00:00.000Z", c4.id);

  // A needs_human conversation with an old takeover timestamp must NOT be released.
  const cd = convD;
  db.prepare(`UPDATE wa_conversations
    SET mode = 'human', needs_human = 1, taken_over_at = '2026-10-28T00:00:00.000Z', last_agent_reply_at = NULL
    WHERE id = ?`).run(cd.id);

  const released = svc.autoReleaseStale(12, new Date("2026-10-29T12:00:00.000Z"));
  assert.ok(released >= 1);

  const c4After = svc.getConversation(c4.id);
  assert.equal(c4After.mode, "ai");
  assert.equal(c4After.takenOverBy, null);
  assert.equal(c4After.takenOverAt, null);

  // Still flagged -> untouched.
  assert.equal(svc.getConversation(cd.id).mode, "human");

  // Once the flag is cleared, the stale conversation is released.
  db.prepare("UPDATE wa_conversations SET needs_human = 0 WHERE id = ?").run(cd.id);
  svc.autoReleaseStale(12, new Date("2026-10-29T12:00:00.000Z"));
  assert.equal(svc.getConversation(cd.id).mode, "ai");
});
