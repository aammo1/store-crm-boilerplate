import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "../test-source.mjs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "courier-lookup-"));
process.env.DELIVERY_PROVIDER = "mock";
process.env.MOCK_COURIER_PROFILE = "sendit";
process.env.DB_PATH = path.join(tempDir, "test.db");
process.env.CRM_PUBLIC_URL = "https://crm.example.test";
process.env.SECURITY_ALLOWED_ORIGINS = "https://crm.example.test";

const { getDb } = loadSource("@/lib/db");
const { lookupSubmissionAtCourier, LookupError } = loadSource("@/lib/services/courier-lookup");
const { ProviderError } = loadSource("@/lib/shipping/errors");
const { createMockProvider } = loadSource("@/lib/shipping/mock");

const db = getDb();

after(() => {
  try { db.close(); } catch {}
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const now = new Date().toISOString();

db.prepare(`
  INSERT INTO orders (id, customer_name, customer_phone, items_json, subtotal, shipping, total, confirmation_status, created_at, updated_at)
  VALUES
    ('ord_review', 'Fatima Zahra', '+212612345678', '[]', 250, 0, 250, 'confirmed', ?, ?),
    ('ord_failed', 'Ahmed Bennani', '+212712345678', '[]', 350, 0, 350, 'confirmed', ?, ?),
    ('ord_queued', 'Khadija Alami', '+212698765432', '[]', 150, 0, 150, 'confirmed', ?, ?)
`).run(now, now, now, now, now, now);

db.prepare(`
  INSERT INTO courier_submissions (id, order_id, provider, status, attempts, next_retry_at, payload_json, created_at, updated_at)
  VALUES
    ('sub_review', 'ord_review', 'sendit', 'needs_review', 1, ?, '{"order_id":"ord_review","customer_phone":"+212612345678","courier_reference":"demo-ord_review"}', ?, ?),
    ('sub_failed', 'ord_failed', 'sendit', 'failed', 3, ?, '{"order_id":"ord_failed","customer_phone":"+212712345678","courier_reference":"demo-ord_failed"}', ?, ?),
    ('sub_queued', 'ord_queued', 'sendit', 'queued', 0, ?, '{"order_id":"ord_queued","customer_phone":"+212698765432","courier_reference":"demo-ord_queued"}', ?, ?)
`).run(now, now, now, now, now, now, now, now, now);

test("lookup rejects missing submission or invalid status with appropriate status codes", async () => {
  await assert.rejects(
    () => lookupSubmissionAtCourier("sub_nonexistent"),
    (err) => err instanceof LookupError && err.status === 404,
  );

  await assert.rejects(
    () => lookupSubmissionAtCourier("sub_queued"),
    (err) => err instanceof LookupError && err.status === 409,
  );
});

test("lookup rejects provider without parcelLookup capability", async () => {
  const ozonMock = createMockProvider({ profile: "ozon" });
  assert.equal(ozonMock.capabilities.parcelLookup, false);

  await assert.rejects(
    () => lookupSubmissionAtCourier("sub_review", { getProvider: () => ozonMock }),
    (err) => err instanceof LookupError && err.status === 409,
  );
});

test("found: returns tracking number and mapped French status label for Sendit profile", async () => {
  const senditMock = createMockProvider({ profile: "sendit" });
  // Simulate mock having created a parcel with code SND999
  const customProvider = {
    ...senditMock,
    capabilities: senditMock.capabilities,
    profile: "sendit",
    async findParcelByReference(ref, phone) {
      assert.equal(ref, "demo-ord_review");
      assert.equal(phone, "0612345678");
      return {
        complete: true,
        parcel: { trackingNumber: "SND999", rawStatus: "PENDING" },
      };
    },
  };

  const result = await lookupSubmissionAtCourier("sub_review", { getProvider: () => customProvider });
  assert.deepEqual(result, {
    status: "found",
    trackingNumber: "SND999",
    rawStatus: "PENDING",
    statusLabel: "En attente",
    reference: "demo-ord_review",
  });
});

test("not_found: returns not_found when courier search was complete but no parcel was found", async () => {
  const customProvider = {
    profile: "sendit",
    capabilities: { parcelLookup: true },
    async findParcelByReference(ref, phone) {
      assert.equal(ref, "demo-ord_failed");
      assert.equal(phone, "0712345678");
      return { complete: true, parcel: null };
    },
  };

  const result = await lookupSubmissionAtCourier("sub_failed", { getProvider: () => customProvider });
  assert.deepEqual(result, {
    status: "not_found",
    reference: "demo-ord_failed",
  });
});

test("inconclusive: returns inconclusive when search could not complete", async () => {
  const customProvider = {
    profile: "sendit",
    capabilities: { parcelLookup: true },
    async findParcelByReference() {
      return { complete: false, parcel: null };
    },
  };

  const result = await lookupSubmissionAtCourier("sub_review", { getProvider: () => customProvider });
  assert.deepEqual(result, {
    status: "inconclusive",
    reference: "demo-ord_review",
    message: "Recherche incomplète — vérifiez sur le portail.",
  });
});

test("inconclusive: ProviderError is mapped to inconclusive with redacted message", async () => {
  const customProvider = {
    profile: "sendit",
    capabilities: { parcelLookup: true },
    async findParcelByReference() {
      throw new ProviderError(
        "retryable",
        "Sendit timeout on https://app.sendit.ma/api/v1/deliveries?token=secret123",
      );
    },
  };

  const result = await lookupSubmissionAtCourier("sub_review", { getProvider: () => customProvider });
  assert.equal(result.status, "inconclusive");
  assert.equal(result.reference, "demo-ord_review");
  assert.doesNotMatch(result.message, /secret123/);
  assert.match(result.message, /Sendit timeout/);
});

test("no database writes occur during lookup", async () => {
  const beforeSub = db.prepare("SELECT * FROM courier_submissions WHERE id = 'sub_review'").get();
  const beforeCount = db.prepare("SELECT COUNT(*) as count FROM submission_resolutions").get();

  const customProvider = {
    profile: "sendit",
    capabilities: { parcelLookup: true },
    async findParcelByReference() {
      return { complete: true, parcel: { trackingNumber: "SND100", rawStatus: "DELIVERED" } };
    },
  };

  await lookupSubmissionAtCourier("sub_review", { getProvider: () => customProvider });

  const afterSub = db.prepare("SELECT * FROM courier_submissions WHERE id = 'sub_review'").get();
  const afterCount = db.prepare("SELECT COUNT(*) as count FROM submission_resolutions").get();

  assert.deepEqual(beforeSub, afterSub);
  assert.equal(beforeCount.count, afterCount.count);
});

test("route POST /api/crm/submissions/[id]/lookup auth, origin guard, error and success mapping", async () => {
  let mockUser = null;
  const original = Module._load;
  Module._load = function (request, ...args) {
    if (request === "server-only") return {};
    if (request === "@/lib/auth-guards") {
      const { NextResponse } = loadSource("next/server");
      class AuthGuardError extends Error {
        constructor(status, message) {
          super(message);
          this.name = "AuthGuardError";
          this.status = status;
        }
        toResponse() {
          return NextResponse.json({ error: this.message }, { status: this.status });
        }
      }
      return {
        AuthGuardError,
        requireUser: async () => {
          if (!mockUser) throw new AuthGuardError(401, "Authentification requise.");
          return mockUser;
        },
      };
    }
    return original.call(this, request, ...args);
  };

  let route;
  try {
    route = loadSource("@/app/api/crm/submissions/[id]/lookup/route");
  } finally {
    Module._load = original;
  }

  // 1. Unauthenticated -> 401
  mockUser = null;
  const unauthRes = await route.POST(
    new Request("https://crm.example.test/api/crm/submissions/sub_review/lookup", {
      method: "POST",
      headers: { origin: "https://crm.example.test" },
    }),
    { params: Promise.resolve({ id: "sub_review" }) },
  );
  assert.equal(unauthRes.status, 401);

  // 2. Disallowed origin -> 403
  mockUser = { id: "agent-1", role: "agent" };
  const badOriginRes = await route.POST(
    new Request("https://crm.example.test/api/crm/submissions/sub_review/lookup", {
      method: "POST",
      headers: { origin: "https://evil.com" },
    }),
    { params: Promise.resolve({ id: "sub_review" }) },
  );
  assert.equal(badOriginRes.status, 403);
  assert.equal(badOriginRes.headers.get("Cache-Control"), "no-store");
  const badOriginBody = await badOriginRes.json();
  assert.equal(badOriginBody.error, "Origine non autorisée.");

  // 3. LookupError 404 (nonexistent submission)
  const notFoundRes = await route.POST(
    new Request("https://crm.example.test/api/crm/submissions/sub_nonexistent/lookup", {
      method: "POST",
      headers: { origin: "https://crm.example.test" },
    }),
    { params: Promise.resolve({ id: "sub_nonexistent" }) },
  );
  assert.equal(notFoundRes.status, 404);
  assert.equal(notFoundRes.headers.get("Cache-Control"), "no-store");

  // 4. LookupError 409 (queued submission)
  const conflictRes = await route.POST(
    new Request("https://crm.example.test/api/crm/submissions/sub_queued/lookup", {
      method: "POST",
      headers: { origin: "https://crm.example.test" },
    }),
    { params: Promise.resolve({ id: "sub_queued" }) },
  );
  assert.equal(conflictRes.status, 409);
  assert.equal(conflictRes.headers.get("Cache-Control"), "no-store");

  // 5. Success -> 200 with Cache-Control: no-store
  const successRes = await route.POST(
    new Request("https://crm.example.test/api/crm/submissions/sub_review/lookup", {
      method: "POST",
      headers: { origin: "https://crm.example.test" },
    }),
    { params: Promise.resolve({ id: "sub_review" }) },
  );
  assert.equal(successRes.status, 200);
  assert.equal(successRes.headers.get("Cache-Control"), "no-store");
  const body = await successRes.json();
  assert.ok(["found", "not_found", "inconclusive"].includes(body.status));
});
