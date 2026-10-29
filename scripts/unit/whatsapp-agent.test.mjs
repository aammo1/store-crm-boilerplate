import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { loadSource } from "../test-source.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-agent-"));
process.env.DELIVERY_PROVIDER = "mock";
process.env.DB_PATH = path.join(dir, "crm.db");
process.env.AUTH_SECRET = "x".repeat(40);
process.env.CRM_PUBLIC_URL = "https://crm.example.test";
process.env.SECURITY_ALLOWED_ORIGINS = "https://crm.example.test";
process.env.EVOLUTION_BASE_URL = "http://evolution.internal:8080";
process.env.EVOLUTION_INSTANCE = "test-instance";
process.env.EVOLUTION_API_KEY = "evolution-ephemeral-key";
process.env.WHATSAPP_WEBHOOK_SECRET = "w".repeat(40);
process.env.OPENROUTER_API_KEY = "or-ephemeral-test-key-1234567890";

const originalLoad = Module._load;
Module._load = function (name, ...args) {
  return name === "server-only" ? {} : originalLoad.call(this, name, ...args);
};

const { getDb } = loadSource("@/lib/db");
const settings = loadSource("@/lib/services/whatsapp-settings");
const usage = loadSource("@/lib/services/whatsapp-ai-usage");
const conversations = loadSource("@/lib/services/whatsapp-conversations");
const staging = loadSource("@/lib/services/whatsapp-staging");
const toolsModule = loadSource("@/lib/whatsapp/ai/tools");
const agentModule = loadSource("@/lib/whatsapp/ai/agent");
const providerModule = loadSource("@/lib/whatsapp/ai/provider");
const db = getDb();

const CHAT_MODEL = "z-ai/glm-5.3-flash";
const CHAT_FALLBACK = "deepseek/deepseek-v4.1-flash";

// ---------------------------------------------------------------------------
// fetch stub: each queued handler answers one call; extra calls fail loudly.
// ---------------------------------------------------------------------------
let fetchCalls = [];
let fetchQueue = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init });
  const handler = fetchQueue.shift();
  if (!handler) throw new Error("Stub fetch: appel OpenRouter inattendu");
  return handler(url, init);
};

const jsonOk = (payload) =>
  new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });

const chatCompletion = (content, usageExtra = {}) =>
  jsonOk({
    id: "gen_test",
    object: "chat.completion",
    created: 0,
    model: CHAT_MODEL,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, ...usageExtra },
  });

const toolCallCompletion = (calls, usageExtra = {}) =>
  jsonOk({
    id: "gen_test",
    object: "chat.completion",
    created: 0,
    model: CHAT_MODEL,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map((c, i) => ({
            id: `call_${i}`,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, ...usageExtra },
  });

const requestBody = (call) => JSON.parse(call.init.body);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const now = new Date().toISOString();

db.prepare(
  "INSERT INTO cities (id, name, arabic_name, provider, updated_at) VALUES (1, 'Casablanca', 'الدار البيضاء', 'mock', ?)",
).run(now);
db.prepare(
  "INSERT INTO products (id, slug, name, category, price, created_at, updated_at) VALUES ('p1', 'tshirt-amazigh', 'T-shirt Amazigh', 'Vêtements', 149, ?, ?)",
).run(now, now);
db.prepare(
  "INSERT INTO variants (id, product_id, label, options_json, options_key, sku) VALUES ('v1', 'p1', 'Taille M', ?, ?, 'SKU1')",
).run(JSON.stringify([{ name: "Taille", value: "M" }]), JSON.stringify([["Taille", "M"]]));
db.prepare(
  "INSERT INTO variants (id, product_id, label, options_json, options_key, sku) VALUES ('v2', 'p1', 'Taille L', ?, ?, 'SKU2')",
).run(JSON.stringify([{ name: "Taille", value: "L" }]), JSON.stringify([["Taille", "L"]]));
// v1: 10 in stock. v2: 0 available (5 reserved out of 5 physical).
db.prepare("INSERT INTO stock_balances (variant_id, location, physical, reserved, quarantine) VALUES ('v1', 'MAIN', 10, 0, 0)").run();
db.prepare("INSERT INTO stock_balances (variant_id, location, physical, reserved, quarantine) VALUES ('v2', 'MAIN', 5, 5, 0)").run();
db.prepare(
  "INSERT INTO product_packs (id, product_id, quantity, price_mad, label, highlight, active, created_at, updated_at) VALUES ('pack1', 'p1', 2, 249, NULL, 0, 1, ?, ?)",
).run(now, now);

const itemsJson = JSON.stringify([
  { product_id: "p1", variant_id: "v1", sku: "SKU1", name: "T-shirt Amazigh", variant_label: "Taille M", options: [{ name: "Taille", value: "M" }], quantity: 2, unit_price: 149, line_total: 298 },
]);

function insertOrder(id, customerPhone, status) {
  db.prepare(
    `INSERT INTO orders (id, customer_name, customer_phone, items_json, upsell_status, subtotal, shipping, total, currency, created_at, updated_at, confirmation_status)
     VALUES (?, 'Client Test', ?, ?, 'closed', 298, 29, 327, 'MAD', ?, ?, ?)`,
  ).run(id, customerPhone, itemsJson, now, now, status);
}

// A: full access, new. B: status_only (different phone). C: full access, confirmed.
insertOrder("AAAA1111-order-a", "+212612345678", "new");
insertOrder("BBBB2222-order-b", "+212699991234", "confirmed");
insertOrder("CCCC3333-order-c", "+212612345678", "confirmed");

const conv = conversations.getOrCreateConversation("+212612345678", "212612345678@s.whatsapp.net", "Client Test");
const convId = conv.id;

// Link B with status_only via ref + last 4 digits of its phone.
conversations.linkOrdersFromMessage(convId, "Ma commande #BBBB2222 1234");

conversations.insertInboundMessage({ conversationId: convId, waMessageId: "wa-1", kind: "text", body: "Salam, ça va ?" });
conversations.insertInboundMessage({ conversationId: convId, waMessageId: "wa-2", kind: "text", body: "Où en est ma commande ?" });

function enableAi(extra = {}) {
  settings.updateWhatsAppSettings({ enabled: true, aiEnabled: true, aiDailyBudgetCents: 100, ...extra });
}

function resetConversation() {
  db.prepare(
    "UPDATE wa_conversations SET mode = 'ai', needs_human = 0, handoff_reason = NULL, taken_over_by = NULL, taken_over_at = NULL WHERE id = ?",
  ).run(convId);
  db.prepare("DELETE FROM wa_proposals").run();
  db.prepare("DELETE FROM wa_requests").run();
  db.prepare("DELETE FROM wa_order_drafts").run();
}

function spendBudgetFully() {
  usage.recordAiUsage({
    role: "chat",
    model: CHAT_MODEL,
    inputTokens: 0,
    outputTokens: 0,
    costMicroUsd: 100 * 10_000, // exactly the 100-cent daily cap
  });
}

after(() => {
  globalThis.fetch = originalFetch;
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fetchCalls = [];
  fetchQueue = [];
  db.prepare("DELETE FROM wa_ai_usage").run();
  enableAi();
  resetConversation();
});

// ---------------------------------------------------------------------------
// Tool-level tests (direct execute, no LLM needed)
// ---------------------------------------------------------------------------

test("orderStatus on an unlinked ref returns not_linked", async () => {
  const ctx = { conversationId: convId, phone: "+212612345678", toolCalls: [] };
  const tools = toolsModule.createWhatsAppTools(ctx);
  const result = await tools.orderStatus.execute({ ref: "ZZZZ9999" });
  assert.deepEqual(result, { error: "not_linked" });
});

test("orderStatus accepts # prefix and case-insensitive ref", async () => {
  const ctx = { conversationId: convId, phone: "+212612345678", toolCalls: [] };
  const tools = toolsModule.createWhatsAppTools(ctx);
  const result = await tools.orderStatus.execute({ ref: "#aaaa1111" });
  assert.equal(result.ref, "AAAA1111");
  assert.equal(result.stage, "received");
});

test("status_only access hides items, total, date and never leaks PII", async () => {
  const ctx = { conversationId: convId, phone: "+212612345678", toolCalls: [] };
  const tools = toolsModule.createWhatsAppTools(ctx);

  const single = await tools.orderStatus.execute({ ref: "BBBB2222" });
  assert.equal(single.ref, "BBBB2222");
  assert.equal(single.stage, "confirmed");
  assert.equal("itemsSummary" in single, false);
  assert.equal("totalMad" in single, false);
  assert.equal("createdAt" in single, false);
  assert.ok(single.trackingNumber === undefined || typeof single.trackingNumber === "string");

  const list = await tools.listMyOrders.execute({});
  const orderB = list.orders.find((o) => o.ref === "BBBB2222");
  assert.ok(orderB);
  assert.equal("itemsSummary" in orderB, false);
  assert.equal("totalMad" in orderB, false);
  const orderA = list.orders.find((o) => o.ref === "AAAA1111");
  assert.ok(orderA);
  assert.equal(orderA.itemsSummary, "T-shirt Amazigh ×2 (Taille M)");
  assert.equal(orderA.totalMad, 327);

  // No customer address, phone or name anywhere in tool output.
  const serialized = JSON.stringify({ single, list });
  assert.equal(serialized.includes("+212699991234"), false);
  assert.equal(serialized.includes("+212612345678"), false);
  assert.equal(serialized.includes("Client Test"), false);
  assert.equal(serialized.toLowerCase().includes("adresse"), false);
});

test("saveAddress on a confirmed order returns already_confirmed", async () => {
  const ctx = { conversationId: convId, phone: "+212612345678", toolCalls: [] };
  const tools = toolsModule.createWhatsAppTools(ctx);
  const result = await tools.saveAddress.execute({ ref: "CCCC3333", address: "12 rue des Tests", city: "Casablanca" });
  assert.deepEqual(result, { error: "already_confirmed" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wa_order_drafts WHERE order_id = ?").get("CCCC3333-order-c").n, 0);
});

test("saveAddress stores the draft and reports city matching for pending orders", async () => {
  const ctx = { conversationId: convId, phone: "+212612345678", toolCalls: [] };
  const tools = toolsModule.createWhatsAppTools(ctx);
  const result = await tools.saveAddress.execute({ ref: "AAAA1111", address: "12 rue des Tests", city: "Casablanca" });
  assert.deepEqual(result, { saved: true, cityMatched: true });
  const draft = staging.getDraft("AAAA1111-order-a");
  assert.equal(draft.address, "12 rue des Tests");
  assert.equal(draft.cityId, 1);

  const ready = await tools.markReadyToConfirm.execute({ ref: "AAAA1111" });
  assert.deepEqual(ready, { ok: true });
  assert.equal(staging.getDraft("AAAA1111-order-a").readyToConfirm, true);
});

test("order tools refuse status_only orders for mutations", async () => {
  const ctx = { conversationId: convId, phone: "+212612345678", toolCalls: [] };
  const tools = toolsModule.createWhatsAppTools(ctx);
  assert.deepEqual(await tools.saveAddress.execute({ ref: "BBBB2222", address: "12 rue des Tests" }), { error: "not_allowed" });
  assert.deepEqual(await tools.markReadyToConfirm.execute({ ref: "BBBB2222" }), { error: "not_allowed" });
  assert.deepEqual(await tools.requestCancellation.execute({ ref: "BBBB2222", reason: "test" }), { error: "not_allowed" });
});

test("requestCancellation creates a proposal and flags a handoff", async () => {
  const ctx = { conversationId: convId, phone: "+212612345678", toolCalls: [] };
  const tools = toolsModule.createWhatsAppTools(ctx);
  const result = await tools.requestCancellation.execute({ ref: "AAAA1111", reason: "Je ne veux plus" });
  assert.deepEqual(result, { ok: true });

  const proposal = staging.listProposals("AAAA1111-order-a").find((p) => p.kind === "cancel");
  assert.ok(proposal);
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.payload.reason, "Je ne veux plus");

  const refreshed = conversations.getConversation(convId);
  assert.equal(refreshed.needsHuman, true);
  assert.equal(refreshed.handoffReason, "demande d'annulation");
});

test("findProducts lists only in-stock options, packs and the product URL", async () => {
  const ctx = { conversationId: convId, phone: "+212612345678", toolCalls: [] };
  const tools = toolsModule.createWhatsAppTools(ctx);
  const result = await tools.findProducts.execute({ query: "tshirt" });
  assert.equal(result.products.length, 1);
  const product = result.products[0];
  assert.equal(product.name, "T-shirt Amazigh");
  assert.equal(product.priceMad, 149);
  assert.deepEqual(product.options, ["Taille: M"]);
  assert.deepEqual(product.packs, ["2 pour 249 DH"]);
  assert.equal(product.url, "https://crm.example.test/produit/tshirt-amazigh");
  assert.deepEqual(product.variants, [{ variantId: "v1", label: "Taille M" }]);
  assert.equal(JSON.stringify(product).includes("v2"), false);

  // Accent-insensitive and category search work too.
  assert.equal((await tools.findProducts.execute({ query: "T-SHIRT amazigh" })).products.length, 1);
  assert.equal((await tools.findProducts.execute({ query: "vêtements" })).products.length, 1);
  assert.deepEqual((await tools.findProducts.execute({ query: "inconnu" })).products, []);
});

test("findProducts results allow creating a purchase request", async () => {
  const ctx = { conversationId: convId, phone: "+212612345678", toolCalls: [] };
  const tools = toolsModule.createWhatsAppTools(ctx);
  const result = await tools.createPurchaseRequest.execute({
    customerName: "Nouveau Client",
    items: [{ variantId: "v1", qty: 1, label: "T-shirt Amazigh Taille M" }],
    city: "Rabat",
    address: "45 avenue Hassan II",
  });
  assert.deepEqual(result, { ok: true });
  const request = staging.listOpenRequests().find((r) => r.conversationId === convId);
  assert.ok(request);
  assert.equal(request.items[0].variantId, "v1");
  assert.equal(request.cityName, "Rabat");
});

test("handoffToHuman flags the conversation with the given reason", async () => {
  const ctx = { conversationId: convId, phone: "+212612345678", toolCalls: [] };
  const tools = toolsModule.createWhatsAppTools(ctx);
  const result = await tools.handoffToHuman.execute({ reason: "produit endommagé" });
  assert.deepEqual(result, { ok: true });
  const refreshed = conversations.getConversation(convId);
  assert.equal(refreshed.needsHuman, true);
  assert.equal(refreshed.handoffReason, "produit endommagé");
});

test("tool budget caps execution at 8 calls per turn", async () => {
  const ctx = { conversationId: convId, phone: "+212612345678", toolCalls: [] };
  const tools = toolsModule.createWhatsAppTools(ctx);
  for (let i = 0; i < toolsModule.MAX_TOOL_CALLS_PER_TURN; i++) {
    const result = await tools.listMyOrders.execute({});
    assert.equal(result.error, undefined);
  }
  assert.equal(ctx.toolCalls.length, toolsModule.MAX_TOOL_CALLS_PER_TURN);
  const blocked = await tools.listMyOrders.execute({});
  assert.deepEqual(blocked, { error: "budget" });
  assert.equal(ctx.toolCalls.length, toolsModule.MAX_TOOL_CALLS_PER_TURN);
});

// ---------------------------------------------------------------------------
// Agent-level tests (stubbed OpenRouter fetch)
// ---------------------------------------------------------------------------

test("runWhatsAppAgent scripts tool calls then replies, records usage and reports the model", async () => {
  fetchQueue.push(
    () => toolCallCompletion([{ name: "orderStatus", args: { ref: "AAAA1111" } }]),
    () => chatCompletion("Votre commande #AAAA1111 est **en préparation**.\n\nElle sera expédiée dès confirmation."),
  );

  const result = await agentModule.runWhatsAppAgent({
    conversationId: convId,
    newMessages: [{ kind: "text", text: "Où en est ma commande ?" }],
  });

  assert.equal(result.model, CHAT_MODEL);
  assert.deepEqual(result.toolCalls, ["orderStatus"]);
  assert.equal(result.handedOff, false);
  assert.equal(result.replies.length, 2);
  assert.equal(result.replies[0], "Votre commande #AAAA1111 est *en préparation*.");
  assert.equal(result.replies[1], "Elle sera expédiée dès confirmation.");

  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].url, "https://openrouter.ai/api/v1/chat/completions");
  const firstBody = requestBody(fetchCalls[0]);
  assert.equal(firstBody.model, CHAT_MODEL);
  assert.equal(firstBody.provider.data_collection, "deny");
  assert.equal(firstBody.messages[0].role, "system");
  assert.ok(firstBody.messages[0].content.includes("Ma Boutique"));
  assert.ok(firstBody.messages[0].content.includes("AAAA1111"));
  assert.ok(firstBody.messages[0].content.includes("<<FAQ>>"));
  assert.ok(firstBody.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("Où en est ma commande ?")));

  const usageRows = db.prepare("SELECT role, model, input_tokens, output_tokens FROM wa_ai_usage").all();
  assert.equal(usageRows.length, 2);
  assert.ok(usageRows.every((r) => r.role === "chat" && r.model === CHAT_MODEL));
});

test("replies are split on blank lines and capped at 3 with markdown cleanup", async () => {
  const longLine = "x".repeat(800);
  fetchQueue.push(
    () =>
      chatCompletion(
        `Premier message.\n\n## Titre superflu\n\n| colonne | valeur |\n|---|---|\n| a | b |\n\n**Deuxième** message avec du gras.\n\n${longLine}`,
      ),
  );

  const result = await agentModule.runWhatsAppAgent({
    conversationId: convId,
    newMessages: [{ kind: "text", text: "Donne-moi un résumé" }],
  });

  assert.equal(result.replies.length, 3);
  assert.equal(result.replies[0], "Premier message.");
  assert.equal(result.replies[1], "Titre superflu");
  assert.equal(result.replies[2], "*Deuxième* message avec du gras.");
  assert.ok(result.replies.every((r) => r.length <= agentModule.MAX_REPLY_CHARS));
  assert.equal(JSON.stringify(result.replies).includes("|"), false);
});

test("empty reply without handoff falls back to the handoff copy and flags the conversation", async () => {
  fetchQueue.push(() => chatCompletion("   \n\n  "));

  const result = await agentModule.runWhatsAppAgent({
    conversationId: convId,
    newMessages: [{ kind: "text", text: "..." }],
  });

  assert.equal(result.replies.length, 1);
  assert.ok(result.replies[0].includes("conseiller"));
  const refreshed = conversations.getConversation(convId);
  assert.equal(refreshed.needsHuman, true);
  assert.equal(refreshed.handoffReason, "réponse IA vide");
});

test("empty reply after a handoff tool call sends nothing extra", async () => {
  fetchQueue.push(
    () => toolCallCompletion([{ name: "handoffToHuman", args: { reason: "réclamation" } }]),
    () => chatCompletion(""),
  );

  const result = await agentModule.runWhatsAppAgent({
    conversationId: convId,
    newMessages: [{ kind: "text", text: "Je veux un humain" }],
  });

  assert.deepEqual(result.replies, []);
  assert.equal(result.handedOff, true);
  assert.deepEqual(result.toolCalls, ["handoffToHuman"]);
  const refreshed = conversations.getConversation(convId);
  assert.equal(refreshed.handoffReason, "réclamation");
});

test("an image turn records vision usage", async () => {
  fetchQueue.push(() => chatCompletion("Merci pour la photo !"));
  await agentModule.runWhatsAppAgent({
    conversationId: convId,
    newMessages: [{ kind: "image", text: "voilà le produit", imageBase64: "aGVsbG8=" }],
  });
  const rows = db.prepare("SELECT role FROM wa_ai_usage").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, "vision");
});

test("an exhausted budget throws before any fetch", async () => {
  spendBudgetFully();
  const callsBefore = fetchCalls.length;
  await assert.rejects(
    () =>
      agentModule.runWhatsAppAgent({
        conversationId: convId,
        newMessages: [{ kind: "text", text: "Salam" }],
      }),
    (err) => err instanceof providerModule.AiBudgetExceededError,
  );
  assert.equal(fetchCalls.length, callsBefore);
});

test("fallback model is used and reported when the primary fails", async () => {
  fetchQueue.push(
    () => new Response(JSON.stringify({ error: { message: "primary down" } }), { status: 500 }),
    () => toolCallCompletion([{ name: "handoffToHuman", args: { reason: "test" } }]),
    () => chatCompletion("Je passe la main."),
  );

  const result = await agentModule.runWhatsAppAgent({
    conversationId: convId,
    newMessages: [{ kind: "text", text: "Bonjour" }],
  });

  assert.equal(result.model, CHAT_FALLBACK);
  assert.equal(result.handedOff, true);
  assert.equal(result.replies.length, 1);
  const roles = db.prepare("SELECT role, model FROM wa_ai_usage ORDER BY created_at").all();
  assert.ok(roles.every((r) => r.model === CHAT_FALLBACK));
});
