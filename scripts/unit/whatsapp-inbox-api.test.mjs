import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "../test-source.mjs";
import { createOrder } from "../fulfillment-fixtures.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-inbox-api-"));
process.env.DELIVERY_PROVIDER = "mock";
process.env.DB_PATH = path.join(dir, "crm.db");
process.env.UPLOAD_DIR = path.join(dir, "uploads");
process.env.AUTH_SECRET = "x".repeat(40);
process.env.CRM_PUBLIC_URL = "https://crm.example.test";
process.env.SECURITY_ALLOWED_ORIGINS = "https://crm.example.test";

const originalLoad = Module._load;
Module._load = function (name, ...args) {
  return name === "server-only" ? {} : originalLoad.call(this, name, ...args);
};

const { getDb } = loadSource("@/lib/db");
const conversationsService = loadSource("@/lib/services/whatsapp-conversations");
const staging = loadSource("@/lib/services/whatsapp-staging");
const settingsService = loadSource("@/lib/services/whatsapp-settings");
const customersService = loadSource("@/lib/services/customers");
const db = getDb();

// ---------------------------------------------------------------------------
// Auth mocking: every CRM route handler must call requireUser/requireAdmin and
// map AuthGuardError to its JSON response. The real guards need NextAuth, so
// route modules are loaded with the guards replaced (same contract as
// scripts/security-workflow.test.mjs).
// ---------------------------------------------------------------------------

class MockAuthGuardError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "AuthGuardError";
    this.status = status;
  }
  toResponse() {
    return Response.json({ error: this.message }, { status: this.status });
  }
}
let mockUser = null;
const guardsMock = {
  AuthGuardError: MockAuthGuardError,
  requireUser: async () => {
    if (!mockUser) throw new MockAuthGuardError(401, "Authentification requise.");
    return mockUser;
  },
  requireAdmin: async () => {
    if (!mockUser) throw new MockAuthGuardError(401, "Authentification requise.");
    if (mockUser.role !== "admin") {
      throw new MockAuthGuardError(403, "Accès réservé aux administrateurs.");
    }
    return mockUser;
  },
};

function loadRoute(name) {
  const previous = Module._load;
  Module._load = function (request, ...args) {
    return request === "@/lib/auth-guards" ? guardsMock : previous.call(this, request, ...args);
  };
  try {
    return loadSource(name);
  } finally {
    Module._load = previous;
  }
}

const routes = {
  conversations: loadRoute("@/app/api/crm/whatsapp/conversations/route"),
  conversation: loadRoute("@/app/api/crm/whatsapp/conversations/[id]/route"),
  reply: loadRoute("@/app/api/crm/whatsapp/conversations/[id]/reply/route"),
  takeover: loadRoute("@/app/api/crm/whatsapp/conversations/[id]/takeover/route"),
  read: loadRoute("@/app/api/crm/whatsapp/conversations/[id]/read/route"),
  block: loadRoute("@/app/api/crm/whatsapp/conversations/[id]/block/route"),
  linkOrder: loadRoute("@/app/api/crm/whatsapp/conversations/[id]/link-order/route"),
  media: loadRoute("@/app/api/crm/whatsapp/media/[messageId]/route"),
  outbox: loadRoute("@/app/api/crm/whatsapp/outbox/route"),
  resolve: loadRoute("@/app/api/crm/whatsapp/outbox/[id]/resolve/route"),
  proposal: loadRoute("@/app/api/crm/whatsapp/proposals/[id]/route"),
  requests: loadRoute("@/app/api/crm/whatsapp/requests/route"),
  request: loadRoute("@/app/api/crm/whatsapp/requests/[id]/route"),
  summary: loadRoute("@/app/api/crm/whatsapp/summary/route"),
  orderPanel: loadRoute("@/app/api/crm/orders/[id]/whatsapp/route"),
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const U_ADMIN = "user_admin_1";
const U_AGENT_A = "user_agent_a";
const U_AGENT_B = "user_agent_b";
const now = new Date().toISOString();
for (const [id, email, name, role] of [
  [U_ADMIN, "admin@test.example", "Admin", "admin"],
  [U_AGENT_A, "agent-a@test.example", "Agent A", "agent"],
  [U_AGENT_B, "agent-b@test.example", "Agent B", "agent"],
]) {
  db.prepare("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'x', ?, ?, ?)")
    .run(id, email, name, role, now);
}

const P1 = "+212612345678";
const P2 = "+212612345679";
const P3 = "+212612345670";
const P4 = "+212612345680";
const P5 = "+212612345681";
const P6 = "+212612345682";

const O1 = "AAA10001-1111-4000-8000-000000000001"; // P1, assigned to agent A
const O2 = "AAA20002-1111-4000-8000-000000000002"; // P2, assigned to agent B
const O3 = "AAA30003-1111-4000-8000-000000000003"; // P3, unassigned
const O4 = "AAA40004-1111-4000-8000-000000000004"; // P4, unassigned
const O5 = "AAA50005-1111-4000-8000-000000000005"; // P5, assigned to agent B (status_only link)
const O6 = "AAA60006-1111-4000-8000-000000000006"; // P6, unassigned (panel + draft)
const AMB1 = "AMBIGU01-1111-4000-8000-000000000091";
const AMB2 = "AMBIGU01-2222-4000-8000-000000000092";

function makeOrder(id, phone, assignedTo = null) {
  createOrder({
    id, customerName: "Cliente", customerPhone: phone, items: [],
    subtotal: 200, shipping: 0, total: 200,
  });
  if (assignedTo) db.prepare("UPDATE orders SET assigned_to = ? WHERE id = ?").run(assignedTo, id);
}
makeOrder(O1, P1, U_AGENT_A);
makeOrder(O2, P2, U_AGENT_B);
makeOrder(O3, P3);
makeOrder(O4, P4);
// O5 stays unassigned: it is linked status_only into conv1 and must not hand
// agent B access to conv1 (only its own order O2 does).
makeOrder(O5, P5);
makeOrder(O6, P6);
makeOrder(AMB1, "+212612345690");
makeOrder(AMB2, "+212612345690");

const conv1 = conversationsService.getOrCreateConversation(P1, null, null);
const conv2 = conversationsService.getOrCreateConversation(P2, null, null);
const conv3 = conversationsService.getOrCreateConversation(P3, null, null);
const conv4 = conversationsService.getOrCreateConversation(P4, null, null);
const conv6 = conversationsService.getOrCreateConversation(P6, null, null);
// O5 belongs to another phone: agent-verified status_only link into conv1.
db.prepare(
  "INSERT INTO wa_conversation_orders (conversation_id, order_id, access, linked_via, created_at) VALUES (?, ?, 'status_only', 'ref_last4', ?)",
).run(conv1.id, O5, now);

const AGENT_A = { id: U_AGENT_A, name: "Agent A", role: "agent" };
const AGENT_B = { id: U_AGENT_B, name: "Agent B", role: "agent" };
const ADMIN = { id: U_ADMIN, name: "Admin", role: "admin" };

const BASE = "https://crm.example.test";
function crmGet(query = "") {
  return new Request(`${BASE}${query}`);
}
function crmPost(body) {
  return new Request(`${BASE}/post`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function crmDelete() {
  return new Request(`${BASE}/delete`, { method: "DELETE" });
}

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("conversations list: auth, agent scoping, view filter and query validation", async () => {
  mockUser = null;
  assert.equal((await routes.conversations.GET()).status, 401);

  mockUser = AGENT_A;
  const agentList = await routes.conversations.GET(crmGet("/api/crm/whatsapp/conversations"));
  assert.equal(agentList.status, 200);
  const agentIds = (await agentList.json()).items.map((c) => c.id);
  assert.ok(agentIds.includes(conv1.id));
  assert.ok(agentIds.includes(conv3.id));
  assert.ok(agentIds.includes(conv4.id));
  assert.ok(!agentIds.includes(conv2.id)); // only linked to agent B's order

  const todo = await routes.conversations.GET(crmGet("/api/crm/whatsapp/conversations?view=todo"));
  assert.equal(todo.status, 200);
  assert.equal((await todo.json()).items.length, 0);

  mockUser = ADMIN;
  const adminList = await routes.conversations.GET(crmGet("/api/crm/whatsapp/conversations"));
  const adminIds = (await adminList.json()).items.map((c) => c.id);
  assert.ok(adminIds.includes(conv2.id));

  mockUser = AGENT_A;
  assert.equal((await routes.conversations.GET(crmGet("/api/crm/whatsapp/conversations?limit=101"))).status, 400);
  assert.equal((await routes.conversations.GET(crmGet("/api/crm/whatsapp/conversations?view=weird"))).status, 400);
});

test("conversation detail: access rules, message pagination and validation", async () => {
  const m1 = conversationsService.insertInboundMessage({ conversationId: conv3.id, waMessageId: "wa-msg-1", kind: "text", body: "salam", createdAt: "2026-10-29T09:00:00.000Z" });
  const m2 = conversationsService.insertInboundMessage({ conversationId: conv3.id, waMessageId: "wa-msg-2", kind: "text", body: "wach l commande", createdAt: "2026-10-29T09:01:00.000Z" });
  const m3 = conversationsService.insertInboundMessage({ conversationId: conv3.id, waMessageId: "wa-msg-3", kind: "text", body: "merci", createdAt: "2026-10-29T09:02:00.000Z" });

  mockUser = AGENT_A;
  const own = await routes.conversation.GET(crmGet(`/api/crm/whatsapp/conversations/${conv1.id}`), { params: Promise.resolve({ id: conv1.id }) });
  assert.equal(own.status, 200);
  assert.equal((await own.json()).conversation.id, conv1.id);

  // An agent cannot read a conversation linked only to another agent's orders.
  assert.equal((await routes.conversation.GET(crmGet(`/api/crm/whatsapp/conversations/${conv2.id}`), { params: Promise.resolve({ id: conv2.id }) })).status, 404);
  assert.equal((await routes.conversation.GET(crmGet("/api/crm/whatsapp/conversations/unknown-id"), { params: Promise.resolve({ id: "unknown-id" }) })).status, 404);

  mockUser = ADMIN;
  assert.equal((await routes.conversation.GET(crmGet(`/api/crm/whatsapp/conversations/${conv2.id}`), { params: Promise.resolve({ id: conv2.id }) })).status, 200);

  mockUser = AGENT_A;
  const page = await routes.conversation.GET(crmGet(`/api/crm/whatsapp/conversations/${conv3.id}?limit=2`), { params: Promise.resolve({ id: conv3.id }) });
  assert.equal(page.status, 200);
  const pageBody = await page.json();
  assert.equal(pageBody.messages.length, 2);
  assert.deepEqual(pageBody.messages.map((m) => m.id), [m2.id, m3.id]);

  const older = await routes.conversation.GET(crmGet(`/api/crm/whatsapp/conversations/${conv3.id}?before=${m2.id}&limit=10`), { params: Promise.resolve({ id: conv3.id }) });
  const olderBody = await older.json();
  assert.deepEqual(olderBody.messages.map((m) => m.id), [m1.id]);

  assert.equal((await routes.conversation.GET(crmGet(`/api/crm/whatsapp/conversations/${conv3.id}?limit=201`), { params: Promise.resolve({ id: conv3.id }) })).status, 400);
});

test("reply: auth, access, disabled, blocked, no_whatsapp, queued agent_reply with takeover", async () => {
  mockUser = null;
  assert.equal((await routes.reply.POST(crmPost({ text: "salam" }), { params: Promise.resolve({ id: conv1.id }) })).status, 401);

  mockUser = AGENT_B;
  assert.equal((await routes.reply.POST(crmPost({ text: "salam" }), { params: Promise.resolve({ id: conv1.id }) })).status, 404);

  mockUser = AGENT_A;
  // WhatsApp disabled by default -> 409, nothing queued.
  const disabled = await routes.reply.POST(crmPost({ text: "Bonjour" }), { params: Promise.resolve({ id: conv1.id }) });
  assert.equal(disabled.status, 409);
  assert.equal((await disabled.json()).error, "WhatsApp désactivé");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM wa_outbox WHERE conversation_id = ?").get(conv1.id).c, 0);

  settingsService.updateWhatsAppSettings({ enabled: true });

  const ok = await routes.reply.POST(crmPost({ text: "Bonjour, c'est l'équipe." }), { params: Promise.resolve({ id: conv1.id }) });
  assert.equal(ok.status, 202);
  assert.deepEqual(await ok.json(), { queued: true });

  const outboxRow = db.prepare("SELECT * FROM wa_outbox WHERE conversation_id = ?").get(conv1.id);
  assert.equal(outboxRow.purpose, "agent_reply");
  assert.equal(outboxRow.status, "queued");
  assert.equal(outboxRow.author_user_id, U_AGENT_A);
  assert.equal(outboxRow.body, "Bonjour, c'est l'équipe.");
  assert.equal(outboxRow.phone, P1);

  const after = conversationsService.getConversation(conv1.id);
  assert.equal(after.mode, "human");
  assert.equal(after.takenOverBy, U_AGENT_A);
  assert.ok(after.lastAgentReplyAt);
  assert.equal(after.unreadCount, 0);

  const contact = db.prepare("SELECT agent_id, channel, outcome FROM order_contacts WHERE order_id = ? AND channel = 'whatsapp'").get(O1);
  assert.equal(contact.agent_id, U_AGENT_A);
  assert.equal(contact.outcome, "note");

  // Validation
  assert.equal((await routes.reply.POST(crmPost({ text: "  " }), { params: Promise.resolve({ id: conv1.id }) })).status, 400);
  assert.equal((await routes.reply.POST(crmPost({ text: "x".repeat(2001) }), { params: Promise.resolve({ id: conv1.id }) })).status, 400);

  // Blocked phone -> 403
  customersService.blockPhone(P1, "Client injoignable", U_ADMIN);
  assert.equal((await routes.reply.POST(crmPost({ text: "Bonjour" }), { params: Promise.resolve({ id: conv1.id }) })).status, 403);
  customersService.unblockPhone(P1);

  // No WhatsApp -> 409
  conversationsService.markNoWhatsapp(P3);
  assert.equal((await routes.reply.POST(crmPost({ text: "Bonjour" }), { params: Promise.resolve({ id: conv3.id }) })).status, 409);

  // Second reply: same-day contact log dedupe, and status_only orders get no contact log.
  const contactsBefore = db.prepare("SELECT COUNT(*) AS c FROM order_contacts WHERE order_id = ?").get(O1).c;
  await routes.reply.POST(crmPost({ text: "Re-bonjour" }), { params: Promise.resolve({ id: conv1.id }) });
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM order_contacts WHERE order_id = ?").get(O1).c, contactsBefore);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM order_contacts WHERE order_id = ?").get(O5).c, 0);
});

test("takeover: take and release", async () => {
  mockUser = AGENT_A;
  const take = await routes.takeover.POST(crmPost(), { params: Promise.resolve({ id: conv3.id }) });
  assert.equal(take.status, 200);
  let conv = conversationsService.getConversation(conv3.id);
  assert.equal(conv.mode, "human");
  assert.equal(conv.takenOverBy, U_AGENT_A);

  const release = await routes.takeover.DELETE(crmDelete(), { params: Promise.resolve({ id: conv3.id }) });
  assert.equal(release.status, 200);
  conv = conversationsService.getConversation(conv3.id);
  assert.equal(conv.mode, "ai");
  assert.equal(conv.takenOverBy, null);

  assert.equal((await routes.takeover.POST(crmPost(), { params: Promise.resolve({ id: conv2.id }) })).status, 404);
  assert.equal((await routes.takeover.DELETE(crmDelete(), { params: Promise.resolve({ id: conv2.id }) })).status, 404);
});

test("read: marks unread as read", async () => {
  conversationsService.insertInboundMessage({ conversationId: conv3.id, waMessageId: "wa-read-1", kind: "text", body: "toujours là ?" });
  assert.ok(conversationsService.getConversation(conv3.id).unreadCount > 0);

  mockUser = AGENT_A;
  const res = await routes.read.POST(crmPost(), { params: Promise.resolve({ id: conv3.id }) });
  assert.equal(res.status, 200);
  assert.equal(conversationsService.getConversation(conv3.id).unreadCount, 0);
});

test("block: admin only, block and unblock with strikes cleared", async () => {
  mockUser = AGENT_A;
  assert.equal((await routes.block.POST(crmPost({ reason: "Client injoignable" }), { params: Promise.resolve({ id: conv1.id }) })).status, 403);

  mockUser = ADMIN;
  assert.equal((await routes.block.POST(crmPost({ reason: "ab" }), { params: Promise.resolve({ id: conv1.id }) })).status, 400);
  assert.equal((await routes.block.POST(crmPost({ reason: "Client injoignable" }), { params: Promise.resolve({ id: conv1.id }) })).status, 200);
  assert.ok(conversationsService.getConversation(conv1.id).blocked);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM blocked_phones WHERE phone = ?").get(P1).c, 1);

  db.prepare(
    "INSERT INTO wa_strikes (id, phone, points, reason_code, created_at, expires_at) VALUES (?, ?, 2, 'insult', ?, ?)",
  ).run("strike-block-1", P1, now, "2099-01-01T00:00:00.000Z");

  const unblock = await routes.block.DELETE(crmDelete(), { params: Promise.resolve({ id: conv1.id }) });
  assert.equal(unblock.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM blocked_phones WHERE phone = ?").get(P1).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM wa_strikes WHERE phone = ?").get(P1).c, 0);
  assert.ok(!conversationsService.getConversation(conv1.id).blocked);

  assert.equal((await routes.block.POST(crmPost({ reason: "Client injoignable" }), { params: Promise.resolve({ id: "unknown" }) })).status, 404);
});

test("link-order: any agent can link by ref or id, with validation", async () => {
  mockUser = AGENT_A;
  assert.equal((await routes.linkOrder.POST(crmPost({ orderRef: "AAA20002" }), { params: Promise.resolve({ id: conv2.id }) })).status, 404);

  // Link an unassigned order by explicit id.
  const byId = await routes.linkOrder.POST(crmPost({ orderId: O3 }), { params: Promise.resolve({ id: conv4.id }) });
  assert.equal(byId.status, 200);
  let conv = conversationsService.getConversation(conv4.id);
  assert.equal(conv.orders.find((o) => o.orderId === O3).access, "full");

  assert.equal((await routes.linkOrder.POST(crmPost({ orderRef: "ZZZZZZZZ" }), { params: Promise.resolve({ id: conv4.id }) })).status, 404);
  assert.equal((await routes.linkOrder.POST(crmPost({ orderRef: "AAA2000" }), { params: Promise.resolve({ id: conv4.id }) })).status, 400);
  assert.equal((await routes.linkOrder.POST(crmPost({ orderRef: "AMBIGU01" }), { params: Promise.resolve({ id: conv4.id }) })).status, 409);
  assert.equal((await routes.linkOrder.POST(crmPost({}), { params: Promise.resolve({ id: conv4.id }) })).status, 400);

  // Linking another agent's order by ref claims the conversation for that agent
  // (agent A loses access afterwards), so it must be this test's last action.
  const byRef = await routes.linkOrder.POST(crmPost({ orderRef: "aaa20002" }), { params: Promise.resolve({ id: conv4.id }) });
  assert.equal(byRef.status, 200);
  conv = conversationsService.getConversation(conv4.id);
  assert.deepEqual(conv.orders.find((o) => o.orderId === O2), { orderId: O2, ref: "AAA20002", access: "full", status: "new" });
});

test("media: access rules, expiry and traversal-safe serving", async () => {
  fs.mkdirSync(path.join(process.env.UPLOAD_DIR, "wa"), { recursive: true });
  const mediaBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR, "wa", "media-test.png"), mediaBytes);

  const msgId = "wa-media-msg-1";
  db.prepare(
    "INSERT INTO wa_messages (id, conversation_id, direction, author, kind, body, media_path, media_mime, created_at) VALUES (?, ?, 'in', 'customer', 'image', NULL, 'wa/media-test.png', 'image/png', ?)",
  ).run(msgId, conv1.id, now);

  mockUser = AGENT_B;
  assert.equal((await routes.media.GET(crmGet(`/api/crm/whatsapp/media/${msgId}`), { params: Promise.resolve({ messageId: msgId }) })).status, 404);

  mockUser = AGENT_A;
  const ok = await routes.media.GET(crmGet(`/api/crm/whatsapp/media/${msgId}`), { params: Promise.resolve({ messageId: msgId }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Content-Type"), "image/png");
  assert.equal(ok.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(ok.headers.get("Content-Disposition"), "inline");
  assert.equal(ok.headers.get("Cache-Control"), "private, max-age=300");
  assert.deepEqual(new Uint8Array(await ok.arrayBuffer()), mediaBytes);

  mockUser = ADMIN;
  assert.equal((await routes.media.GET(crmGet(`/api/crm/whatsapp/media/${msgId}`), { params: Promise.resolve({ messageId: msgId }) })).status, 200);

  db.prepare("UPDATE wa_messages SET media_deleted_at = ? WHERE id = ?").run(now, msgId);
  const expired = await routes.media.GET(crmGet(`/api/crm/whatsapp/media/${msgId}`), { params: Promise.resolve({ messageId: msgId }) });
  assert.equal(expired.status, 410);
  assert.equal((await expired.json()).error, "Média expiré (rétention)");
  db.prepare("UPDATE wa_messages SET media_deleted_at = NULL WHERE id = ?").run(msgId);

  const traversalId = "wa-media-msg-traversal";
  db.prepare(
    "INSERT INTO wa_messages (id, conversation_id, direction, author, kind, media_path, media_mime, created_at) VALUES (?, ?, 'in', 'customer', 'other', '../../etc/passwd', 'text/plain', ?)",
  ).run(traversalId, conv1.id, now);
  assert.equal((await routes.media.GET(crmGet(`/api/crm/whatsapp/media/${traversalId}`), { params: Promise.resolve({ messageId: traversalId }) })).status, 404);

  assert.equal((await routes.media.GET(crmGet("/api/crm/whatsapp/media/unknown-message"), { params: Promise.resolve({ messageId: "unknown-message" }) })).status, 404);
});

test("outbox: admin listing and uncertain resolution", async () => {
  mockUser = AGENT_A;
  assert.equal((await routes.outbox.GET(crmGet("/api/crm/whatsapp/outbox"))).status, 403);
  assert.equal((await routes.resolve.POST(crmPost({ resolution: "sent" }), { params: Promise.resolve({ id: "outbox-unc-1" }) })).status, 403);

  const t = new Date().toISOString();
  db.prepare(
    "INSERT INTO wa_outbox (id, dedupe_key, conversation_id, order_id, phone, purpose, kind, body, status, attempts, available_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'notify_confirmed', 'text', 'Votre commande est confirmée', 'uncertain', 1, ?, ?, ?)",
  ).run("outbox-unc-1", "dk-unc-1", conv1.id, O1, P1, t, t, t);
  db.prepare(
    "INSERT INTO wa_outbox (id, dedupe_key, phone, purpose, kind, body, status, attempts, available_at, last_error, created_at, updated_at) VALUES (?, ?, ?, 'ai_reply', 'text', 'test', 'failed', 10, ?, 'erreur', ?, ?)",
  ).run("outbox-fail-1", "dk-fail-1", P6, t, t, t);

  mockUser = ADMIN;
  const list = await routes.outbox.GET(crmGet("/api/crm/whatsapp/outbox"));
  assert.equal(list.status, 200);
  const ids = (await list.json()).items.map((i) => i.id);
  assert.ok(ids.includes("outbox-unc-1"));
  assert.ok(ids.includes("outbox-fail-1"));

  assert.equal((await routes.resolve.POST(crmPost({ resolution: "nope" }), { params: Promise.resolve({ id: "outbox-unc-1" }) })).status, 400);
  assert.equal((await routes.resolve.POST(crmPost({ resolution: "sent" }), { params: Promise.resolve({ id: "outbox-unknown" }) })).status, 404);

  const sent = await routes.resolve.POST(crmPost({ resolution: "sent" }), { params: Promise.resolve({ id: "outbox-unc-1" }) });
  assert.equal(sent.status, 200);
  const resolvedRow = db.prepare("SELECT status, resolved_by FROM wa_outbox WHERE id = ?").get("outbox-unc-1");
  assert.equal(resolvedRow.status, "sent");
  assert.equal(resolvedRow.resolved_by, U_ADMIN);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM wa_messages WHERE outbox_id = ?").get("outbox-unc-1").c, 1);

  assert.equal((await routes.resolve.POST(crmPost({ resolution: "sent" }), { params: Promise.resolve({ id: "outbox-unc-1" }) })).status, 409);

  db.prepare(
    "INSERT INTO wa_outbox (id, dedupe_key, conversation_id, phone, purpose, kind, body, status, attempts, available_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'notify_shipped', 'text', 'Votre colis est expédié', 'uncertain', 1, ?, ?, ?)",
  ).run("outbox-unc-2", "dk-unc-2", conv6.id, P6, t, t, t);

  const cancelled = await routes.resolve.POST(crmPost({ resolution: "cancel" }), { params: Promise.resolve({ id: "outbox-unc-2" }) });
  assert.equal(cancelled.status, 200);
  assert.equal(db.prepare("SELECT status FROM wa_outbox WHERE id = ?").get("outbox-unc-2").status, "cancelled");

  // Failed rows are not resolvable through the uncertain resolution endpoint.
  assert.equal((await routes.resolve.POST(crmPost({ resolution: "cancel" }), { params: Promise.resolve({ id: "outbox-fail-1" }) })).status, 409);
});

test("proposals: approve and reject map staging errors", async () => {
  const proposal = staging.createProposal({
    orderId: O3, conversationId: conv3.id, kind: "cancel",
    reason: "Client veut annuler", summary: "Demande d'annulation",
  });

  mockUser = AGENT_A;
  const approved = await routes.proposal.POST(crmPost({ action: "approve" }), { params: Promise.resolve({ id: proposal.id }) });
  assert.equal(approved.status, 200);
  const approvedBody = await approved.json();
  assert.equal(approvedBody.proposal.status, "approved");
  assert.equal(db.prepare("SELECT confirmation_status FROM orders WHERE id = ?").get(O3).confirmation_status, "cancelled");

  // Already decided -> 409 from StagingError
  assert.equal((await routes.proposal.POST(crmPost({ action: "approve" }), { params: Promise.resolve({ id: proposal.id }) })).status, 409);
  assert.equal((await routes.proposal.POST(crmPost({ action: "reject", note: "trop tard" }), { params: Promise.resolve({ id: proposal.id }) })).status, 409);
  assert.equal((await routes.proposal.POST(crmPost({ action: "approve" }), { params: Promise.resolve({ id: "prop_unknown" }) })).status, 404);

  const proposal2 = staging.createProposal({
    orderId: O1, conversationId: conv1.id, kind: "cancel",
    reason: "Client a annulé", summary: "Demande d'annulation",
  });
  mockUser = AGENT_A;
  const rejected = await routes.proposal.POST(crmPost({ action: "reject", note: "Client a confirmé au téléphone" }), { params: Promise.resolve({ id: proposal2.id }) });
  assert.equal(rejected.status, 200);
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.proposal.status, "rejected");
  assert.equal(rejectedBody.proposal.decidedBy, U_AGENT_A);

  assert.equal((await routes.proposal.POST(crmPost({ action: "bogus" }), { params: Promise.resolve({ id: proposal2.id }) })).status, 400);
});

test("requests: list open requests, convert and dismiss", async () => {
  db.prepare(
    "INSERT INTO wa_requests (id, conversation_id, phone, customer_name, items_json, city_name, address, status, created_at, updated_at) VALUES (?, ?, ?, 'Fatima', '[]', 'Casablanca', '12 rue Test', 'open', ?, ?)",
  ).run("req-1", conv4.id, P4, now, now);

  mockUser = AGENT_A;
  const list = await routes.requests.GET(crmGet("/api/crm/whatsapp/requests"));
  assert.equal(list.status, 200);
  assert.ok((await list.json()).requests.some((r) => r.id === "req-1"));

  const convert = await routes.request.POST(crmPost({ action: "convert", orderId: O4 }), { params: Promise.resolve({ id: "req-1" }) });
  assert.equal(convert.status, 200);
  assert.equal(db.prepare("SELECT status, order_id, handled_by FROM wa_requests WHERE id = ?").get("req-1").status, "converted");
  assert.equal(db.prepare("SELECT order_id FROM wa_requests WHERE id = ?").get("req-1").order_id, O4);

  assert.equal((await routes.request.POST(crmPost({ action: "convert", orderId: O4 }), { params: Promise.resolve({ id: "req-1" }) })).status, 409);
  assert.equal((await routes.request.POST(crmPost({ action: "dismiss" }), { params: Promise.resolve({ id: "req-1" }) })).status, 409);
  assert.equal((await routes.request.POST(crmPost({ action: "dismiss" }), { params: Promise.resolve({ id: "req-unknown" }) })).status, 404);

  db.prepare(
    "INSERT INTO wa_requests (id, conversation_id, phone, customer_name, items_json, status, created_at, updated_at) VALUES (?, ?, ?, null, '[]', 'open', ?, ?)",
  ).run("req-2", conv4.id, P4, now, now);
  // The request-status check runs before the order lookup: an open request with
  // an unknown order answers 404 (Commande introuvable).
  assert.equal((await routes.request.POST(crmPost({ action: "convert", orderId: "unknown-order" }), { params: Promise.resolve({ id: "req-2" }) })).status, 404);
  const dismiss = await routes.request.POST(crmPost({ action: "dismiss" }), { params: Promise.resolve({ id: "req-2" }) });
  assert.equal(dismiss.status, 200);
  assert.equal(db.prepare("SELECT status FROM wa_requests WHERE id = ?").get("req-2").status, "dismissed");
  assert.equal((await routes.request.POST(crmPost({ action: "nonsense" }), { params: Promise.resolve({ id: "req-2" }) })).status, 400);
});

test("summary: badge counts scoped by role and connection state", async () => {
  conversationsService.flagHandoff(conv1.id, "client mécontent");
  conversationsService.flagHandoff(conv2.id, "client mécontent");

  mockUser = AGENT_A;
  const agentSummary = await (await routes.summary.GET()).json();
  assert.equal(agentSummary.todo, 1); // conv1 only (conv2 belongs to agent B's order)
  assert.equal(agentSummary.uncertain, 0);
  assert.equal(agentSummary.pendingProposals, 0);
  assert.equal(agentSummary.openRequests, 0);
  assert.deepEqual(agentSummary.connection, { state: "unknown", updatedAt: null });

  mockUser = ADMIN;
  const adminSummary = await (await routes.summary.GET()).json();
  assert.equal(adminSummary.todo, 2);

  db.prepare(
    "INSERT INTO wa_outbox (id, dedupe_key, phone, purpose, kind, body, status, attempts, available_at, created_at, updated_at) VALUES (?, ?, ?, 'admin_alert', 'text', 'test', 'uncertain', 1, ?, ?, ?)",
  ).run("outbox-unc-3", "dk-unc-3", P6, now, now, now);
  staging.createProposal({
    orderId: O6, conversationId: conv6.id, kind: "cancel",
    reason: "Client a annulé", summary: "Demande d'annulation",
  });
  db.prepare(
    "INSERT INTO wa_requests (id, conversation_id, phone, customer_name, items_json, status, created_at, updated_at) VALUES (?, ?, ?, null, '[]', 'open', ?, ?)",
  ).run("req-3", conv6.id, P6, now, now);

  const adminSummary2 = await (await routes.summary.GET()).json();
  assert.equal(adminSummary2.uncertain, 1);
  assert.equal(adminSummary2.pendingProposals, 1);
  assert.equal(adminSummary2.openRequests, 1);
});

test("order panel: assigned-or-unassigned access, conversation, messages, draft, proposals and outbox", async () => {
  mockUser = AGENT_A;
  // O1 assigned to agent A -> allowed
  const panel = await routes.orderPanel.GET(crmGet(`/api/crm/orders/${O1}/whatsapp`), { params: Promise.resolve({ id: O1 }) });
  assert.equal(panel.status, 200);
  const panelBody = await panel.json();
  assert.equal(panelBody.conversation.id, conv1.id);
  assert.ok(Array.isArray(panelBody.messages));
  // Outbox rows for the order expose purpose, status and sentAt (the resolved
  // uncertain notify row from the outbox test is linked to O1).
  assert.ok(panelBody.outbox.some((r) => r.id === "outbox-unc-1" && r.purpose === "notify_confirmed" && r.status === "sent" && r.sentAt));
  assert.ok(panelBody.outbox.every((r) => "sentAt" in r));
  assert.equal(panelBody.proposals.length, 1); // rejected cancel proposal for O1

  // O2 assigned to agent B -> 404 for agent A
  assert.equal((await routes.orderPanel.GET(crmGet(`/api/crm/orders/${O2}/whatsapp`), { params: Promise.resolve({ id: O2 }) })).status, 404);

  // O6 unassigned -> allowed for agent A; draft + proposals present
  staging.upsertDraft(O6, conv6.id, { address: "12 rue Test, Casablanca", cityName: "Casablanca" });
  const panel6 = await routes.orderPanel.GET(crmGet(`/api/crm/orders/${O6}/whatsapp`), { params: Promise.resolve({ id: O6 }) });
  assert.equal(panel6.status, 200);
  const panel6Body = await panel6.json();
  assert.equal(panel6Body.conversation.id, conv6.id);
  assert.equal(panel6Body.draft.address, "12 rue Test, Casablanca");
  assert.equal(panel6Body.proposals.length, 1);

  mockUser = AGENT_B;
  // O6 unassigned -> allowed for agent B too, but its conversation is linked to no assigned order
  assert.equal((await routes.orderPanel.GET(crmGet(`/api/crm/orders/${O6}/whatsapp`), { params: Promise.resolve({ id: O6 }) })).status, 200);

  mockUser = ADMIN;
  assert.equal((await routes.orderPanel.GET(crmGet(`/api/crm/orders/${O2}/whatsapp`), { params: Promise.resolve({ id: O2 }) })).status, 200);

  assert.equal((await routes.orderPanel.GET(crmGet("/api/crm/orders/unknown-order/whatsapp"), { params: Promise.resolve({ id: "unknown-order" }) })).status, 404);
});
