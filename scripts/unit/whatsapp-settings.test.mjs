import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "../test-source.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-settings-"));
process.env.DELIVERY_PROVIDER = "mock";
process.env.DB_PATH = path.join(dir, "crm.db");
process.env.AUTH_SECRET = "x".repeat(40);
process.env.EVOLUTION_BASE_URL = "http://evolution.internal:8080";
process.env.EVOLUTION_INSTANCE = "test-instance";
process.env.EVOLUTION_API_KEY = "evolution-ephemeral-key";
process.env.WHATSAPP_WEBHOOK_SECRET = "w".repeat(40);
process.env.CRM_PUBLIC_URL = "https://crm.example.test";
process.env.SECURITY_ALLOWED_ORIGINS = "https://crm.example.test";

const originalLoad = Module._load;
Module._load = function (name, ...args) {
  return name === "server-only" ? {} : originalLoad.call(this, name, ...args);
};

const { getDb } = loadSource("@/lib/db");
const service = loadSource("@/lib/services/whatsapp-settings");
const schema = loadSource("@/lib/whatsapp-settings-schema");
const db = getDb();

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("defaults returned without writing; every risky toggle is false", () => {
  const settings = service.getWhatsAppSettings();
  assert.deepEqual(settings, schema.DEFAULT_WHATSAPP_SETTINGS);

  // Risky toggles check
  assert.equal(settings.enabled, false);
  assert.equal(settings.notificationsEnabled, false);
  assert.equal(settings.aiEnabled, false);
  assert.equal(settings.autoBlockEnabled, false);
  assert.equal(settings.catalogSuggestionsEnabled, false);
  assert.equal(settings.crossSellEnabled, false);
  assert.equal(settings.orderEditProposalsEnabled, false);

  // No boot-time writes
  const savedRow = db.prepare("SELECT value FROM app_state WHERE key = ?").get(service.WHATSAPP_SETTINGS_KEY);
  assert.equal(savedRow, undefined);
});

test("updateWhatsAppSettings merges partial updates and persists to DB", () => {
  const updated = service.updateWhatsAppSettings({
    enabled: true,
    dailyOutboundCap: 60,
  });

  assert.equal(updated.enabled, true);
  assert.equal(updated.dailyOutboundCap, 60);
  assert.equal(updated.minGapSeconds, schema.DEFAULT_WHATSAPP_SETTINGS.minGapSeconds);

  const savedRow = db.prepare("SELECT value FROM app_state WHERE key = ?").get(service.WHATSAPP_SETTINGS_KEY);
  assert.ok(savedRow);
  const fromDb = JSON.parse(savedRow.value);
  assert.equal(fromDb.enabled, true);
  assert.equal(fromDb.dailyOutboundCap, 60);

  const readBack = service.getWhatsAppSettings();
  assert.deepEqual(readBack, updated);
});

test("unknown fields are rejected (strict)", () => {
  assert.throws(() => {
    service.updateWhatsAppSettings({ unknownField: "bad" });
  });
});

test("admin phones are normalized and validated", () => {
  const updated = service.updateWhatsAppSettings({
    adminPhones: ["0612345678", "07 11 22 33 44", "+212 655 443 322"],
  });
  assert.deepEqual(updated.adminPhones, [
    "+212612345678",
    "+212711223344",
    "+212655443322",
  ]);

  // Invalid Moroccan phone rejects with "Numéro admin invalide."
  assert.throws(
    () => service.updateWhatsAppSettings({ adminPhones: ["0512345678"] }),
    (err) => err instanceof service.WhatsAppSettingsError && err.message === "Numéro admin invalide.",
  );

  assert.throws(
    () => service.updateWhatsAppSettings({ adminPhones: ["not-a-phone"] }),
    (err) => err instanceof service.WhatsAppSettingsError && err.message === "Numéro admin invalide.",
  );

  assert.throws(
    () => service.updateWhatsAppSettings({ adminPhones: "0612345678" }),
    (err) => err instanceof service.WhatsAppSettingsError && err.message === "Numéro admin invalide.",
  );

  // More than 5 phones rejected
  assert.throws(
    () =>
      service.updateWhatsAppSettings({
        adminPhones: [
          "0611111111",
          "0622222222",
          "0633333333",
          "0644444444",
          "0655555555",
          "0666666666",
        ],
      }),
  );
});

test("min gap > max gap is rejected", () => {
  assert.throws(
    () => service.updateWhatsAppSettings({ minGapSeconds: 500, maxGapSeconds: 100 }),
    (err) => err.message.includes("Écart minimum supérieur au maximum."),
  );

  // Min gap higher than current max gap (120)
  assert.throws(
    () => service.updateWhatsAppSettings({ minGapSeconds: 200 }),
    (err) => err.message.includes("Écart minimum supérieur au maximum."),
  );
});

test("getWhatsAppSettings recovers gracefully from missing, invalid or corrupt state", () => {
  // 1. Corrupt JSON string
  db.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)").run(
    service.WHATSAPP_SETTINGS_KEY,
    "this is not { valid json",
  );
  assert.doesNotThrow(() => {
    const s = service.getWhatsAppSettings();
    assert.deepEqual(s, schema.DEFAULT_WHATSAPP_SETTINGS);
  });

  // 2. Non-object JSON
  db.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)").run(
    service.WHATSAPP_SETTINGS_KEY,
    JSON.stringify("a string"),
  );
  assert.deepEqual(service.getWhatsAppSettings(), schema.DEFAULT_WHATSAPP_SETTINGS);

  // 3. Stored JSON has some valid fields, some invalid fields, and unknown fields
  db.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)").run(
    service.WHATSAPP_SETTINGS_KEY,
    JSON.stringify({
      enabled: true,
      dailyOutboundCap: -10, // invalid (min 1)
      unknownKey: "strip me",
      aiDailyBudgetCents: 500,
    }),
  );
  const recovered = service.getWhatsAppSettings();
  assert.equal(recovered.enabled, true);
  assert.equal(recovered.dailyOutboundCap, schema.DEFAULT_WHATSAPP_SETTINGS.dailyOutboundCap);
  assert.equal(recovered.aiDailyBudgetCents, 500);
  assert.equal(recovered.unknownKey, undefined);

  // 4. Stored JSON has minGap > maxGap
  db.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)").run(
    service.WHATSAPP_SETTINGS_KEY,
    JSON.stringify({
      enabled: true,
      minGapSeconds: 500,
      maxGapSeconds: 50,
    }),
  );
  const gapRecovered = service.getWhatsAppSettings();
  assert.equal(gapRecovered.enabled, true);
  assert.equal(gapRecovered.minGapSeconds, schema.DEFAULT_WHATSAPP_SETTINGS.minGapSeconds);
  assert.equal(gapRecovered.maxGapSeconds, schema.DEFAULT_WHATSAPP_SETTINGS.maxGapSeconds);
});

test("connection state helper returns defaults and persists updates", () => {
  db.prepare("DELETE FROM app_state WHERE key = ?").run(service.WHATSAPP_CONNECTION_KEY);
  assert.deepEqual(service.getWhatsAppConnectionState(), { state: "unknown", updatedAt: null });

  service.setWhatsAppConnectionState({ state: "connecting", updatedAt: "2026-10-29T12:00:00.000Z" });
  assert.deepEqual(service.getWhatsAppConnectionState(), {
    state: "connecting",
    updatedAt: "2026-10-29T12:00:00.000Z",
  });

  service.setWhatsAppConnectionState({ state: "open" });
  const openState = service.getWhatsAppConnectionState();
  assert.equal(openState.state, "open");
  assert.ok(typeof openState.updatedAt === "string");

  // Invalid JSON recovery
  db.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)").run(
    service.WHATSAPP_CONNECTION_KEY,
    "corrupt json",
  );
  assert.deepEqual(service.getWhatsAppConnectionState(), { state: "unknown", updatedAt: null });
});

test("effectiveAssistantName resolves properly", () => {
  assert.equal(service.effectiveAssistantName({ assistantName: "" }, "Boutique"), "Service client Boutique");
  assert.equal(service.effectiveAssistantName({ assistantName: "  " }, "Boutique"), "Service client Boutique");
  assert.equal(service.effectiveAssistantName({ assistantName: null }, "Boutique"), "Service client Boutique");
  assert.equal(service.effectiveAssistantName({}, "Boutique"), "Service client Boutique");
  assert.equal(service.effectiveAssistantName({ assistantName: "Sara" }, "Boutique"), "Sara");
  assert.equal(service.effectiveAssistantName({ assistantName: " Support Client " }, "Boutique"), "Support Client");
});

test("route GET & PUT /api/crm/whatsapp/settings auth, origin, and validation", async () => {
  let mockUser = null;
  const prevLoad = Module._load;
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
    return prevLoad.call(this, request, ...args);
  };

  let route;
  try {
    route = loadSource("@/app/api/crm/whatsapp/settings/route");
  } finally {
    Module._load = prevLoad;
  }

  // 1. GET unauthenticated -> 401
  mockUser = null;
  const unauthGet = await route.GET();
  assert.equal(unauthGet.status, 401);

  // 2. GET as agent -> 403
  mockUser = { id: "agent-1", role: "agent" };
  const agentGet = await route.GET();
  assert.equal(agentGet.status, 403);

  // 3. GET as admin -> 200 with settings, connection, configured
  mockUser = { id: "admin-1", role: "admin" };
  const adminGet = await route.GET();
  assert.equal(adminGet.status, 200);
  assert.equal(adminGet.headers.get("Cache-Control"), "no-store");
  const getBody = await adminGet.json();
  assert.ok(getBody.settings);
  assert.ok(getBody.connection);
  assert.ok("configured" in getBody);
  assert.equal(typeof getBody.configured.evolution, "boolean");
  assert.equal(typeof getBody.configured.ai, "boolean");

  // 4. PUT unauthenticated -> 401
  mockUser = null;
  const unauthPut = await route.PUT(
    new Request("https://crm.example.test/api/crm/whatsapp/settings", {
      method: "PUT",
      headers: { origin: "https://crm.example.test", "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }),
  );
  assert.equal(unauthPut.status, 401);

  // 5. PUT as agent -> 403
  mockUser = { id: "agent-1", role: "agent" };
  const agentPut = await route.PUT(
    new Request("https://crm.example.test/api/crm/whatsapp/settings", {
      method: "PUT",
      headers: { origin: "https://crm.example.test", "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }),
  );
  assert.equal(agentPut.status, 403);

  // 6. PUT disallowed origin -> 403
  mockUser = { id: "admin-1", role: "admin" };
  const badOriginPut = await route.PUT(
    new Request("https://crm.example.test/api/crm/whatsapp/settings", {
      method: "PUT",
      headers: { origin: "https://evil.com", "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }),
  );
  assert.equal(badOriginPut.status, 403);
  const badOriginBody = await badOriginPut.json();
  assert.equal(badOriginBody.error, "Origine non autorisée.");

  // 7. PUT unknown property -> 400 with field
  const invalidPropPut = await route.PUT(
    new Request("https://crm.example.test/api/crm/whatsapp/settings", {
      method: "PUT",
      headers: { origin: "https://crm.example.test", "content-type": "application/json" },
      body: JSON.stringify({ unknownField: "bad" }),
    }),
  );
  assert.equal(invalidPropPut.status, 400);
  const invalidPropBody = await invalidPropPut.json();
  assert.ok(invalidPropBody.error);

  // 8. PUT minGapSeconds > maxGapSeconds -> 400 with field
  const gapErrorPut = await route.PUT(
    new Request("https://crm.example.test/api/crm/whatsapp/settings", {
      method: "PUT",
      headers: { origin: "https://crm.example.test", "content-type": "application/json" },
      body: JSON.stringify({ minGapSeconds: 500, maxGapSeconds: 100 }),
    }),
  );
  assert.equal(gapErrorPut.status, 400);
  const gapErrorBody = await gapErrorPut.json();
  assert.equal(gapErrorBody.error, "Écart minimum supérieur au maximum.");
  assert.equal(gapErrorBody.field, "minGapSeconds");

  // 9. PUT invalid admin phone -> 400 with field
  const phoneErrorPut = await route.PUT(
    new Request("https://crm.example.test/api/crm/whatsapp/settings", {
      method: "PUT",
      headers: { origin: "https://crm.example.test", "content-type": "application/json" },
      body: JSON.stringify({ adminPhones: ["0512345678"] }),
    }),
  );
  assert.equal(phoneErrorPut.status, 400);
  const phoneErrorBody = await phoneErrorPut.json();
  assert.equal(phoneErrorBody.error, "Numéro admin invalide.");
  assert.equal(phoneErrorBody.field, "adminPhones");

  // 10. PUT valid update -> 200 with settings
  const validPut = await route.PUT(
    new Request("https://crm.example.test/api/crm/whatsapp/settings", {
      method: "PUT",
      headers: { origin: "https://crm.example.test", "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        assistantName: "Sara",
        adminPhones: ["06 12 34 56 78"],
      }),
    }),
  );
  assert.equal(validPut.status, 200);
  assert.equal(validPut.headers.get("Cache-Control"), "no-store");
  const validPutBody = await validPut.json();
  assert.equal(validPutBody.settings.enabled, true);
  assert.equal(validPutBody.settings.assistantName, "Sara");
  assert.deepEqual(validPutBody.settings.adminPhones, ["+212612345678"]);
});

test("enabling WhatsApp is refused while the server is not configured", () => {
  service.updateWhatsAppSettings({ enabled: false });
  const saved = process.env.EVOLUTION_BASE_URL;
  delete process.env.EVOLUTION_BASE_URL;
  try {
    assert.throws(
      () => service.updateWhatsAppSettings({ enabled: true }),
      (error) => error.name === "WhatsAppSettingsError" && error.field === "enabled" && /pas configuré/.test(error.message),
    );
    assert.equal(service.getWhatsAppSettings().enabled, false);
    // Other fields stay editable while unconfigured.
    assert.equal(service.updateWhatsAppSettings({ dailyOutboundCap: 55 }).dailyOutboundCap, 55);
  } finally {
    process.env.EVOLUTION_BASE_URL = saved;
  }
  assert.equal(service.updateWhatsAppSettings({ enabled: true }).enabled, true);
  service.updateWhatsAppSettings({ enabled: false });
});

test("send window must start before it ends, also when only one bound is updated", () => {
  service.updateWhatsAppSettings({ sendWindowStart: "08:00", sendWindowEnd: "20:00" });
  const rejects = (patch) =>
    assert.throws(
      () => service.updateWhatsAppSettings(patch),
      (error) => error.name === "ZodError" && /précéder/.test(error.issues[0].message),
    );
  rejects({ sendWindowStart: "22:00", sendWindowEnd: "08:00" });
  rejects({ sendWindowStart: "10:00", sendWindowEnd: "10:00" });
  rejects({ sendWindowEnd: "07:00" });
  rejects({ sendWindowStart: "20:30" });
  assert.equal(service.getWhatsAppSettings().sendWindowStart, "08:00");
  assert.equal(service.getWhatsAppSettings().sendWindowEnd, "20:00");
  service.updateWhatsAppSettings({ sendWindowStart: "09:00", sendWindowEnd: "21:00" });
});

test("a corrupt persisted window recovers to the default window", () => {
  db.prepare("UPDATE app_state SET value = ? WHERE key = ?").run(
    JSON.stringify({ ...service.getWhatsAppSettings(), sendWindowStart: "22:00", sendWindowEnd: "06:00", dailyOutboundCap: 12 }),
    service.WHATSAPP_SETTINGS_KEY,
  );
  const recovered = service.getWhatsAppSettings();
  assert.equal(recovered.sendWindowStart, "09:00");
  assert.equal(recovered.sendWindowEnd, "21:00");
  assert.equal(recovered.dailyOutboundCap, 12);
});
