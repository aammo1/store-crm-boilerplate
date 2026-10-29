import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { loadSource } from "../test-source.mjs";
import { orderFixture } from "../order-operations-fixtures.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-catalog-tools-"));
process.env.DELIVERY_PROVIDER = "mock";
process.env.DB_PATH = path.join(dir, "crm.db");
process.env.UPLOAD_DIR = path.join(dir, "uploads");
process.env.AUTH_SECRET = "isolated-whatsapp-catalog-tools-secret-32ch";
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
const catalog = loadSource("@/lib/services/catalog");
const settings = loadSource("@/lib/services/whatsapp-settings");
const conversations = loadSource("@/lib/services/whatsapp-conversations");
const staging = loadSource("@/lib/services/whatsapp-staging");
const pacing = loadSource("@/lib/whatsapp/pacing");
const catalogTools = loadSource("@/lib/whatsapp/ai/catalog-tools");
const agentModule = loadSource("@/lib/whatsapp/ai/agent");
const providerModule = loadSource("@/lib/whatsapp/ai/provider");
const promptModule = loadSource("@/lib/whatsapp/ai/prompt");
const db = getDb();

const CHAT_MODEL = "z-ai/glm-5.3-flash";
const FLAGS = { catalog: true, editProposals: true, crossSell: true };

// ---------------------------------------------------------------------------
// fetch stub for the agent-level test only; every queued handler answers one call.
// ---------------------------------------------------------------------------
let fetchCalls = [];
let fetchQueue = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init });
  const handler = fetchQueue.shift();
  if (!handler) throw new Error("Stub fetch: appel réseau inattendu");
  return handler(url, init);
};

const jsonOk = (payload) =>
  new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });

const chatCompletion = (content) =>
  jsonOk({
    id: "gen_test",
    object: "chat.completion",
    created: 0,
    model: CHAT_MODEL,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  });

const toolCallCompletion = (calls) =>
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
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const now = new Date().toISOString();

function insertProduct({ id, slug, name, category, price, description, images }) {
  db.prepare(
    `INSERT INTO products (id, slug, name, category, price, description, images_json, option_definitions_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
  ).run(id, slug, name, category, price, description, JSON.stringify(images), now, now);
}

function insertVariant(id, productId, label, options) {
  db.prepare(
    `INSERT INTO variants (id, product_id, label, options_json, options_key, sku)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, productId, label, JSON.stringify(options), JSON.stringify(options.map((o) => [o.name, o.value])), `${id}-sku`);
}

function setStock(variantId, physical, reserved = 0) {
  db.prepare(
    "INSERT INTO stock_balances (variant_id, location, physical, reserved, quarantine) VALUES (?, 'MAIN', ?, ?, 0)",
  ).run(variantId, physical, reserved);
}

// Product 1: options with one out-of-stock size, plus a pack.
insertProduct({
  id: "p1",
  slug: "tshirt-amazigh",
  name: "T-shirt Amazigh",
  category: "Vêtements",
  price: 149,
  description: "T-shirt brodé motif amazigh coton",
  images: ["/api/media/photo-tshirt.webp"],
});
insertVariant("v1", "p1", "Taille M", [{ name: "Taille", value: "M" }]);
insertVariant("v2", "p1", "Taille L", [{ name: "Taille", value: "L" }]);
setStock("v1", 10);
setStock("v2", 5, 5); // 0 available
db.prepare(
  "INSERT INTO product_packs (id, product_id, quantity, price_mad, label, highlight, active, created_at, updated_at) VALUES ('pack1', 'p1', 2, 249, NULL, 0, 1, ?, ?)",
).run(now, now);

// Product 2: numeric sizes, "42" out of stock while "41"/"43" are available.
insertProduct({
  id: "p2",
  slug: "chaussures-atlas",
  name: "Chaussures Atlas",
  category: "Chaussures",
  price: 299,
  description: "Chaussures en cuir cousu main",
  images: [],
});
for (const [variantId, size, physical] of [["v40", "40", 0], ["v41", "41", 5], ["v42", "42", 0], ["v43", "43", 5]]) {
  insertVariant(variantId, "p2", `Pointure ${size}`, [{ name: "Pointure", value: size }]);
  if (physical > 0) setStock(variantId, physical);
}

// Product 3: optionless product with stock (cross-sell candidate).
insertProduct({
  id: "p3",
  slug: "sac-berbere",
  name: "Sac Berbère",
  category: "Sacs",
  price: 199,
  description: "Sac artisanal tressé",
  images: ["/api/media/photo-sac.webp"],
});
insertVariant("v3", "p3", "Standard", []);
setStock("v3", 3);

// Orders: A editable (full access), B other phone (status only), C confirmed (full access).
orderFixture(db, "AAAA1111-editable", { productId: "p2", variantId: "v41", price: 299, offer: false });
orderFixture(db, "BBBB2222-remote", { productId: "p2", variantId: "v41", price: 299, offer: false });
db.prepare("UPDATE orders SET customer_phone = '+212699991234' WHERE id = 'BBBB2222-remote'").run();
db.prepare("UPDATE orders SET confirmation_status = 'confirmed' WHERE id = 'BBBB2222-remote'").run();
orderFixture(db, "CCCC3333-locked", { productId: "p2", variantId: "v41", price: 299, offer: false });
db.prepare("UPDATE orders SET confirmation_status = 'confirmed' WHERE id = 'CCCC3333-locked'").run();

const conv = conversations.getOrCreateConversation("+212612345678", "212612345678@s.whatsapp.net", "Client Test");
const convId = conv.id;
// B belongs to another phone: status_only through ref + last 4 digits.
conversations.linkOrdersFromMessage(convId, "Ma commande #BBBB2222 1234");

function makeCtx(overrides = {}) {
  return {
    conversationId: convId,
    phone: "+212612345678",
    language: "fr",
    productCardsQueued: 0,
    toolCalls: [],
    ...overrides,
  };
}

function cardRows() {
  return db
    .prepare(
      "SELECT dedupe_key, body, media_ref, kind, purpose, respect_window, counts_toward_cap FROM wa_outbox WHERE purpose = 'product_card'",
    )
    .all();
}

const today = pacing.casablancaParts(new Date()).date;

after(() => {
  globalThis.fetch = originalFetch;
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fetchCalls = [];
  fetchQueue = [];
  db.prepare("DELETE FROM wa_outbox").run();
  db.prepare("DELETE FROM wa_proposals").run();
  db.prepare("DELETE FROM app_state WHERE key LIKE 'wa_crosssell:%'").run();
  db.prepare(
    "UPDATE wa_conversations SET mode = 'ai', needs_human = 0, handoff_reason = NULL, taken_over_by = NULL, taken_over_at = NULL WHERE id = ?",
  ).run(convId);
  settings.updateWhatsAppSettings({
    enabled: true,
    aiEnabled: true,
    aiDailyBudgetCents: 100,
    catalogSuggestionsEnabled: true,
    crossSellEnabled: true,
    orderEditProposalsEnabled: true,
  });
});

// ---------------------------------------------------------------------------
// Tool-level tests
// ---------------------------------------------------------------------------

test("cards are deduped per day and carry the price, in-stock options, pack and link from the DB", async () => {
  const ctx = makeCtx();
  const tools = catalogTools.createCatalogTools(ctx, FLAGS);

  const result = await tools.sendProductCards.execute({ productSlugs: ["tshirt-amazigh"] });
  assert.deepEqual(result, { sent: ["tshirt-amazigh"], skipped: [] });
  assert.equal(ctx.productCardsQueued, 1);

  const rows = cardRows();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.kind, "image");
  assert.equal(row.respect_window, 0);
  assert.equal(row.counts_toward_cap, 0);
  assert.equal(row.media_ref, "https://crm.example.test/api/media/photo-tshirt.webp");
  const caption = row.body;
  assert.ok(caption.includes("*T-shirt Amazigh* — 149 DH"));
  assert.ok(caption.includes("Disponible : Taille: M"));
  // Out-of-stock options are never announced as available.
  assert.equal(caption.includes("Taille: L"), false);
  assert.ok(caption.includes("2 pour 249 DH"));
  assert.ok(caption.includes("https://crm.example.test/produit/tshirt-amazigh"));
  assert.ok(caption.length <= 1000);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM wa_outbox WHERE dedupe_key = ?").get(`card:${convId}:tshirt-amazigh:${today}`).n,
    1,
  );

  // Same product again the same day: deduped, nothing re-enqueued.
  const ctx2 = makeCtx();
  const tools2 = catalogTools.createCatalogTools(ctx2, FLAGS);
  assert.deepEqual(await tools2.sendProductCards.execute({ productSlugs: ["tshirt-amazigh"] }), {
    sent: [],
    skipped: ["tshirt-amazigh"],
  });
  assert.equal(ctx2.productCardsQueued, 0);
  assert.equal(cardRows().length, 1);

  // Unknown slugs are skipped, never invented.
  assert.deepEqual(await tools2.sendProductCards.execute({ productSlugs: ["produit-inconnu"] }), {
    sent: [],
    skipped: ["produit-inconnu"],
  });
});

test("card captions follow the conversation language (Arabic for ar/darija_arabic)", async () => {
  const tools = catalogTools.createCatalogTools(makeCtx({ language: "darija_arabic" }), FLAGS);
  const result = await tools.sendProductCards.execute({ productSlugs: ["sac-berbere"] });
  assert.deepEqual(result.sent, ["sac-berbere"]);
  const row = cardRows().find((r) => r.body.includes("Sac Berbère"));
  assert.ok(row);
  assert.ok(row.body.includes("199 درهم"));
  assert.ok(row.body.includes("https://crm.example.test/produit/sac-berbere"));
});

test("checkAvailability matches accent-insensitively and returns the nearest numeric alternatives", async () => {
  const tools = catalogTools.createCatalogTools(makeCtx(), FLAGS);

  assert.deepEqual(await tools.checkAvailability.execute({ productSlug: "chaussures-atlas", options: ["41"] }), {
    available: true,
    alternatives: [],
  });
  assert.deepEqual(await tools.checkAvailability.execute({ productSlug: "tshirt-amazigh", options: ["m"] }), {
    available: true,
    alternatives: [],
  });

  // "42" is out of stock: the closest in-stock numeric sizes are proposed.
  const outOfStock = await tools.checkAvailability.execute({ productSlug: "chaussures-atlas", options: ["42"] });
  assert.equal(outOfStock.available, false);
  assert.deepEqual(outOfStock.alternatives.map((a) => a.variantId).sort(), ["v41", "v43"]);
  assert.ok(outOfStock.alternatives.every((a) => ["41", "43"].includes(a.options[0].value)));

  assert.deepEqual(await tools.checkAvailability.execute({ productSlug: "inconnu", options: ["42"] }), {
    error: "not_found",
  });
});

test("low-score photo matching returns null and a good description matches the catalog", async () => {
  const tools = catalogTools.createCatalogTools(makeCtx(), FLAGS);

  assert.deepEqual(
    await tools.matchProductPhoto.execute({ description: "bonjour je cherche un truc que j'ai vu chez un ami" }),
    { match: null },
  );
  // One shared token out of three stays below the 0.35 threshold.
  assert.deepEqual(await tools.matchProductPhoto.execute({ description: "coton joli beau" }), { match: null });

  const found = await tools.matchProductPhoto.execute({ description: "un tshirt amazigh brodé en coton" });
  assert.equal(found.match.slug, "tshirt-amazigh");
  assert.ok(found.match.score >= 0.35);
  assert.ok(found.candidates.length >= 1 && found.candidates.length <= 3);
  assert.ok(found.match.url.startsWith("https://crm.example.test/produit/"));
});

test("proposeOrderEdit stages an editable order, refuses confirmed ones and reports stock alternatives", async () => {
  const tools = catalogTools.createCatalogTools(makeCtx(), FLAGS);

  const ok = await tools.proposeOrderEdit.execute({
    ref: "AAAA1111",
    lines: [{ variantId: "v43", qty: 1 }],
    summary: "Le client veut la pointure 43.",
  });
  assert.deepEqual(ok, { proposed: true });
  const proposal = staging.listProposals("AAAA1111-editable").find((p) => p.kind === "edit");
  assert.ok(proposal);
  assert.equal(proposal.status, "pending");
  assert.deepEqual(proposal.payload.lines, [{ variantId: "v43", qty: 1 }]);
  // The AI keeps the conversation: no handoff for an edit proposal.
  assert.equal(conversations.getConversation(convId).needsHuman, false);

  assert.equal(
    (await tools.proposeOrderEdit.execute({
      ref: "CCCC3333",
      lines: [{ variantId: "v43", qty: 1 }],
      summary: "hors délai",
    })).error,
    "already_confirmed",
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wa_proposals WHERE order_id = 'CCCC3333-locked'").get().n, 0);

  const outOfStock = await tools.proposeOrderEdit.execute({
    ref: "AAAA1111",
    lines: [{ variantId: "v42", qty: 1 }],
    summary: "pointure 42",
  });
  assert.equal(outOfStock.error, "out_of_stock");
  assert.deepEqual(outOfStock.alternatives.map((a) => a.variantId).sort(), ["v41", "v43"]);

  assert.deepEqual(
    await tools.proposeOrderEdit.execute({
      ref: "BBBB2222",
      lines: [{ variantId: "v43", qty: 1 }],
      summary: "statut seul",
    }),
    { error: "not_allowed" },
  );

  // No tool output ever carries a computed total for an edit.
  assert.equal(/total/i.test(JSON.stringify([ok, outOfStock])), false);
});

test("suggestCrossSell fires at most once per conversation with a server price and link", async () => {
  const tools = catalogTools.createCatalogTools(makeCtx(), FLAGS);

  const first = await tools.suggestCrossSell.execute({ productSlug: "tshirt-amazigh" });
  assert.equal(first.suggested.name, "Chaussures Atlas");
  assert.equal(first.suggested.priceMad, 299);
  assert.equal(first.suggested.url, "https://crm.example.test/produit/chaussures-atlas");
  assert.equal(
    db.prepare("SELECT value FROM app_state WHERE key = ?").get(`wa_crosssell:${convId}`).value,
    "1",
  );

  assert.deepEqual(await tools.suggestCrossSell.execute({ productSlug: "tshirt-amazigh" }), {
    error: "already_suggested",
  });
  assert.deepEqual(await tools.suggestCrossSell.execute({ productSlug: "inconnu" }), { error: "not_found" });
});

test("with every flag OFF the catalog tool set is empty; with flags from settings all five exist", () => {
  const ctx = makeCtx();
  settings.updateWhatsAppSettings({
    catalogSuggestionsEnabled: false,
    crossSellEnabled: false,
    orderEditProposalsEnabled: false,
  });
  assert.deepEqual(catalogTools.createCatalogTools(ctx), {});

  settings.updateWhatsAppSettings({
    catalogSuggestionsEnabled: true,
    crossSellEnabled: true,
    orderEditProposalsEnabled: true,
  });
  assert.deepEqual(Object.keys(catalogTools.createCatalogTools(ctx)).sort(), [
    "checkAvailability",
    "matchProductPhoto",
    "proposeOrderEdit",
    "sendProductCards",
    "suggestCrossSell",
  ]);
});

test("catalog tools share the per-turn tool budget with the base tools", async () => {
  const ctx = makeCtx();
  ctx.toolCalls.push(...Array(8).fill("listMyOrders"));
  const tools = catalogTools.createCatalogTools(ctx, FLAGS);
  assert.deepEqual(await tools.checkAvailability.execute({ productSlug: "tshirt-amazigh", options: ["m"] }), {
    error: "budget",
  });
  assert.equal(ctx.toolCalls.length, 8);
});

// ---------------------------------------------------------------------------
// Prompt pin: with every flag OFF the prompt is the task-17 core prompt only
// ---------------------------------------------------------------------------

// Minimal context for buildSystemPrompt (pure function, no DB or settings access).
const PROMPT_CTX = {
  storeName: "Ma Boutique",
  assistantName: "Salma",
  language: "fr",
  faqText: "Livraison partout au Maroc en 24h.",
  nowCasablanca: "jeudi 29 octobre 2026 à 12:00",
  orders: [{ ref: "AAAA1111", access: "full" }],
};

// Text that exists only in the flag-gated catalog/edit-proposal/cross-sell blocks.
const CONDITIONAL_BLOCK_MARKERS = [
  "CATALOGUE :",
  "MODIFICATIONS :",
  "Le nouveau total sera confirmé par un conseiller.",
  "CROSS-SELL :",
  "sendProductCards",
  "checkAvailability",
  "matchProductPhoto",
  "proposeOrderEdit",
  "suggestCrossSell",
];

// Text of the mandatory task-17 rules: identity, language, style, facts, prices,
// orders, privacy/security, pre-sales, handoff, darija lexicon and the FAQ block.
const CORE_RULE_MARKERS = [
  "boutique marocaine en paiement à la livraison",
  "assistant automatique",
  "LANGUE :",
  "STYLE :",
  "FAITS :",
  "PRIX :",
  "COMMANDES :",
  "CONFIDENTIALITÉ :",
  "DONNÉES NON FIABLES",
  "statut seul",
  "PRÉ-VENTE :",
  "createPurchaseRequest",
  "markReadyToConfirm",
  "PASSE LA MAIN",
  "handoffToHuman",
  "LEXIQUE DARIJA",
  "<<FAQ>>",
  "<</FAQ>>",
  "Prix en MAD",
];

test("flags-OFF buildSystemPrompt keeps only the task-17 core rules, without any conditional block", () => {
  const flagsOff = promptModule.buildSystemPrompt({
    ...PROMPT_CTX,
    catalogEnabled: false,
    orderEditProposalsEnabled: false,
    crossSellEnabled: false,
  });
  for (const marker of CONDITIONAL_BLOCK_MARKERS) {
    assert.equal(flagsOff.includes(marker), false, `flags-OFF prompt must not contain: ${marker}`);
  }
  for (const marker of CORE_RULE_MARKERS) {
    assert.ok(flagsOff.includes(marker), `flags-OFF prompt must keep the core rule: ${marker}`);
  }
  // Catalog OFF switches the PRODUITS paragraph to its restricted wording.
  assert.ok(flagsOff.includes("ne propose pas de produits spontanément"));

  // Sanity: the markers are real — the same ctx with every flag ON shows each
  // conditional block, so the absence assertions above are not vacuous.
  const flagsOn = promptModule.buildSystemPrompt({
    ...PROMPT_CTX,
    catalogEnabled: true,
    orderEditProposalsEnabled: true,
    crossSellEnabled: true,
  });
  for (const marker of CONDITIONAL_BLOCK_MARKERS) {
    assert.ok(flagsOn.includes(marker), `flags-ON prompt must contain: ${marker}`);
  }
  assert.equal(flagsOn.includes("ne propose pas de produits spontanément"), false);
});

// ---------------------------------------------------------------------------
// Agent-level test (stubbed OpenRouter fetch)
// ---------------------------------------------------------------------------

test("runWhatsAppAgent merges the catalog tools when enabled and reports queued cards", async () => {
  fetchQueue.push(
    () => toolCallCompletion([{ name: "sendProductCards", args: { productSlugs: ["tshirt-amazigh"] } }]),
    () => chatCompletion("Voila la carte du produit."),
  );

  const result = await agentModule.runWhatsAppAgent({
    conversationId: convId,
    newMessages: [{ kind: "text", text: "Tu as ce t-shirt ?" }],
  });

  assert.equal(result.model, CHAT_MODEL);
  assert.deepEqual(result.toolCalls, ["sendProductCards"]);
  assert.equal(result.productCardsQueued, 1);
  const row = cardRows()[0];
  assert.ok(row.body.includes("*T-shirt Amazigh* — 149 DH"));

  // The system prompt carried the catalog, edit-proposal and cross-sell rules.
  const system = JSON.parse(fetchCalls[0].init.body).messages[0].content;
  assert.ok(system.includes("sendProductCards"));
  assert.ok(system.includes("matchProductPhoto"));
  assert.ok(system.includes("Le nouveau total sera confirmé par un conseiller."));
  assert.ok(system.includes("suggestCrossSell"));

  // Direct catalog service still sees the same data (sanity against fixture drift).
  assert.equal(catalog.getStorefrontProduct("tshirt-amazigh").price, 149);
  assert.ok(providerModule.AiBudgetExceededError !== undefined);
});
