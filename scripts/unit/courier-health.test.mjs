import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "../test-source.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "courier-health-"));
process.env.DELIVERY_PROVIDER = "mock";
process.env.DB_PATH = path.join(dir, "crm.db");
process.env.AUTH_SECRET = "x".repeat(40);
process.env.CRM_PUBLIC_URL = "https://crm.example.test";
process.env.SECURITY_ALLOWED_ORIGINS = "https://crm.example.test";
process.env.HEALTH_DETAILS_TOKEN = "a".repeat(32);

const originalLoad = Module._load;
let mockUser = { id: "user_test", email: "admin@example.test", role: "admin" };

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

const { getDb } = loadSource("@/lib/db");
const db = getDb();
const { getCourierHealth, __resetCourierTestThrottle } = loadSource("@/lib/services/courier-health");
const { getDashboard, countDeliveryIssues } = loadSource("@/lib/services/dashboard");
const { POST: courierTestPost } = loadSource("@/app/api/crm/courier/test/route");
const { GET: healthGet } = loadSource("@/app/api/health/route");
const { setAppState } = loadSource("@/lib/services/app-state");
const { TRACKING_LAST_SYNC_KEY } = loadSource("@/lib/services/tracking");

after(() => {
  Module._load = originalLoad;
  try { db.close(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
});

// Ensure columns exist if not present in test schema
const columns = db.prepare("PRAGMA table_info(cities)").all().map((c) => c.name);
if (!columns.includes("provider")) {
  db.exec("ALTER TABLE cities ADD COLUMN provider TEXT NOT NULL DEFAULT 'ozon'");
}
if (!columns.includes("is_pickup")) {
  db.exec("ALTER TABLE cities ADD COLUMN is_pickup INTEGER NOT NULL DEFAULT 0 CHECK (is_pickup IN (0,1))");
}

const subCols = db.prepare("PRAGMA table_info(courier_submissions)").all().map((c) => c.name);
if (!subCols.includes("provider")) {
  db.exec("ALTER TABLE courier_submissions ADD COLUMN provider TEXT NOT NULL DEFAULT 'ozon'");
}

const now = new Date().toISOString();
db.prepare(`
  INSERT INTO cities (id, name, updated_at, provider, is_pickup) VALUES
    (101, 'Casablanca', ?, 'mock', 1),
    (102, 'Rabat', ?, 'mock', 0),
    (103, 'Marrakech', ?, 'ozon', 1)
`).run(now, now, now);

test("getCourierHealth returns correct shape for mock Ozon", () => {
  const origProvider = process.env.DELIVERY_PROVIDER;
  const origProfile = process.env.MOCK_COURIER_PROFILE;
  try {
    process.env.DELIVERY_PROVIDER = "mock";
    process.env.MOCK_COURIER_PROFILE = "ozon";

    const health = getCourierHealth();
    assert.equal(health.courier, "ozon");
    assert.equal(health.label, "Ozon Express");
    assert.equal(health.mode, "mock");
    assert.equal(health.configured, true);
    assert.deepEqual(health.issues, []);
    assert.equal(health.citiesCount, 2); // 2 cities with provider = 'mock'
    assert.equal(health.pickupDistrictSet, null); // Ozon has no pickup district capability
    assert.equal(health.queuedBlocked, 0);
  } finally {
    process.env.DELIVERY_PROVIDER = origProvider;
    if (origProfile !== undefined) process.env.MOCK_COURIER_PROFILE = origProfile;
    else delete process.env.MOCK_COURIER_PROFILE;
  }
});

test("getCourierHealth returns correct shape for mock Sendit", () => {
  const origProvider = process.env.DELIVERY_PROVIDER;
  const origProfile = process.env.MOCK_COURIER_PROFILE;
  try {
    process.env.DELIVERY_PROVIDER = "mock";
    process.env.MOCK_COURIER_PROFILE = "sendit";

    const health = getCourierHealth();
    assert.equal(health.courier, "sendit");
    assert.equal(health.label, "Sendit");
    assert.equal(health.mode, "mock");
    assert.equal(health.configured, true);
    assert.deepEqual(health.issues, []);
    assert.equal(health.citiesCount, 2);
    // Sendit capability pickupDistrict is true; no setting chosen yet -> false
    assert.equal(health.pickupDistrictSet, false);
    assert.equal(health.queuedBlocked, 0);
  } finally {
    process.env.DELIVERY_PROVIDER = origProvider;
    if (origProfile !== undefined) process.env.MOCK_COURIER_PROFILE = origProfile;
    else delete process.env.MOCK_COURIER_PROFILE;
  }
});

test("getCourierHealth detects zero cities and queued jobs blocked when unconfigured", () => {
  const origProvider = process.env.DELIVERY_PROVIDER;
  try {
    // When provider is 'sendit', there are 0 cities with provider = 'sendit' in DB
    process.env.DELIVERY_PROVIDER = "sendit";
    delete process.env.SENDIT_PUBLIC_KEY;
    delete process.env.SENDIT_SECRET_KEY;

    // Insert order and queued submission
    db.prepare(`
      INSERT INTO orders (id, customer_name, customer_phone, items_json, subtotal, shipping, total, created_at, updated_at)
      VALUES ('ord-1', 'Test', '+212612345678', '[]', 100, 0, 100, ?, ?)
    `).run(now, now);

    db.prepare(`
      INSERT INTO courier_submissions (id, order_id, provider, status, attempts, next_retry_at, created_at, updated_at)
      VALUES ('sub-health-1', 'ord-1', 'sendit', 'queued', 0, ?, ?, ?)
    `).run(now, now, now);

    const health = getCourierHealth();
    assert.equal(health.courier, "sendit");
    assert.equal(health.configured, false);
    assert.equal(health.citiesCount, 0);
    assert.ok(health.issues.some((i) => i.includes("Aucune ville synchronisée")));
    assert.ok(health.issues.some((i) => i.includes("Clés Sendit manquantes")));
    assert.ok(health.queuedBlocked >= 1);
  } finally {
    process.env.DELIVERY_PROVIDER = origProvider;
    db.prepare("DELETE FROM courier_submissions WHERE id = 'sub-health-1'").run();
    db.prepare("DELETE FROM orders WHERE id = 'ord-1'").run();
  }
});

test("mock Sendit without pickup district stays ready but warns with the reason", () => {
  const origProvider = process.env.DELIVERY_PROVIDER;
  const origProfile = process.env.MOCK_COURIER_PROFILE;
  try {
    process.env.DELIVERY_PROVIDER = "mock";
    process.env.MOCK_COURIER_PROFILE = "sendit";
    db.prepare("DELETE FROM app_state WHERE key = 'courier_settings'").run();

    const health = getCourierHealth();
    assert.equal(health.pickupDistrictSet, false);
    assert.equal(health.configured, true);
    assert.deepEqual(health.issues, []);
    assert.equal(health.warnings.length, 1);
    assert.match(health.warnings[0], /District de ramassage non choisi/);

    const ozon = (process.env.MOCK_COURIER_PROFILE = "ozon", getCourierHealth());
    assert.deepEqual(ozon.warnings, []);
    assert.equal(ozon.pickupDistrictSet, null);
  } finally {
    process.env.DELIVERY_PROVIDER = origProvider;
    if (origProfile !== undefined) process.env.MOCK_COURIER_PROFILE = origProfile;
    else delete process.env.MOCK_COURIER_PROFILE;
  }
});

test("saved pickup district that is no longer a pickup city is reported; valid one is not", () => {
  const origProvider = process.env.DELIVERY_PROVIDER;
  const origProfile = process.env.MOCK_COURIER_PROFILE;
  try {
    process.env.DELIVERY_PROVIDER = "mock";
    process.env.MOCK_COURIER_PROFILE = "sendit";
    setAppState("courier_settings", JSON.stringify({ senditPickupDistrictId: 101, senditAllowOpen: true, senditAllowTry: false }));
    let health = getCourierHealth();
    assert.equal(health.pickupDistrictSet, true);
    assert.deepEqual(health.warnings, []);

    setAppState("courier_settings", JSON.stringify({ senditPickupDistrictId: 102, senditAllowOpen: true, senditAllowTry: false }));
    health = getCourierHealth();
    assert.equal(health.pickupDistrictSet, true);
    assert.equal(health.warnings.length, 1);
    assert.match(health.warnings[0], /n'est plus un district de ramassage valide/);
    assert.equal(health.configured, true, "non-blocking: jobs are not held back by this warning");
  } finally {
    db.prepare("DELETE FROM app_state WHERE key = 'courier_settings'").run();
    process.env.DELIVERY_PROVIDER = origProvider;
    if (origProfile !== undefined) process.env.MOCK_COURIER_PROFILE = origProfile;
    else delete process.env.MOCK_COURIER_PROFILE;
  }
});

test("queuedBlocked ignores an empty city list when the provider itself is configured", () => {
  const origProvider = process.env.DELIVERY_PROVIDER;
  const origProfile = process.env.MOCK_COURIER_PROFILE;
  try {
    process.env.DELIVERY_PROVIDER = "mock";
    process.env.MOCK_COURIER_PROFILE = "ozon";
    db.prepare("INSERT INTO orders (id, customer_name, customer_phone, items_json, subtotal, shipping, total, created_at, updated_at) VALUES ('ord-qb', 'T', '+212612345678', '[]', 1, 0, 1, ?, ?)").run(now, now);
    db.prepare("INSERT INTO courier_submissions (id, order_id, provider, status, attempts, next_retry_at, created_at, updated_at) VALUES ('sub-qb', 'ord-qb', 'mock', 'queued', 0, ?, ?, ?)").run(now, now, now);
    db.prepare("UPDATE cities SET provider = 'ozon' WHERE provider = 'mock'").run();
    try {
      const health = getCourierHealth();
      assert.equal(health.citiesCount, 0);
      assert.ok(health.issues.some((i) => i.includes("Aucune ville synchronisée")));
      assert.equal(health.configured, false);
      assert.equal(health.queuedBlocked, 0, "queued jobs are not blocked by missing cities");
    } finally {
      db.prepare("UPDATE cities SET provider = 'mock' WHERE id IN (101, 102)").run();
    }
  } finally {
    db.prepare("DELETE FROM courier_submissions WHERE id = 'sub-qb'").run();
    db.prepare("DELETE FROM orders WHERE id = 'ord-qb'").run();
    process.env.DELIVERY_PROVIDER = origProvider;
    if (origProfile !== undefined) process.env.MOCK_COURIER_PROFILE = origProfile;
    else delete process.env.MOCK_COURIER_PROFILE;
  }
});

test("getCourierHealth tracks needs_review, delivery_issue and tracking last sync", () => {
  const syncTime = new Date().toISOString();
  setAppState(TRACKING_LAST_SYNC_KEY, syncTime);

  db.prepare(`
    INSERT INTO orders (id, customer_name, customer_phone, items_json, subtotal, shipping, total, created_at, updated_at)
    VALUES
      ('ord-2', 'Test 2', '+212612345678', '[]', 100, 0, 100, ?, ?),
      ('ord-3', 'Test 3', '+212612345678', '[]', 100, 0, 100, ?, ?)
  `).run(now, now, now, now);

  db.prepare(`
    INSERT INTO courier_submissions (id, order_id, provider, status, normalized_status, attempts, next_retry_at, created_at, updated_at)
    VALUES
      ('sub-nr-1', 'ord-2', 'mock', 'needs_review', NULL, 1, ?, ?, ?),
      ('sub-di-1', 'ord-3', 'mock', 'submitted', 'delivery_issue', 1, ?, ?, ?)
  `).run(now, now, now, now, now, now);

  try {
    const health = getCourierHealth();
    assert.ok(health.needsReview >= 1);
    assert.ok(health.deliveryIssues >= 1);
    assert.equal(health.lastTrackingSyncAt, syncTime);

    // Also check dashboard deliveryIssuesCount
    assert.ok(countDeliveryIssues() >= 1);
    const dashboard = getDashboard();
    assert.ok(dashboard.deliveryIssuesCount >= 1);
  } finally {
    db.prepare("DELETE FROM courier_submissions WHERE id IN ('sub-nr-1', 'sub-di-1')").run();
    db.prepare("DELETE FROM orders WHERE id IN ('ord-2', 'ord-3')").run();
  }
});

test("/api/health: public mode hides courier; details mode includes courier without secrets", async () => {
  // Public request (no auth)
  const pubReq = new Request("https://crm.example.test/api/health");
  const pubRes = await healthGet(pubReq);
  assert.equal(pubRes.status, 200);
  const pubData = await pubRes.json();
  assert.equal(pubData.status, "ok");
  assert.equal(pubData.courier, undefined);
  assert.equal(pubData.workers, undefined);

  // Details request (authorized)
  const privReq = new Request("https://crm.example.test/api/health", {
    headers: { Authorization: `Bearer ${process.env.HEALTH_DETAILS_TOKEN}` },
  });
  const privRes = await healthGet(privReq);
  assert.equal(privRes.status, 200);
  const privData = await privRes.json();
  assert.ok(privData.courier, "courier block present in details mode");
  assert.equal(privData.courier.name, "mock");
  assert.equal(privData.courier.profile, "ozon");
  assert.equal(typeof privData.courier.configured, "boolean");
  assert.ok(Array.isArray(privData.courier.issues));
  assert.equal(typeof privData.courier.citiesCount, "number");
});

test("POST /api/crm/courier/test: enforces admin, allowed origin, and throttle", async () => {
  __resetCourierTestThrottle();

  // Non-admin -> 403
  mockUser = { id: "agent_1", email: "agent@example.test", role: "agent" };
  const nonAdminReq = new Request("https://crm.example.test/api/crm/courier/test", {
    method: "POST",
    headers: { Origin: "https://crm.example.test" },
  });
  const nonAdminRes = await courierTestPost(nonAdminReq);
  assert.equal(nonAdminRes.status, 403);

  // Disallowed origin -> 403
  mockUser = { id: "admin_1", email: "admin@example.test", role: "admin" };
  const badOriginReq = new Request("https://crm.example.test/api/crm/courier/test", {
    method: "POST",
    headers: { Origin: "https://evil.example.test" },
  });
  const badOriginRes = await courierTestPost(badOriginReq);
  assert.equal(badOriginRes.status, 403);

  // Valid admin call -> 200 { ok: true } (mock provider)
  const validReq = new Request("https://crm.example.test/api/crm/courier/test", {
    method: "POST",
    headers: { Origin: "https://crm.example.test" },
  });
  const validRes = await courierTestPost(validReq);
  assert.equal(validRes.status, 200);
  const validData = await validRes.json();
  assert.equal(validData.ok, true);

  // Immediate 2nd call -> 429
  const throttledReq = new Request("https://crm.example.test/api/crm/courier/test", {
    method: "POST",
    headers: { Origin: "https://crm.example.test" },
  });
  const throttledRes = await courierTestPost(throttledReq);
  assert.equal(throttledRes.status, 429);
  const throttledData = await throttledRes.json();
  assert.equal(throttledData.ok, false);
  assert.ok(throttledData.error.includes("10 secondes"));
});
