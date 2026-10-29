import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "../test-source.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "courier-settings-"));
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
const service = loadSource("@/lib/services/courier-settings");
const db = getDb();

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// Ensure columns exist if migration 029 is not yet present
const columns = db.prepare("PRAGMA table_info(cities)").all().map((c) => c.name);
if (!columns.includes("provider")) {
  db.exec("ALTER TABLE cities ADD COLUMN provider TEXT NOT NULL DEFAULT 'ozon'");
}
if (!columns.includes("is_pickup")) {
  db.exec("ALTER TABLE cities ADD COLUMN is_pickup INTEGER NOT NULL DEFAULT 0 CHECK (is_pickup IN (0,1))");
}

const now = new Date().toISOString();
db.prepare(`
  INSERT INTO cities (id, name, updated_at, provider, is_pickup) VALUES
    (1, 'Maârif - Casablanca', ?, 'mock', 1),
    (2, 'Hay Riad - Rabat', ?, 'mock', 0),
    (3, 'Gueliz - Marrakech', ?, 'ozon', 1),
    (4, 'Agdal - Rabat', ?, 'mock', 1)
`).run(now, now, now, now);

test("defaults returned without writing; pickup districts list by provider", () => {
  // Missing state returns defaults
  const settings = service.getCourierSettings();
  assert.deepEqual(settings, {
    senditPickupDistrictId: null,
    senditAllowOpen: true,
    senditAllowTry: false,
  });

  // No boot-time writes
  const savedRow = db.prepare("SELECT value FROM app_state WHERE key = ?").get(service.COURIER_SETTINGS_KEY);
  assert.equal(savedRow, undefined);

  // listPickupDistricts returns only is_pickup = 1 for the matching provider, sorted by name
  const mockDistricts = service.listPickupDistricts("mock");
  assert.deepEqual(mockDistricts, [
    { id: 4, name: "Agdal - Rabat" },
    { id: 1, name: "Maârif - Casablanca" },
  ]);

  const ozonDistricts = service.listPickupDistricts("ozon");
  assert.deepEqual(ozonDistricts, [
    { id: 3, name: "Gueliz - Marrakech" },
  ]);

  const emptyDistricts = service.listPickupDistricts("unknown");
  assert.deepEqual(emptyDistricts, []);
});

test("partial update merges and persists in app_state", () => {
  // First partial update merges with defaults
  const res1 = service.updateCourierSettings({ senditAllowOpen: false });
  assert.deepEqual(res1, {
    senditPickupDistrictId: null,
    senditAllowOpen: false,
    senditAllowTry: false,
  });

  const row1 = db.prepare("SELECT value FROM app_state WHERE key = ?").get(service.COURIER_SETTINGS_KEY);
  assert.ok(row1);
  assert.deepEqual(JSON.parse(row1.value), res1);

  // Second partial update merges with current state
  const res2 = service.updateCourierSettings({ senditAllowTry: true });
  assert.deepEqual(res2, {
    senditPickupDistrictId: null,
    senditAllowOpen: false,
    senditAllowTry: true,
  });

  const row2 = db.prepare("SELECT value FROM app_state WHERE key = ?").get(service.COURIER_SETTINGS_KEY);
  assert.deepEqual(JSON.parse(row2.value), res2);
  assert.deepEqual(service.getCourierSettings(), res2);
});

test("unknown/non-pickup district throws status 400 with expected message", () => {
  // Non-existent district id
  assert.throws(
    () => service.updateCourierSettings({ senditPickupDistrictId: 9999 }),
    (err) => err.status === 400 && err.message.includes("District de ramassage inconnu"),
  );

  // District exists but is_pickup = 0
  assert.throws(
    () => service.updateCourierSettings({ senditPickupDistrictId: 2 }),
    (err) => err.status === 400 && err.message.includes("District de ramassage inconnu"),
  );

  // District exists and is_pickup = 1, but for a different provider ('ozon' vs active 'mock')
  assert.throws(
    () => service.updateCourierSettings({ senditPickupDistrictId: 3 }),
    (err) => err.status === 400 && err.message.includes("District de ramassage inconnu"),
  );

  // Schema-level validation rejects invalid values
  assert.throws(() => service.updateCourierSettings({ senditPickupDistrictId: -1 }));
  assert.throws(() => service.updateCourierSettings({ unknownKey: "foo" }));
});

test("valid pickup district is saved and can be reset to null", () => {
  // Valid district for provider 'mock'
  const res = service.updateCourierSettings({ senditPickupDistrictId: 1 });
  assert.equal(res.senditPickupDistrictId, 1);
  assert.equal(res.senditAllowOpen, false);
  assert.equal(res.senditAllowTry, true);

  assert.equal(service.getCourierSettings().senditPickupDistrictId, 1);

  // Reset to null
  const reset = service.updateCourierSettings({ senditPickupDistrictId: null });
  assert.equal(reset.senditPickupDistrictId, null);
  assert.equal(service.getCourierSettings().senditPickupDistrictId, null);
});

test("corrupt JSON in app_state throws", () => {
  // Invalid JSON string
  db.prepare("UPDATE app_state SET value = ? WHERE key = ?").run("{ corrupt", service.COURIER_SETTINGS_KEY);
  assert.throws(() => service.getCourierSettings());

  // Valid JSON but invalid schema
  db.prepare("UPDATE app_state SET value = ? WHERE key = ?").run(
    JSON.stringify({ senditAllowOpen: "not-a-bool" }),
    service.COURIER_SETTINGS_KEY,
  );
  assert.throws(() => service.getCourierSettings());

  // Clean up corrupt state so subsequent tests have clean state
  db.prepare("DELETE FROM app_state WHERE key = ?").run(service.COURIER_SETTINGS_KEY);
});

test("API route GET and PUT enforcement", async () => {
  // Restore valid settings first
  service.updateCourierSettings({ senditPickupDistrictId: 1, senditAllowOpen: true, senditAllowTry: false });

  // Load route with mock auth
  let mockUser = null;
  const original = Module._load;
  Module._load = function (request, ...args) {
    if (request === "@/lib/auth-guards") {
      class AuthGuardError extends Error {
        constructor(status, message) {
          super(message);
          this.name = "AuthGuardError";
          this.status = status;
        }
      }
      return {
        AuthGuardError,
        requireAdmin: async () => {
          if (!mockUser) throw new AuthGuardError(401, "Authentification requise.");
          if (mockUser.role !== "admin") throw new AuthGuardError(403, "Accès réservé aux administrateurs.");
          return mockUser;
        },
      };
    }
    return original.call(this, request, ...args);
  };

  let route;
  try {
    route = loadSource("@/app/api/crm/courier-settings/route");
  } finally {
    Module._load = original;
  }

  // 1. GET unauthenticated -> 401
  mockUser = null;
  const unauthGet = await route.GET();
  assert.equal(unauthGet.status, 401);

  // 2. GET as agent -> 403
  mockUser = { id: "agent-1", role: "agent" };
  const agentGet = await route.GET();
  assert.equal(agentGet.status, 403);

  // 3. GET as admin -> 200 with settings and pickupDistricts
  mockUser = { id: "admin-1", role: "admin" };
  const adminGet = await route.GET();
  assert.equal(adminGet.status, 200);
  assert.equal(adminGet.headers.get("Cache-Control"), "no-store");
  const getBody = await adminGet.json();
  assert.equal(getBody.settings.senditPickupDistrictId, 1);
  assert.equal(getBody.pickupDistricts.length, 2);

  // 4. PUT unauthenticated -> 401
  mockUser = null;
  const unauthPut = await route.PUT(new Request("https://crm.example.test/api/crm/courier-settings", {
    method: "PUT",
    headers: { origin: "https://crm.example.test", "content-type": "application/json" },
    body: JSON.stringify({ senditAllowOpen: false }),
  }));
  assert.equal(unauthPut.status, 401);

  // 5. PUT disallowed origin -> 403
  mockUser = { id: "admin-1", role: "admin" };
  const badOriginPut = await route.PUT(new Request("https://crm.example.test/api/crm/courier-settings", {
    method: "PUT",
    headers: { origin: "https://evil.com", "content-type": "application/json" },
    body: JSON.stringify({ senditAllowOpen: false }),
  }));
  assert.equal(badOriginPut.status, 403);
  const badOriginBody = await badOriginPut.json();
  assert.equal(badOriginBody.error, "Origine non autorisée.");

  // 6. PUT invalid schema -> 400 "Paramètres invalides."
  const invalidSchemaPut = await route.PUT(new Request("https://crm.example.test/api/crm/courier-settings", {
    method: "PUT",
    headers: { origin: "https://crm.example.test", "content-type": "application/json" },
    body: JSON.stringify({ invalidField: "bad" }),
  }));
  assert.equal(invalidSchemaPut.status, 400);
  const invalidSchemaBody = await invalidSchemaPut.json();
  assert.equal(invalidSchemaBody.error, "Paramètres invalides.");

  // 7. PUT unknown pickup district -> 400 with service message
  const invalidDistrictPut = await route.PUT(new Request("https://crm.example.test/api/crm/courier-settings", {
    method: "PUT",
    headers: { origin: "https://crm.example.test", "content-type": "application/json" },
    body: JSON.stringify({ senditPickupDistrictId: 9999 }),
  }));
  assert.equal(invalidDistrictPut.status, 400);
  const invalidDistrictBody = await invalidDistrictPut.json();
  assert.ok(invalidDistrictBody.error.includes("District de ramassage inconnu"));

  // 8. PUT valid update -> 200
  const validPut = await route.PUT(new Request("https://crm.example.test/api/crm/courier-settings", {
    method: "PUT",
    headers: { origin: "https://crm.example.test", "content-type": "application/json" },
    body: JSON.stringify({ senditAllowOpen: false, senditAllowTry: true }),
  }));
  assert.equal(validPut.status, 200);
  assert.equal(validPut.headers.get("Cache-Control"), "no-store");
  const validPutBody = await validPut.json();
  assert.equal(validPutBody.settings.senditAllowOpen, false);
  assert.equal(validPutBody.settings.senditAllowTry, true);
});
