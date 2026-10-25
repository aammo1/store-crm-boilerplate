import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module from "node:module";
import { after, test } from "node:test";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { loadSource } from "./test-source.mjs";
import { configuration, prepare, apply } from "./catalog-agent-client.mjs";

const child = process.env.CRM_CATALOG_CHILD;
const temp = child ? null : fs.mkdtempSync(path.join(os.tmpdir(), "crm-catalog-agent-"));
if (temp) {
  process.env.DB_PATH = path.join(temp, "test.db");
  process.env.UPLOAD_DIR = path.join(temp, "uploads");
}
process.env.CATALOG_AGENT_KEY = "catalog-agent-test-key-at-least-32-characters";
process.env.DELIVERY_PROVIDER = "mock";
process.env.OZON_CLIENT_ID = "";
process.env.OZON_API_KEY = "";
const originalNetworkFetch = global.fetch;
global.fetch = async () => { throw new Error("Network disabled in catalog-agent tests"); };
const { getDb } = loadSource("@/lib/db");
import { createOrder } from "./fulfillment-fixtures.mjs";
const agent = loadSource("@/lib/services/catalog-agent");
const catalog = loadSource("@/lib/services/catalog");
const inventory = loadSource("@/lib/services/inventory");
const { requireCatalogAgent } = loadSource("@/lib/catalog-agent-auth");
const db = getDb();

if (child) {
  process.once("message", () => {
    try {
      const { operation, preview } = JSON.parse(child);
      const result = agent.applyCatalogOperation(operation, preview);
      process.send({ ok: true, replayed: result.replayed });
    } catch (error) { process.send({ ok: false, message: error.message }); }
    finally { db.close(); process.disconnect(); }
  });
  process.send({ ready: true });
} else {
  after(() => { global.fetch = originalNetworkFetch; db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const data = name => ({
    name, category: "soins", price: 299, description: "Description française.",
    story: "Une histoire sobre.", materials: ["Synthétique"], isBestSeller: false,
    optionDefinitions: [{ name: "Contenance", values: ["250 ml", "500 ml"] }],
    variants: [{ key: "small", options: [{ name: "Contenance", value: "250 ml" }] }, { key: "large", options: [{ name: "Contenance", value: "500 ml" }] }],
    initialStock: [{ variantKey: "small", qty: 3 }, { variantKey: "large", qty: 0 }],
  });
  const creation = name => ({ command: "create", requestId: `create-${crypto.randomUUID()}`, data: data(name) });
  const mutation = (command, target, extra = {}) => ({ command, target, requestId: `${command}-${crypto.randomUUID()}`, ...extra });
  const snapshot = () => Object.fromEntries(["products", "product_colors", "product_packs", "variants", "stock_balances", "stock_movements", "app_state"]
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const commit = operation => agent.applyCatalogOperation(operation, agent.previewCatalogOperation(operation).preview);

  test("credential is required, scoped and fails closed when unconfigured", () => {
    for (const authorization of [undefined, "Bearer wrong", `Basic ${process.env.CATALOG_AGENT_KEY}`]) {
      const request = new Request("https://crm.test/api/catalog-agent", { headers: authorization ? { authorization } : {} });
      assert.throws(() => requireCatalogAgent(request), error => error.status === 401);
    }
    process.env.STOREFRONT_API_KEY = "storefront-only-key-at-least-32-characters";
    assert.throws(() => requireCatalogAgent(new Request("https://crm.test", { headers: { authorization: `Bearer ${process.env.STOREFRONT_API_KEY}` } })), error => error.status === 401);
    const request = new Request("https://crm.test", { headers: { authorization: `Bearer ${process.env.CATALOG_AGENT_KEY}` } });
    assert.doesNotThrow(() => requireCatalogAgent(request));
    const key = process.env.CATALOG_AGENT_KEY;
    process.env.CATALOG_AGENT_KEY = "short";
    assert.throws(() => requireCatalogAgent(request), error => error.status === 503);
    delete process.env.CATALOG_AGENT_KEY;
    assert.throws(() => requireCatalogAgent(request), error => error.status === 503);
    process.env.CATALOG_AGENT_KEY = key;
  });

  test("preview rolls back all catalog, stock, movement and receipt writes; apply opens stock once", () => {
    const operation = creation("Élise");
    const before = snapshot();
    const preview = agent.previewCatalogOperation(operation);
    assert.deepEqual(snapshot(), before);
    assert.equal(preview.after.variants.find(v => v.id === preview.variantIds.small).available, 3);
    assert.equal(preview.before, null);
    assert.equal(agent.catalogReceipt(operation.requestId), null);
    const saved = agent.applyCatalogOperation(operation, preview.preview);
    assert.equal(saved.product.id, "elise");
    assert.equal(saved.replayed, false);
    assert.equal(saved.product.variants.find(v => v.id === saved.variantIds.small).available, 3);
    assert.notEqual(saved.variantIds.small, preview.variantIds.small);
    const after = snapshot();
    assert.equal(agent.applyCatalogOperation(operation, preview.preview).replayed, true);
    assert.deepEqual(snapshot(), after);
    assert.equal(agent.catalogReceipt(operation.requestId).product.id, "elise");
    assert.throws(() => agent.applyCatalogOperation({ ...operation, data: { ...operation.data, price: 300 } }, preview.preview), /déjà utilisé/);
    assert.equal(agent.previewCatalogOperation(operation).alreadyApplied, true);
    assert.throws(() => agent.previewCatalogOperation({ ...operation, requestId: "another-create-request" }), /slug/);
  });

  test("stock on edits, legacy fields, malformed quantities and ambiguous creation identities are rejected atomically", () => {
    const edit = mutation("edit", "elise", { data: { price: 320 } });
    for (const data of [
      { price: 320, initialStock: [] }, { stock: 4 }, { requestId: "shadow-id" }, {},
      { colors: [{ name: "Noir", hex: "#111111", images: [], stock: 5 }] },
      { colors: [{ name: "Noir", hex: "#111111", images: [] }, { name: "Noir", hex: "#222222", images: [] }] },
    ]) assert.throws(() => agent.previewCatalogOperation({ ...edit, data }));
    for (const initialStock of [
      [{ variantKey: "small", qty: -1 }], [{ variantKey: "small", qty: 1.5 }], [{ variantKey: "small", qty: Number.MAX_SAFE_INTEGER + 1 }],
      [{ variantKey: "absent", qty: 1 }], [{ variantKey: "small", qty: 1 }, { variantKey: "small", qty: 2 }],
      [{ variantId: "small", qty: 1 }], [{ options: [], qty: 1 }], [{ colorKey: "Noir", size: "37", qty: 1 }],
    ]) assert.throws(() => agent.previewCatalogOperation({ ...creation("Invalid"), data: { ...data("Invalid"), initialStock } }));
    const before = snapshot();
    const invalid = creation("Invalid keys");
    invalid.data.variants[1].key = "small";
    assert.throws(() => agent.previewCatalogOperation(invalid));
    invalid.data.variants[1].key = "large";
    invalid.data.variants[1].options = invalid.data.variants[0].options;
    assert.throws(() => agent.previewCatalogOperation(invalid));
    invalid.data.variants[0].id = "invented-id";
    assert.throws(() => agent.previewCatalogOperation(invalid));
    assert.deepEqual(snapshot(), before);
  });

  test("signed previews bind request and current catalog; stock changes also conflict", () => {
    const operation = mutation("edit", "elise", { data: { price: 320 } });
    const preview = agent.previewCatalogOperation(operation);
    assert.throws(() => agent.applyCatalogOperation(operation, `${preview.preview}x`), /invalide/);
    assert.throws(() => agent.applyCatalogOperation({ ...operation, data: { price: 321 } }, preview.preview), /changé/);
    catalog.updateProduct("elise", { description: "Une autre modification." });
    assert.throws(() => agent.applyCatalogOperation(operation, preview.preview), /changé/);
    const refreshed = agent.previewCatalogOperation(operation);
    const variant = catalog.getProductById("elise").variants.find(v => v.options[0].value === "250 ml");
    inventory.adjustStock(variant.id, { physicalDelta: 1 }, "Test comptage", "test", "test-physical-change");
    assert.throws(() => agent.applyCatalogOperation(operation, refreshed.preview), /changé/);
    const expiring = agent.previewCatalogOperation(operation);
    const original = Date.now;
    try {
      Date.now = () => original() + 31 * 60_000;
      assert.throws(() => agent.applyCatalogOperation(operation, expiring.preview), /expiré/);
    } finally { Date.now = original; }
    commit(operation);
    assert.equal(catalog.getProductById("elise").price, 320);
  });

  test("edits create zero-stock variants and preserve retained/reactivated stock; archive/restore never adjust stock", () => {
    const before = db.prepare("SELECT * FROM stock_movements ORDER BY rowid").all();
    const original = catalog.getProductById("elise").variants.find(v => v.options[0].value === "250 ml");
    const definitions = values => [{ name: "Contenance", values }];
    let product = commit(mutation("edit", "elise", { data: { optionDefinitions: definitions(["500 ml", "1 l"]) } })).product;
    assert.equal(product.variants.find(v => v.id === original.id).active, false);
    assert.equal(product.variants.find(v => v.options[0].value === "1 l").available, 0);
    product = commit(mutation("edit", "elise", { data: { optionDefinitions: definitions(["250 ml", "500 ml", "1 l"]) } })).product;
    assert.equal(product.variants.find(v => v.id === original.id).available, 4);
    assert.equal(commit(mutation("archive", "elise")).product.active, false);
    assert.equal(commit(mutation("restore", "elise")).product.active, true);
    assert.deepEqual(db.prepare("SELECT * FROM stock_movements ORDER BY rowid").all(), before);
    const withPacks = commit(mutation("edit", "elise", {
      data: {
        landingEnabled: true,
        packs: [{ quantity: 2, price: 540, label: "Duo", highlight: true }],
      },
    })).product;
    assert.equal(withPacks.landingEnabled, true);
    assert.equal(withPacks.packs.length, 1);
    assert.equal(withPacks.packs[0].quantity, 2);
    assert.equal(withPacks.packs[0].price, 540);
  });

  test("two processes applying the same creation produce one product and one opening per variant", async () => {
    const operation = creation("Concurrent");
    const preview = agent.previewCatalogOperation(operation).preview;
    const children = Array.from({ length: 2 }, () => fork(fileURLToPath(import.meta.url), [], {
      env: { ...process.env, CRM_CATALOG_CHILD: JSON.stringify({ operation, preview }) },
      execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"],
    }));
    try {
      const outcomes = children.map(proc => new Promise((resolve, reject) => {
        proc.on("error", reject);
        proc.on("message", message => { if (!message.ready) resolve(message); });
        proc.on("exit", code => { if (code !== 0) reject(new Error(`Child failed: ${code}`)); });
      }));
      const exits = children.map(proc => new Promise(resolve => proc.once("exit", resolve)));
      await Promise.all(children.map(proc => new Promise(resolve => proc.once("message", resolve))));
      children.forEach(proc => proc.send("apply"));
      const results = await Promise.all(outcomes);
      await Promise.all(exits);
      assert.ok(results.every(result => result.ok), JSON.stringify(results));
      assert.equal(results.filter(result => !result.replayed).length, 1);
      assert.equal(db.prepare("SELECT count(*) n FROM products WHERE id = 'concurrent'").get().n, 1);
      const variants = catalog.getProductById("concurrent").variants;
      for (const variant of variants) assert.equal(inventory.listMovements({ variantId: variant.id }).length, 1);
    } finally { children.forEach(proc => { if (proc.exitCode === null) proc.kill(); }); }
  });

  test("default variants and two-option identities survive automation edits, mock dispatch, archived return and restore", async () => {
    const standard = commit({ command: "create", requestId: "create-default-product", data: {
      name: "Chargeur", category: "accessoires", price: 100,
      variants: [{ key: "standard", options: [] }], initialStock: [{ variantKey: "standard", qty: 2 }],
    } });
    assert.deepEqual(standard.product.variants[0].options, []);
    const implicit = commit({ command: "create", requestId: "create-implicit-default", data: { name: "Câble", category: "accessoires", price: 50 } });
    assert.equal(implicit.product.variants.length, 1);
    assert.deepEqual(implicit.product.variants[0].options, []);
    const options = [{ name: "Contenance", value: "500 ml" }, { name: "Parfum", value: "Rose" }];
    const serum = commit({ command: "create", requestId: "create-historical-serum", data: {
      name: "Sérum original", category: "soins", price: 200,
      optionDefinitions: [{ name: "Contenance", values: ["500 ml"] }, { name: "Parfum", values: ["Rose"] }],
      variants: [{ key: "rose", options }], initialStock: [{ variantKey: "rose", qty: 3 }],
    } });
    const variantId = serum.variantIds.rose;
    const { confirmOrder } = loadSource("@/lib/services/confirmation");
    const { createOrResumeBl } = loadSource("@/lib/services/delivery-notes");
    const { handoffBl } = loadSource("@/lib/services/expeditions");
    const { drainSubmissions } = loadSource("@/lib/workers/submission");
    const { getProvider } = loadSource("@/lib/shipping");
    const { syncCities } = loadSource("@/lib/shipping/ozon");
    const { ensureReturn, markReturnReceived } = loadSource("@/lib/services/returns");
    await syncCities(getProvider());
    const items = [serum.product.variants[0], standard.product.variants[0]].map(v => ({
      product_id: v.productId, variant_id: v.id, sku: v.sku, name: v.productId === serum.product.id ? "Sérum original" : "Chargeur",
      variant_label: v.label, options: v.options, quantity: 1, unit_price: v.productId === serum.product.id ? 200 : 100,
      line_total: v.productId === serum.product.id ? 200 : 100,
    }));
    createOrder({ id: "automation-history", customerName: "Cliente", customerPhone: "+212612345678", items,
      upsellOffer: null, subtotal: 300, shipping: 29, total: 329 });
    const actor = { id: "catalog-history-test" };
    const { submissionId } = confirmOrder("automation-history", { lines: items.map((line, lineIndex) => ({ lineIndex, variantId: line.variant_id })), address: "12 rue test", cityId: 1 }, actor);
    await drainSubmissions(getProvider());
    const bl = await createOrResumeBl([submissionId], actor);
    assert.equal(handoffBl(bl.bl.id, actor.id).results.every(result => result.ok), true);
    const frozenPayload = db.prepare("SELECT payload_json FROM courier_submissions WHERE id = ?").get(submissionId).payload_json;
    const rename = { name: "Contenance", value: "750 ml" };
    const edited = commit(mutation("edit", serum.product.id, { data: {
      name: "Sérum renommé", optionDefinitions: [{ name: "Contenance", values: ["750 ml"] }, { name: "Parfum", values: ["Rose"] }],
      variants: [{ id: variantId, options: [rename, options[1]], label: "Nouveau libellé" }],
    } })).product;
    assert.equal(edited.variants[0].id, variantId);
    assert.equal(edited.variants[0].sku, serum.product.variants[0].sku);
    assert.throws(() => agent.previewCatalogOperation(mutation("edit", serum.product.id, { data: { variants: [{ id: variantId, sku: "REPLACEMENT", options: [rename, options[1]] }] } })));
    commit(mutation("archive", serum.product.id));
    commit(mutation("archive", standard.product.id));
    const ret = ensureReturn(submissionId, "Retour test catalogue");
    markReturnReceived(ret.id, actor.id);
    inventory.receiveReturnLines(submissionId, "automation-history", [
      { variantId, sellableQty: 0, damagedQty: 1 },
      { variantId: standard.variantIds.standard, sellableQty: 1, damagedQty: 0 },
    ], actor.id, ret.id);
    const history = () => Object.fromEntries(["stock_balances", "stock_movements", "return_lines", "reservations"].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const afterReturn = history();
    commit(mutation("edit", serum.product.id, { data: { description: "Après retour." } }));
    const restored = commit(mutation("restore", serum.product.id)).product;
    commit(mutation("restore", standard.product.id));
    assert.deepEqual(history(), afterReturn);
    assert.equal(restored.variants[0].id, variantId);
    assert.deepEqual(db.prepare("SELECT physical, reserved, quarantine FROM stock_balances WHERE variant_id = ? AND location = 'MAIN'").get(variantId), { physical: 3, reserved: 0, quarantine: 1 });
    assert.deepEqual(db.prepare("SELECT variant_id FROM return_lines WHERE return_id = ? ORDER BY variant_id").all(ret.id).map(row => row.variant_id).sort(), [variantId, standard.variantIds.standard].sort());
    assert.deepEqual(JSON.parse(db.prepare("SELECT items_json FROM orders WHERE id = 'automation-history'").get().items_json), items);
    assert.equal(db.prepare("SELECT payload_json FROM courier_submissions WHERE id = ?").get(submissionId).payload_json, frozenPayload);
    assert.equal(agent.catalogReceipt("create-historical-serum").variantIds.rose, variantId);
  });

  test("HTTP routes and client perform image dry-run, approved upload, apply, verify and safe replay", async () => {
    const originalLoad = Module._load;
    let revalidations = 0;
    Module._load = function (request, ...args) {
      if (request === "next/cache") return { revalidateTag() {}, revalidatePath() { revalidations++; } };
      return originalLoad.call(this, request, ...args);
    };
    let routes;
    let uploads;
    try {
      routes = loadSource("@/app/api/catalog-agent/route");
      uploads = loadSource("@/app/api/catalog-agent/upload/route");
    } finally { Module._load = originalLoad; }
    assert.equal((await routes.GET(new Request("https://crm.test/api/catalog-agent"))).status, 401);
    assert.equal((await uploads.POST(new Request("https://crm.test/api/catalog-agent/upload", { method: "POST" }))).status, 401);
    const auth = { authorization: `Bearer ${process.env.CATALOG_AGENT_KEY}` };
    const capabilities = await (await routes.GET(new Request("https://crm.test/api/catalog-agent", { headers: auth }))).json();
    assert.equal(capabilities.schemaVersion, 2);
    assert.equal(capabilities.variantIdentity.initialStock, "variantKey");
    for (const imagePath of ["https://photos.test/not-server-fetched.png", "/images/../escape.png", "/api/media/../escape.webp"]) {
      const invalid = creation("Invalid image");
      invalid.data.images = [imagePath];
      assert.throws(() => agent.previewCatalogOperation(invalid));
      delete invalid.data.images;
      invalid.data.variants[0].images = [imagePath];
      assert.throws(() => agent.previewCatalogOperation(invalid));
    }
    const missing = creation("Missing staged image");
    missing.data.images = [`/api/media/catalog-${"0".repeat(64)}.webp`];
    const missingPreview = agent.previewCatalogOperation(missing);
    const beforeMissingApply = snapshot();
    assert.throws(() => agent.applyCatalogOperation(missing, missingPreview.preview), /introuvable/);
    assert.deepEqual(snapshot(), beforeMissingApply);
    assert.equal(agent.catalogReceipt(missing.requestId), null);
    const image = await sharp({ create: { width: 12, height: 18, channels: 3, background: "black" } }).png().toBuffer();
    const operationFile = path.join(temp, "operation.json");
    const planFile = path.join(temp, "plan.json");
    const operation = creation("Photos");
    operation.data.images = ["https://photos.test/cover.png"];
    operation.data.variants[0].images = ["https://photos.test/variant.png"];
    fs.writeFileSync(operationFile, JSON.stringify(operation));
    const config = configuration({ CRM_CATALOG_URL: "https://crm.test", CRM_CATALOG_KEY: process.env.CATALOG_AGENT_KEY });
    assert.throws(() => configuration({ CRM_CATALOG_URL: "http://crm.test", CRM_CATALOG_KEY: config.key }), /HTTPS/);
    assert.throws(() => configuration({ CRM_CATALOG_KEY: config.key }), /CRM_CATALOG_URL/);
    assert.equal(configuration({ CRM_CATALOG_URL: "http://localhost:3000", CRM_CATALOG_KEY: config.key }).origin, "http://localhost:3000");
    const originalFetch = global.fetch;
    let liveUploads = 0;
    global.fetch = async (url, options) => {
      if (String(url).startsWith("https://photos.test/")) {
        assert.equal(options.headers, undefined);
        return new Response(image);
      }
      assert.equal(new URL(url).origin, config.origin);
      const request = new Request(url, options);
      if (new URL(url).pathname.endsWith("/upload")) {
        if (!String(url).includes("dryRun=1")) liveUploads++;
        return uploads.POST(request);
      }
      return options.method === "POST" ? routes.POST(request) : routes.GET(request);
    };
    try {
      const before = snapshot();
      const preview = await prepare(config, operationFile, planFile);
      assert.deepEqual(snapshot(), before);
      assert.equal(fs.existsSync(process.env.UPLOAD_DIR), false);
      assert.equal(liveUploads, 0);
      assert.match(preview.after.images[0], /^\/api\/media\/catalog-[a-f0-9]{64}\.webp$/);
      assert.match(preview.after.variants[0].images[0], /^\/api\/media\/catalog-[a-f0-9]{64}\.webp$/);
      const storedPlan = fs.readFileSync(planFile, "utf8");
      assert.ok(!storedPlan.includes(config.key));
      const plan = JSON.parse(storedPlan);
      const source = fs.readFileSync(plan.uploads[0].file);
      fs.writeFileSync(plan.uploads[0].file, "modified");
      await assert.rejects(() => apply(config, planFile), /photo changed/);
      assert.equal(liveUploads, 0);
      fs.writeFileSync(plan.uploads[0].file, source);
      const result = await apply(config, planFile);
      assert.equal(result.replayed, false);
      assert.equal(result.currentProduct.id, "photos");
      assert.equal(liveUploads, 2);
      assert.ok(fs.existsSync(path.join(process.env.UPLOAD_DIR, path.basename(plan.uploads[0].path))));
      assert.equal((await apply(config, planFile)).replayed, true);
      assert.equal(liveUploads, 2);
      assert.equal(revalidations, 2);
      const headers = { authorization: `Bearer ${config.key}`, "Content-Type": "application/json" };
      const forbidden = await routes.POST(new Request("https://crm.test/api/catalog-agent", {
        method: "POST", headers, body: JSON.stringify({ action: "preview", operation: { command: "receive", requestId: "forbidden-stock", data: {} } }),
      }));
      assert.equal(forbidden.status, 400);
      const invalid = new FormData();
      invalid.set("file", new Blob(["not an image"], { type: "image/png" }), "bad.png");
      const rejected = await uploads.POST(new Request("https://crm.test/api/catalog-agent/upload", {
        method: "POST", headers: { authorization: `Bearer ${config.key}` }, body: invalid,
      }));
      assert.equal(rejected.status, 400);
    } finally { global.fetch = originalFetch; }
  });
}
