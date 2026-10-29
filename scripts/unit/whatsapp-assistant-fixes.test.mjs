import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "../test-source.mjs";
import { createOrder } from "../fulfillment-fixtures.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-assistant-fixes-"));
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
const svc = loadSource("@/lib/services/whatsapp-conversations");
const promptModule = loadSource("@/lib/whatsapp/ai/prompt");
const db = getDb();

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
    if (!mockUser || mockUser.role !== "admin") throw new MockAuthGuardError(403, "Accès réservé aux administrateurs.");
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
  conversation: loadRoute("@/app/api/crm/whatsapp/conversations/[id]/route"),
  linkOrder: loadRoute("@/app/api/crm/whatsapp/conversations/[id]/link-order/route"),
  media: loadRoute("@/app/api/crm/whatsapp/media/[messageId]/route"),
  orderPanel: loadRoute("@/app/api/crm/orders/[id]/whatsapp/route"),
};

const ADMIN = { id: "user_admin_1", name: "Admin", role: "admin" };
db.prepare("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'x', ?, 'admin', ?)")
  .run(ADMIN.id, "admin@test.example", "Admin", new Date().toISOString());

const BASE = "https://crm.example.test";
const crmGet = (query = "") => new Request(`${BASE}${query}`);
const crmPost = (body) =>
  new Request(`${BASE}/post`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let phoneSeq = 0;
const nextPhone = () => `+2126100${String(++phoneSeq).padStart(5, "0")}`;
const last4 = (phone) => phone.slice(-4);

function makeOrder(id, phone) {
  createOrder({ id, customerName: "Cliente", customerPhone: phone, items: [], subtotal: 200, shipping: 0, total: 200 });
  return id;
}

function conversationFor(phone) {
  return svc.getOrCreateConversation(phone, null, null);
}

function failures(conversationId) {
  return db.prepare("SELECT identity_failures FROM wa_conversations WHERE id = ?").get(conversationId).identity_failures;
}

function insertOutbox(id, conversationId, phone, purpose, status, body, createdAt, extra = {}) {
  db.prepare(
    `INSERT INTO wa_outbox (id, dedupe_key, conversation_id, phone, purpose, kind, body, status, attempts, available_at, created_at, updated_at, last_error, author_user_id)
     VALUES (?, ?, ?, ?, ?, 'text', ?, ?, 0, ?, ?, ?, ?, ?)`,
  ).run(id, `dk-${id}`, conversationId, phone, purpose, body, status, createdAt, createdAt, createdAt, extra.lastError ?? null, extra.authorUserId ?? null);
}

// ---------------------------------------------------------------- order refs

test("identity: manual orders link through their derived ref, and `_` is never a wildcard", () => {
  const owner = nextPhone();
  const manualId = makeOrder("ord_K3xQ9zAbCdEf", owner);
  const lookalike = makeOrder("ABXCDEFG-1111-4000-8000-000000000001", nextPhone());
  assert.equal(
    loadSource("@/lib/whatsapp/phone").orderRefFromOrderId(manualId),
    "K3XQ9ZAB",
  );

  // The owner's conversation auto-links it; a stranger needs ref + last 4.
  const stranger = conversationFor(nextPhone());
  const miss = svc.linkOrdersFromMessage(stranger.id, "ref #K3XQ9ZAB");
  assert.deepEqual(miss.linked, []);
  assert.equal(miss.failed, true);
  const hit = svc.linkOrdersFromMessage(stranger.id, `ref #K3XQ9ZAB code ${last4(owner)}`);
  assert.deepEqual(hit.linked, [{ orderId: manualId, access: "status_only" }]);

  // "AB_CDEFG" must not match "ABXCDEFG-…" the way a LIKE pattern would.
  const probe = conversationFor(nextPhone());
  const wild = svc.linkOrdersFromMessage(probe.id, "ref #AB_CDEFG");
  assert.deepEqual(wild.linked, []);
  assert.equal(wild.failed, true);
  assert.equal(svc.orderAccess(probe.id, lookalike), null);
});

test("identity: only real ref candidates count as failed attempts", () => {
  const conv = conversationFor(nextPhone());
  const r = svc.linkOrdersFromMessage(conv.id, "Bonjour ma COMMANDE POURQUOI personne ne répond");
  assert.deepEqual(r, { linked: [], failed: false, locked: false, newlyLocked: false });
  assert.equal(failures(conv.id), 0);
});

test("identity: every unmatched ref in a message counts, even beside a ref that links", () => {
  const phone = nextPhone();
  const own = makeOrder("0AAA0001-1111-4000-8000-000000000001", phone);
  const conv = conversationFor(nextPhone());
  const ownerConv = conversationFor(phone);
  assert.equal(svc.orderAccess(ownerConv.id, own), "full");

  const first = svc.linkOrdersFromMessage(ownerConv.id, "#0AAA0001 #DEAD0001 #DEAD0002");
  assert.deepEqual(first.linked, [{ orderId: own, access: "full" }]);
  assert.equal(first.failed, true);
  assert.equal(failures(ownerConv.id), 2, "own ref does not launder the two guesses");

  const second = svc.linkOrdersFromMessage(ownerConv.id, "#0AAA0001 #DEAD0003");
  assert.equal(second.newlyLocked, true);
  assert.equal(second.locked, true);
  assert.equal(failures(ownerConv.id), 0);
  assert.ok(svc.getConversation(ownerConv.id).identityLockedUntil);

  // Three bad refs in one message lock at once.
  const burst = svc.linkOrdersFromMessage(conv.id, "#DEAD0001 #DEAD0002 #DEAD0003");
  assert.equal(burst.newlyLocked, true);
});

test("identity: a retried event links without counting its failed refs a second time", () => {
  const conv = conversationFor(nextPhone());
  const first = svc.linkOrdersFromMessage(conv.id, "#DEAD0001 #DEAD0002");
  assert.equal(first.failed, true);
  assert.equal(failures(conv.id), 2);

  const retry = svc.linkOrdersFromMessage(conv.id, "#DEAD0001 #DEAD0002", undefined, { countFailures: false });
  assert.equal(retry.failed, true);
  assert.equal(retry.newlyLocked, false);
  assert.equal(failures(conv.id), 2, "no double count on retry");

  const ownerPhone = nextPhone();
  const own = makeOrder("0CCC0001-1111-4000-8000-000000000001", ownerPhone);
  const ownerConv = conversationFor(ownerPhone);
  svc.linkOrdersFromMessage(ownerConv.id, "#DEAD0001");
  assert.equal(failures(ownerConv.id), 1);
  const ok = svc.linkOrdersFromMessage(ownerConv.id, "#0CCC0001", undefined, { countFailures: false });
  assert.deepEqual(ok.linked, [{ orderId: own, access: "full" }]);
  assert.equal(failures(ownerConv.id), 1, "retry never resets the counter either");
});

test("settings route: turning WhatsApp off cancels queued messages but keeps sending/uncertain rows", async () => {
  const outbox = loadSource("@/lib/services/whatsapp-outbox");
  const conv = conversationFor(nextPhone());
  const at = new Date().toISOString();
  insertOutbox("kill-q", conv.id, conv.phone, "notify_confirmed", "queued", "a", at);
  insertOutbox("kill-s", conv.id, conv.phone, "notify_confirmed", "sending", "b", at);
  insertOutbox("kill-u", conv.id, conv.phone, "notify_confirmed", "uncertain", "c", at);
  assert.equal(outbox.cancelAllQueued(), 1);
  const status = (id) => db.prepare("SELECT status, last_error FROM wa_outbox WHERE id = ?").get(id);
  assert.equal(status("kill-q").status, "cancelled");
  assert.match(status("kill-q").last_error, /WhatsApp désactivé/);
  assert.equal(status("kill-s").status, "sending");
  assert.equal(status("kill-u").status, "uncertain");
});

test("link-order route: manual order refs with _ or - are accepted and matched exactly", async () => {
  mockUser = ADMIN;
  const manualId = makeOrder("ord_aB_cdEfGhIj", nextPhone());
  const conv = conversationFor(nextPhone());
  const res = await routes.linkOrder.POST(crmPost({ orderRef: "ab_cdefg" }), { params: Promise.resolve({ id: conv.id }) });
  assert.equal(res.status, 200);
  assert.equal(svc.orderAccess(conv.id, manualId), "full");
  const wild = await routes.linkOrder.POST(crmPost({ orderRef: "ab%cdefg" }), { params: Promise.resolve({ id: conv.id }) });
  assert.equal(wild.status, 400);
});

// ---------------------------------------------------------------- lifecycle

test("autoReleaseStale keeps a fresh takeover even when an old agent reply exists", () => {
  const conv = conversationFor(nextPhone());
  svc.takeOver(conv.id, ADMIN.id);
  const takeoverAt = "2026-10-29T10:00:00.000Z";
  db.prepare("UPDATE wa_conversations SET taken_over_at = ?, last_agent_reply_at = ? WHERE id = ?")
    .run(takeoverAt, "2026-10-20T10:00:00.000Z", conv.id);

  assert.equal(svc.autoReleaseStale(12, new Date("2026-10-29T12:00:00.000Z")), 0);
  assert.equal(svc.getConversation(conv.id).mode, "human");

  svc.autoReleaseStale(12, new Date("2026-10-29T23:00:00.000Z"));
  assert.equal(svc.getConversation(conv.id).mode, "ai");
});

test("an inbound message clears the no_whatsapp flag", () => {
  const phone = nextPhone();
  svc.markNoWhatsapp(phone);
  assert.equal(svc.getConversationByPhone(phone).noWhatsapp, true);
  const conv = conversationFor(phone);
  svc.insertInboundMessage({ conversationId: conv.id, waMessageId: "nowa-1", kind: "text", body: "salam" });
  assert.equal(svc.getConversation(conv.id).noWhatsapp, false);
});

// ---------------------------------------------------------------- queued replies

test("recentContext includes queued ai/agent replies but not sent or cancelled rows", () => {
  const phone = nextPhone();
  const conv = conversationFor(phone);
  svc.insertInboundMessage({ conversationId: conv.id, waMessageId: "ctx-1", kind: "text", body: "question", createdAt: "2026-10-29T10:00:00.000Z" });
  insertOutbox("ob-ctx-queued", conv.id, phone, "ai_reply", "queued", "réponse en file", "2026-10-29T10:00:05.000Z");
  insertOutbox("ob-ctx-agent", conv.id, phone, "agent_reply", "sending", "réponse agent", "2026-10-29T10:00:06.000Z");
  insertOutbox("ob-ctx-cancelled", conv.id, phone, "ai_reply", "cancelled", "annulée", "2026-10-29T10:00:07.000Z");
  insertOutbox("ob-ctx-notify", conv.id, phone, "notify_confirmed", "queued", "notification", "2026-10-29T10:00:08.000Z");

  const context = svc.recentContext(conv.id);
  assert.deepEqual(
    context.map((c) => [c.role, c.text]),
    [
      ["user", "question"],
      ["assistant", "réponse en file"],
      ["assistant", "réponse agent"],
    ],
  );
  assert.deepEqual(svc.pendingOutboundReplies(conv.id).map((r) => r.author), ["ai", "agent"]);
});

test("conversation detail merges queued, failed and uncertain sends read-only", async () => {
  const phone = nextPhone();
  const conv = conversationFor(phone);
  svc.insertInboundMessage({ conversationId: conv.id, waMessageId: "det-1", kind: "text", body: "salam", createdAt: "2026-10-29T10:00:00.000Z" });
  insertOutbox("ob-det-queued", conv.id, phone, "agent_reply", "queued", "en file", "2026-10-29T10:01:00.000Z", { authorUserId: ADMIN.id });
  insertOutbox("ob-det-failed", conv.id, phone, "ai_reply", "failed", "échec", "2026-10-29T10:02:00.000Z", { lastError: "secret-token-xyz" });
  insertOutbox("ob-det-unc", conv.id, phone, "ai_reply", "uncertain", "incertain", "2026-10-29T10:03:00.000Z");
  insertOutbox("ob-det-cancelled", conv.id, phone, "ai_reply", "cancelled", "annulé", "2026-10-29T10:04:00.000Z");
  insertOutbox("ob-det-sent", conv.id, phone, "ai_reply", "sent", "déjà envoyé", "2026-10-29T10:05:00.000Z");
  db.prepare(
    "INSERT INTO wa_messages (id, conversation_id, direction, author, kind, body, outbox_id, created_at) VALUES ('msg-det-sent', ?, 'out', 'ai', 'text', 'déjà envoyé', 'ob-det-sent', '2026-10-29T10:05:00.000Z')",
  ).run(conv.id);

  mockUser = ADMIN;
  const res = await routes.conversation.GET(crmGet(`/api/crm/whatsapp/conversations/${conv.id}`), { params: Promise.resolve({ id: conv.id }) });
  assert.equal(res.status, 200);
  const { messages } = await res.json();
  assert.deepEqual(
    messages.map((m) => [m.id, m.status ?? null]),
    [
      [messages[0].id, null],
      ["outbox:ob-det-queued", "queued"],
      ["outbox:ob-det-failed", "failed"],
      ["outbox:ob-det-unc", "uncertain"],
      ["msg-det-sent", "sent"],
    ],
  );
  const queued = messages.find((m) => m.id === "outbox:ob-det-queued");
  assert.equal(queued.direction, "out");
  assert.equal(queued.author, "agent");
  assert.equal(queued.body, "en file");
  assert.ok(!JSON.stringify(messages).includes("secret-token-xyz"), "outbox error text is never exposed");
  assert.equal(db.prepare("SELECT status FROM wa_outbox WHERE id = 'ob-det-failed'").get().status, "failed");

  // Older pages never carry unsent rows.
  const older = svc.listMessages(conv.id, { before: "msg-det-sent", includeUnsent: true });
  assert.ok(older.every((m) => !m.id.startsWith("outbox:")));
});

test("order panel prefers the owner's full-access conversation over a status-only one", async () => {
  const ownerPhone = nextPhone();
  const order = makeOrder("0BBB0001-1111-4000-8000-000000000001", ownerPhone);
  const ownerConv = conversationFor(ownerPhone);
  const thirdConv = conversationFor(nextPhone());
  db.prepare("INSERT INTO wa_conversation_orders (conversation_id, order_id, access, linked_via, created_at) VALUES (?, ?, 'status_only', 'ref_last4', ?)")
    .run(thirdConv.id, order, new Date().toISOString());
  db.prepare("UPDATE wa_conversations SET updated_at = '2026-10-01T00:00:00.000Z' WHERE id = ?").run(ownerConv.id);
  db.prepare("UPDATE wa_conversations SET updated_at = '2026-10-29T00:00:00.000Z' WHERE id = ?").run(thirdConv.id);

  mockUser = ADMIN;
  const res = await routes.orderPanel.GET(crmGet(`/api/crm/orders/${order}/whatsapp`), { params: Promise.resolve({ id: order }) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).conversation.id, ownerConv.id);
});

test("media route serves only wa/ files and answers 404 for URL-valued media paths", async () => {
  const conv = conversationFor(nextPhone());
  fs.mkdirSync(path.join(process.env.UPLOAD_DIR, "wa"), { recursive: true });
  fs.mkdirSync(path.join(process.env.UPLOAD_DIR, "products"), { recursive: true });
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR, "wa", "ok.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR, "products", "other.png"), new Uint8Array([1, 2, 3]));
  const insert = (id, mediaPath) =>
    db.prepare(
      "INSERT INTO wa_messages (id, conversation_id, direction, author, kind, media_path, media_mime, created_at) VALUES (?, ?, 'out', 'ai', 'image', ?, 'image/png', ?)",
    ).run(id, conv.id, mediaPath, new Date().toISOString());
  insert("media-ok", "wa/ok.png");
  insert("media-url", "https://cdn.example.test/product.jpg");
  insert("media-other-family", "products/other.png");

  mockUser = ADMIN;
  const get = (id) => routes.media.GET(crmGet(`/api/crm/whatsapp/media/${id}`), { params: Promise.resolve({ messageId: id }) });
  assert.equal((await get("media-ok")).status, 200);
  assert.equal((await get("media-url")).status, 404);
  assert.equal((await get("media-other-family")).status, 404);
});

// ---------------------------------------------------------------- prompt

test("system prompt tells the AI to list several orders (ref, date, stage) and ask which one", () => {
  const prompt = promptModule.buildSystemPrompt({
    storeName: "Boutique",
    assistantName: "Assistant",
    language: "fr",
    faqText: "",
    nowCasablanca: "29/10/2026 10:00",
    orders: [
      { ref: "AAA10001", access: "full" },
      { ref: "BBB20002", access: "full" },
    ],
    catalogEnabled: false,
    orderEditProposalsEnabled: false,
    crossSellEnabled: false,
  });
  assert.ok(prompt.includes("PLUSIEURS COMMANDES"));
  assert.ok(prompt.includes("la référence courte, la date et l'étape"));
  assert.ok(prompt.includes("demande de laquelle il s'agit"));
});
