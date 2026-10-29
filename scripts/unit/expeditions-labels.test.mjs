import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { loadSource } from "../test-source.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "expeditions-labels-"));
process.env.DB_PATH = path.join(dir, "crm.db");
process.env.UPLOAD_DIR = path.join(dir, "uploads");
process.env.DELIVERY_PROVIDER = "mock";
process.env.MOCK_COURIER_PROFILE = "sendit";
process.env.AUTH_SECRET = "x".repeat(40);
process.env.CRM_PUBLIC_URL = "https://crm.example.test";
process.env.SECURITY_ALLOWED_ORIGINS = "https://crm.example.test";

const originalLoad = Module._load;
let mockUser = { id: "user_test", email: "agent@example.test", role: "agent" };

class MockAuthGuardError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "AuthGuardError";
    this.status = status;
  }
  toResponse() {
    const { NextResponse } = loadSource("next/server");
    return NextResponse.json({ error: this.message }, { status: this.status });
  }
}

Module._load = function (name, ...args) {
  if (name === "server-only") return {};
  if (name.includes("auth-guards")) {
    return {
      AuthGuardError: MockAuthGuardError,
      requireUser: async () => {
        if (!mockUser) throw new MockAuthGuardError(401, "Authentification requise.");
        return mockUser;
      },
      requireAdmin: async () => {
        if (!mockUser) throw new MockAuthGuardError(401, "Authentification requise.");
        if (mockUser.role !== "admin") throw new MockAuthGuardError(403, "Accès réservé aux administrateurs.");
        return mockUser;
      },
    };
  }
  return originalLoad.call(this, name, ...args);
};

const { placeholderPdf } = loadSource("@/lib/pdf-placeholder");
const { getDb } = loadSource("@/lib/db");
const { openStock, reserveForOrder } = loadSource("@/lib/services/inventory");
const {
  getShipmentBoard,
  handoffParcel,
  handoffParcels,
  HandoffError,
} = loadSource("@/lib/services/expeditions");

const labelsRoute = loadSource("@/app/api/crm/labels/pdf/route");
const bulkHandoffRoute = loadSource("@/app/api/crm/parcels/handoff/route");

const db = getDb();

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("placeholderPdf", () => {
  test("generates valid PDF from ref string", () => {
    const bytes = placeholderPdf("BL-REF-12345");
    assert.ok(bytes instanceof Uint8Array);
    const text = new TextDecoder().decode(bytes);
    assert.ok(text.startsWith("%PDF-1.4\n"));
    assert.ok(text.includes("Bon de livraison - Mode test"));
    assert.ok(text.includes("Ref : BL-REF-12345"));
    assert.ok(text.includes("trailer\n<< /Size 6 /Root 1 0 R >>"));
    assert.ok(text.includes("%%EOF\n"));
  });

  test("generates valid PDF from title and lines", () => {
    const bytes = placeholderPdf({
      title: "Etiquettes - Mode test",
      lines: ["3 colis", "Format 10x10"],
    });
    const text = new TextDecoder().decode(bytes);
    assert.ok(text.startsWith("%PDF-1.4\n"));
    assert.ok(text.includes("Etiquettes - Mode test"));
    assert.ok(text.includes("3 colis"));
    assert.ok(text.includes("Format 10x10"));
  });
});

describe("Expeditions & Handoff with Sendit courier profile", () => {
  let orderSeq = 0;

  function setupOrder(status = "confirmed") {
    orderSeq += 1;
    const orderId = `ord_test_${orderSeq}`;
    const subId = `sub_test_${orderSeq}`;
    const tracking = `SNDMOCK${String(orderSeq).padStart(4, "0")}`;

    // Seed variant & stock
    const variantId = `var_${orderSeq}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO products (id, slug, name, category, price, created_at, updated_at)
       VALUES (?, ?, ?, 'test', 100, ?, ?)`,
    ).run(`prod_${orderSeq}`, `prod-${orderSeq}`, `Product ${orderSeq}`, now, now);

    db.prepare(
      `INSERT OR IGNORE INTO variants (id, product_id, sku, active)
       VALUES (?, ?, ?, 1)`,
    ).run(variantId, `prod_${orderSeq}`, `SKU-${orderSeq}`);

    openStock(variantId, 50, "test-setup");

    // Insert order
    db.prepare(
      `INSERT INTO orders (id, customer_name, customer_phone, items_json,
        upsell_status, subtotal, shipping, total, currency, confirmation_status, created_at, updated_at)
       VALUES (?, 'Client Test', '0612345678', ?, 'closed', 100, 0, 100, 'MAD', ?, ?, ?)`,
    ).run(
      orderId,
      JSON.stringify([{ variantId, quantity: 1, unitPrice: 100, title: "Item" }]),
      status,
      now,
      now,
    );

    if (status === "confirmed") {
      // Create stock reservation
      reserveForOrder(orderId, [{ variantId, qty: 1 }], "test", "test-source");
    }

    // Insert courier submission
    db.prepare(
      `INSERT INTO courier_submissions (id, order_id, provider, status, attempts, next_retry_at, tracking_number, created_at, updated_at)
       VALUES (?, ?, 'sendit', 'submitted', 1, ?, ?, ?, ?)`,
    ).run(subId, orderId, now, tracking, now, now);

    return { orderId, subId, tracking, variantId };
  }

  test("readyParcels shows submitted parcels without requiring BL when deliveryNotes is false", () => {
    process.env.MOCK_COURIER_PROFILE = "sendit";
    const { subId, orderId } = setupOrder();

    const board = getShipmentBoard();
    const found = board.ready.find((p) => p.submissionId === subId);
    assert.ok(found, "Parcel should be in ready list");
    assert.equal(found.orderId, orderId);
  });

  test("handoffParcel dispatches single parcel without requiring BL for Sendit, idempotent on repeat", () => {
    process.env.MOCK_COURIER_PROFILE = "sendit";
    const { subId, orderId } = setupOrder();

    const result = handoffParcel(subId, "agent@example.com");
    assert.equal(result.ok, true);
    assert.equal(result.alreadyDispatched, false);
    assert.equal(result.orderId, orderId);

    // Verify stock dispatch movement was created
    const movement = db
      .prepare("SELECT * FROM stock_movements WHERE order_id = ? AND kind = 'dispatch'")
      .get(orderId);
    assert.ok(movement, "Dispatch movement should exist");

    // Repeat handoff is idempotent
    const repeat = handoffParcel(subId, "agent@example.com");
    assert.equal(repeat.ok, true);
    assert.equal(repeat.alreadyDispatched, true);
  });

  test("handoffParcel throws French 409 when parcel is not submitted / missing tracking", () => {
    process.env.MOCK_COURIER_PROFILE = "sendit";
    const { subId } = setupOrder();

    // Update submission to failed
    db.prepare("UPDATE courier_submissions SET status = 'failed', tracking_number = NULL WHERE id = ?").run(subId);

    assert.throws(
      () => handoffParcel(subId, "agent@example.com"),
      (err) => {
        assert.ok(err instanceof HandoffError);
        assert.equal(err.status, 409);
        assert.equal(err.message, "Colis non transmis (pas de numéro de suivi) — remise au livreur impossible.");
        return true;
      },
    );
  });

  test("handoffParcels performs bulk dispatch for Sendit", () => {
    process.env.MOCK_COURIER_PROFILE = "sendit";
    const o1 = setupOrder();
    const o2 = setupOrder();

    const { results } = handoffParcels([o1.subId, o2.subId], "agent@example.com");
    assert.equal(results.length, 2);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].alreadyDispatched, false);
    assert.equal(results[1].ok, true);
    assert.equal(results[1].alreadyDispatched, false);

    // Repeat is idempotent
    const repeat = handoffParcels([o1.subId, o2.subId], "agent@example.com");
    assert.equal(repeat.results.length, 2);
    assert.equal(repeat.results[0].alreadyDispatched, true);
    assert.equal(repeat.results[1].alreadyDispatched, true);
  });

  test("handoffParcels is rejected with 409 when profile has deliveryNotes (Ozon)", () => {
    process.env.MOCK_COURIER_PROFILE = "ozon";
    const o = setupOrder();

    assert.throws(
      () => handoffParcels([o.subId], "agent@example.com"),
      (err) => {
        assert.ok(err instanceof HandoffError);
        assert.equal(err.status, 409);
        assert.equal(
          err.message,
          "Remise groupée réservée aux transporteurs sans BL — utilisez la remise par BL.",
        );
        return true;
      },
    );
  });

  test("handoffParcel for Ozon requires saved BL", () => {
    process.env.MOCK_COURIER_PROFILE = "ozon";
    const o = setupOrder();

    assert.throws(
      () => handoffParcel(o.subId, "agent@example.com"),
      (err) => {
        assert.ok(err instanceof HandoffError);
        assert.equal(err.status, 409);
        assert.equal(
          err.message,
          "Colis non transmis ou BL non enregistré — résolvez le BL avant la remise au livreur.",
        );
        return true;
      },
    );
  });

  test("API: POST /api/crm/parcels/handoff enforces origin, validation and profile", async () => {
    // 1. Unauthenticated -> 401
    mockUser = null;
    const unauth = await bulkHandoffRoute.POST(
      new Request("https://crm.example.test/api/crm/parcels/handoff", {
        method: "POST",
        headers: { origin: "https://crm.example.test", "content-type": "application/json" },
        body: JSON.stringify({ parcelIds: ["sub1"] }),
      }),
    );
    assert.equal(unauth.status, 401);

    mockUser = { id: "user_1", email: "agent@example.test", role: "agent" };

    // 2. Disallowed origin -> 403
    const badOrigin = await bulkHandoffRoute.POST(
      new Request("https://crm.example.test/api/crm/parcels/handoff", {
        method: "POST",
        headers: { origin: "https://evil.com", "content-type": "application/json" },
        body: JSON.stringify({ parcelIds: ["sub1"] }),
      }),
    );
    assert.equal(badOrigin.status, 403);

    // 3. Invalid body -> 400
    const badBody = await bulkHandoffRoute.POST(
      new Request("https://crm.example.test/api/crm/parcels/handoff", {
        method: "POST",
        headers: { origin: "https://crm.example.test", "content-type": "application/json" },
        body: JSON.stringify({ parcelIds: [] }),
      }),
    );
    assert.equal(badBody.status, 400);

    // 4. When Ozon -> 409
    process.env.MOCK_COURIER_PROFILE = "ozon";
    const ozonRes = await bulkHandoffRoute.POST(
      new Request("https://crm.example.test/api/crm/parcels/handoff", {
        method: "POST",
        headers: { origin: "https://crm.example.test", "content-type": "application/json" },
        body: JSON.stringify({ parcelIds: ["sub1"] }),
      }),
    );
    assert.equal(ozonRes.status, 409);
    const ozonBody = await ozonRes.json();
    assert.equal(
      ozonBody.error,
      "Remise groupée réservée aux transporteurs sans BL — utilisez la remise par BL.",
    );

    // 5. When Sendit -> 200 with results
    process.env.MOCK_COURIER_PROFILE = "sendit";
    const ord1 = setupOrder();
    const senditRes = await bulkHandoffRoute.POST(
      new Request("https://crm.example.test/api/crm/parcels/handoff", {
        method: "POST",
        headers: { origin: "https://crm.example.test", "content-type": "application/json" },
        body: JSON.stringify({ parcelIds: [ord1.subId] }),
      }),
    );
    assert.equal(senditRes.status, 200);
    const senditBody = await senditRes.json();
    assert.equal(senditBody.results.length, 1);
    assert.equal(senditBody.results[0].ok, true);
  });

  test("API: GET /api/crm/labels/pdf enforces capability, query validation and formats", async () => {
    // 1. Unauthenticated -> 401
    mockUser = null;
    const unauth = await labelsRoute.GET(
      new Request("https://crm.example.test/api/crm/labels/pdf?ids=sub1&format=10x10"),
    );
    assert.equal(unauth.status, 401);

    mockUser = { id: "user_1", email: "agent@example.test", role: "agent" };

    // 2. When Ozon (labels capability is false) -> 409
    process.env.MOCK_COURIER_PROFILE = "ozon";
    const ozonRes = await labelsRoute.GET(
      new Request("https://crm.example.test/api/crm/labels/pdf?ids=sub1&format=10x10"),
    );
    assert.equal(ozonRes.status, 409);
    const ozonBody = await ozonRes.json();
    assert.equal(ozonBody.error, "Ce transporteur ne prend pas en charge les étiquettes.");

    // 3. When Sendit -> parameter validation
    process.env.MOCK_COURIER_PROFILE = "sendit";

    // Missing ids -> 400
    const missingIds = await labelsRoute.GET(
      new Request("https://crm.example.test/api/crm/labels/pdf?format=10x10"),
    );
    assert.equal(missingIds.status, 400);

    // Invalid format -> 400
    const badFormat = await labelsRoute.GET(
      new Request("https://crm.example.test/api/crm/labels/pdf?ids=sub1&format=a4"),
    );
    assert.equal(badFormat.status, 400);

    // Non-existent submissions -> 404
    const notFound = await labelsRoute.GET(
      new Request("https://crm.example.test/api/crm/labels/pdf?ids=unknown_sub_id&format=10x10"),
    );
    assert.equal(notFound.status, 404);

    // Valid submissions -> 200 with PDF
    const o = setupOrder();
    const success = await labelsRoute.GET(
      new Request(`https://crm.example.test/api/crm/labels/pdf?ids=${o.subId}&format=10x10`),
    );
    assert.equal(success.status, 200);
    assert.equal(success.headers.get("Content-Type"), "application/pdf");
    assert.equal(success.headers.get("Cache-Control"), "no-store");
    assert.equal(success.headers.get("X-Labels-Skipped"), "0");
    const bytes = new Uint8Array(await success.arrayBuffer());
    assert.ok(bytes.length > 0);
    const pdfText = new TextDecoder().decode(bytes);
    assert.ok(pdfText.startsWith("%PDF-1.4\n"));
    assert.ok(pdfText.includes("Etiquettes - Mode test"));
    assert.ok(pdfText.includes("1 colis"));

    // Partial match -> 200 with X-Labels-Skipped count
    const partial = await labelsRoute.GET(
      new Request(`https://crm.example.test/api/crm/labels/pdf?ids=${o.subId},nonexistent_id&format=10x10`),
    );
    assert.equal(partial.status, 200);
    assert.equal(partial.headers.get("X-Labels-Skipped"), "1");
  });
});
