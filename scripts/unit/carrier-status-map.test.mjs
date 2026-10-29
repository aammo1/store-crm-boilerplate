import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "../test-source.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "carrier-status-map-"));
process.env.DELIVERY_PROVIDER = "mock";
process.env.DB_PATH = path.join(dir, "crm.db");
process.env.AUTH_SECRET = "x".repeat(40);
process.env.CRM_PUBLIC_URL = "https://crm.example.test";
process.env.SECURITY_ALLOWED_ORIGINS = "https://crm.example.test";
globalThis.fetch = async () => {
  throw new Error("HTTP disabled in isolated carrier-status tests");
};

const originalLoad = Module._load;
Module._load = function (name, ...args) {
  return name === "server-only" ? {} : originalLoad.call(this, name, ...args);
};

const { getDb } = loadSource("@/lib/db");
const service = loadSource("@/lib/services/carrier-status-map");
const { pollOnce } = loadSource("@/lib/services/tracking");
const { createMockProvider } = loadSource("@/lib/shipping/mock");
const settingsService = loadSource("@/lib/services/whatsapp-settings");
const { createOrder } = await import("../fulfillment-fixtures.mjs");
const { openStock, reserveForOrder, dispatchOrder } = loadSource("@/lib/services/inventory");
const db = getDb();
const now = new Date().toISOString();

// Independent Casablanca date (not the code under test) for dedupe-key checks.
const todayCasablanca = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Casablanca",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Catalog + stock fixture (same shape as scripts/tracking-workflow.test.mjs).

db.prepare(`INSERT INTO users (id, email, password_hash, name, role, created_at)
  VALUES ('admin-1', 'admin1@test.local', 'x', 'Admin Un', 'admin', ?)`).run(now);
db.prepare(`INSERT INTO users (id, email, password_hash, name, role, created_at)
  VALUES ('admin-2', 'admin2@test.local', 'x', 'Admin Deux', 'admin', ?)`).run(now);

db.prepare(`INSERT INTO products (id, slug, name, category, price, created_at, updated_at)
  VALUES ('p', 'p', 'Sérum test', 'soins', 300, ?, ?)`).run(now, now);
db.prepare(`INSERT INTO variants (id, product_id, sku, label, options_json, options_key)
  VALUES ('v', 'p', 'v', '500 ml', '[{"name":"Contenance","value":"500 ml"}]', '[["contenance","500 ml"]]')`).run();
openStock("v", 50, "test");

let seq = 0;
function submitted({ cancelled = false } = {}) {
  seq += 1;
  const orderId = `ORD${String(seq).padStart(6, "0")}`;
  const code = `OZEMOCK${String(seq).padStart(6, "0")}`;
  createOrder({
    id: orderId,
    customerName: "Cliente Test",
    customerPhone: "+212600000001",
    items: [{ product_id: "p", variant_id: "v", sku: "v", name: "Sérum test", variant_label: "500 ml", options: [{ name: "Contenance", value: "500 ml" }], quantity: 1, unit_price: 300, line_total: 300 }],
    subtotal: 300,
    shipping: 29,
    total: 329,
  });
  if (cancelled) {
    db.prepare("UPDATE orders SET confirmation_status = 'cancelled' WHERE id = ?").run(orderId);
  }
  reserveForOrder(orderId, [{ variantId: "v", qty: 1 }], "test", "test");
  dispatchOrder(orderId, "test");
  db.prepare(`INSERT INTO courier_submissions (id, order_id, provider, status, tracking_number, next_retry_at, created_at, updated_at)
    VALUES (?, ?, 'mock', 'submitted', ?, ?, ?, ?)`).run(`sub${seq}`, orderId, code, now, now, now);
  return { orderId, subId: `sub${seq}`, code, ref: orderId.slice(0, 8).toUpperCase() };
}

const outboxRows = (orderId) =>
  db.prepare("SELECT * FROM wa_outbox WHERE order_id = ? ORDER BY created_at").all(orderId);
const mapping = (provider, rawStatus) =>
  db
    .prepare("SELECT * FROM carrier_status_mappings WHERE provider = ? AND raw_status = ?")
    .get(provider, rawStatus);
const submissionState = (subId) =>
  db.prepare("SELECT normalized_status s, raw_status r FROM courier_submissions WHERE id = ?").get(subId);

// --- Service-level behavior.

test("recordRawStatus trims, collapses spaces, ignores empty and upserts samples", () => {
  const first = new Date("2026-06-15T10:00:00.000Z");
  assert.equal(service.recordRawStatus("mock", "  Out  For   Delivery  ", first), true);
  assert.deepEqual(mapping("mock", "Out For Delivery"), {
    provider: "mock",
    raw_status: "Out For Delivery",
    notify_category: null,
    sample_count: 1,
    first_seen_at: first.toISOString(),
    last_seen_at: first.toISOString(),
    mapped_by: null,
    mapped_at: null,
  });

  // Same normalized string (spacing/case-insensitive input is NOT merged —
  // raw values are stored verbatim, only spacing is collapsed).
  service.setNotifyCategory("mock", "Out For Delivery", "out_for_delivery", "admin-1");
  const second = new Date("2026-06-15T12:00:00.000Z");
  assert.equal(service.recordRawStatus("mock", " Out  For Delivery ", second), true);
  assert.deepEqual(mapping("mock", "Out For Delivery"), {
    provider: "mock",
    raw_status: "Out For Delivery",
    notify_category: "out_for_delivery",
    sample_count: 2,
    first_seen_at: first.toISOString(),
    last_seen_at: second.toISOString(),
    mapped_by: "admin-1",
    mapped_at: mapping("mock", "Out For Delivery").mapped_at,
  });

  // A case variant is a distinct raw status (never guessed/merged).
  assert.equal(service.recordRawStatus("mock", "out for delivery", second), true);
  assert.ok(mapping("mock", "out for delivery"), "case variant stored as its own raw status");
  assert.equal(mapping("mock", "out for delivery").sample_count, 1);

  // Empty raw statuses are ignored.
  assert.equal(service.recordRawStatus("mock", "   ", second), false);
  assert.equal(service.recordRawStatus("mock", "", second), false);

  // Missing provider falls back to the configured provider (mock here).
  assert.equal(service.recordRawStatus("", "Whatever Status"), true);
  assert.ok(mapping("mock", "Whatever Status"));
});

test("recordRawStatus caps raw statuses at 200 characters", () => {
  const long = `X-${"y".repeat(300)}`;
  assert.equal(service.recordRawStatus("mock", long), true);
  assert.ok(mapping("mock", `X-${"y".repeat(198)}`), "status truncated to 200 chars");
});

test("setNotifyCategory validates, audits, unmaps and pre-maps unknown statuses", () => {
  assert.throws(() => service.setNotifyCategory("mock", "SOME_STATUS", "delivered", "admin-1"));
  assert.throws(() => service.setNotifyCategory("mock", "SOME_STATUS", "nope", "admin-1"));

  // Pre-mapping a status the poller has not observed yet.
  service.setNotifyCategory("mock", "NOT_YET_OBSERVED", "delivery_issue", "admin-2");
  assert.equal(service.notifyCategoryFor("mock", "NOT_YET_OBSERVED"), "delivery_issue");
  const preMapped = mapping("mock", "NOT_YET_OBSERVED");
  assert.equal(preMapped.sample_count, 0);
  assert.equal(preMapped.mapped_by, "admin-2");
  assert.ok(preMapped.mapped_at);

  // Unmapping clears the audit fields but keeps the row.
  service.setNotifyCategory("mock", "NOT_YET_OBSERVED", null, "admin-2");
  const unmapped = mapping("mock", "NOT_YET_OBSERVED");
  assert.equal(unmapped.notify_category, null);
  assert.equal(unmapped.mapped_by, null);
  assert.equal(unmapped.mapped_at, null);
  assert.equal(service.notifyCategoryFor("mock", "NOT_YET_OBSERVED"), null);

  // Unmapped or unknown lookups return null.
  assert.equal(service.notifyCategoryFor("mock", "NEVER_SEEN"), null);
  assert.equal(service.notifyCategoryFor("mock", "   "), null);
  assert.equal(service.notifyCategoryFor("sendit", "Out For Delivery"), null);
});

test("listRawStatuses: unmapped first, then by last sighting, optional provider filter", () => {
  service.recordRawStatus("mock", "ZZ_MAPPED", new Date("2026-06-15T09:00:00.000Z"));
  service.recordRawStatus("mock", "AA_RECENT", new Date("2026-06-15T13:00:00.000Z"));
  service.recordRawStatus("mock", "MM_OLDER", new Date("2026-06-15T08:00:00.000Z"));
  service.recordRawStatus("sendit", "SND_ONLY", new Date("2026-06-15T07:00:00.000Z"));
  service.setNotifyCategory("mock", "ZZ_MAPPED", "ignore", "admin-1");

  const all = service.listRawStatuses();
  const isUnmapped = all.map((row) => (row.category === null ? 0 : 1));
  assert.deepEqual(
    [...isUnmapped].sort((a, b) => a - b),
    isUnmapped,
    "unmapped rows come first",
  );
  const mockUnmapped = all.filter((row) => row.provider === "mock" && row.category === null);
  // Ordering by last_seen desc (property check, robust to same-instant rows).
  const seen = mockUnmapped.map((row) => row.lastSeenAt);
  assert.deepEqual(
    [...seen].sort().reverse(),
    seen,
    "unmapped rows sorted by last_seen desc",
  );
  const names = mockUnmapped.map((row) => row.rawStatus);
  assert.ok(names.includes("AA_RECENT") && names.includes("MM_OLDER"));
  assert.ok(
    names.indexOf("AA_RECENT") < names.indexOf("MM_OLDER"),
    "more recently seen statuses come first",
  );
  assert.ok(all.every((row) => "mappedByName" in row && "sampleCount" in row));

  const senditOnly = service.listRawStatuses("sendit");
  assert.deepEqual(
    senditOnly.map((row) => row.rawStatus),
    ["SND_ONLY"],
  );
  assert.equal(senditOnly[0].mappedByName, null);
  assert.equal(senditOnly[0].mappedBy, null);
  assert.equal(senditOnly[0].sampleCount, 1);
});

// --- Poller integration (mock provider).

function stockSnapshot() {
  return {
    balances: db.prepare("SELECT * FROM stock_balances ORDER BY variant_id").all(),
    movements: db.prepare("SELECT * FROM stock_movements ORDER BY id").all(),
    reservations: db.prepare("SELECT * FROM reservations ORDER BY id").all(),
  };
}

test("poller records raw statuses; mapped out_for_delivery notifies once per day; mappings never touch stock or outcomes", async () => {
  settingsService.updateWhatsAppSettings({ enabled: true, notificationsEnabled: true });
  const { orderId, subId, code, ref } = submitted();
  const before = stockSnapshot();

  const mock = createMockProvider();
  mock.setTrackingStatus(code, "OFD_TEST_STATUS");

  // Unmapped: recorded, nothing enqueued.
  await pollOnce(mock);
  const recorded = mapping("mock", "OFD_TEST_STATUS");
  assert.ok(recorded, "poller recorded the raw status");
  assert.equal(recorded.sample_count, 1);
  assert.equal(outboxRows(orderId).length, 0);

  // Invariants: unmapped observation changes nothing else.
  assert.deepEqual(submissionState(subId), { s: "unknown", r: "OFD_TEST_STATUS" });
  assert.deepEqual(stockSnapshot(), before);

  // Map → poll → exactly one notification for today.
  service.setNotifyCategory("mock", "OFD_TEST_STATUS", "out_for_delivery", "admin-1");
  await pollOnce(mock);
  const queued = outboxRows(orderId);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].purpose, "notify_out_for_delivery");
  assert.ok(queued[0].body.includes(`#${ref}`));
  assert.ok(queued[0].body.includes("329 DH"));
  assert.equal(queued[0].dedupe_key, `order:${orderId}:ofd:${todayCasablanca}`);

  // Re-poll the same day: still exactly one.
  await pollOnce(mock);
  assert.equal(outboxRows(orderId).length, 1);

  // The next Casablanca day allows a new message for the same order.
  assert.equal(
    service.maybeNotifyFromRawStatus(orderId, subId, "OFD_TEST_STATUS", "mock", new Date("2026-06-16T08:00:00.000Z")),
    true,
  );
  const twoDays = outboxRows(orderId);
  assert.equal(twoDays.length, 2);
  assert.equal(twoDays[1].dedupe_key, "order:" + orderId + ":ofd:2026-06-16");

  // Mappings never change stock, normalized status, outcome or returns.
  assert.deepEqual(submissionState(subId), { s: "unknown", r: "OFD_TEST_STATUS" });
  assert.equal(
    db.prepare("SELECT delivery_outcome FROM orders WHERE id = ?").get(orderId).delivery_outcome,
    null,
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM returns WHERE submission_id = ?").get(subId).n, 0);
  assert.deepEqual(stockSnapshot(), before);
});

test("mapped delivery_issue notifies once per day; unmapped statuses enqueue nothing", async () => {
  settingsService.updateWhatsAppSettings({ enabled: true, notificationsEnabled: true });
  const { orderId, subId, code } = submitted();
  const mock = createMockProvider();

  mock.setTrackingStatus(code, "ISSUE_TEST_STATUS");
  await pollOnce(mock); // unmapped yet
  assert.equal(outboxRows(orderId).length, 0);

  service.setNotifyCategory("mock", "ISSUE_TEST_STATUS", "delivery_issue", "admin-1");
  await pollOnce(mock);
  const rows = outboxRows(orderId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].purpose, "notify_delivery_issue");
  assert.ok(rows[0].body.includes("#"));
  assert.equal(rows[0].dedupe_key, `order:${orderId}:issue:${todayCasablanca}`);

  await pollOnce(mock);
  assert.equal(outboxRows(orderId).length, 1, "one message per order per day");

  assert.deepEqual(submissionState(subId), { s: "unknown", r: "ISSUE_TEST_STATUS" });
  assert.equal(
    db.prepare("SELECT delivery_outcome FROM orders WHERE id = ?").get(orderId).delivery_outcome,
    null,
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM returns WHERE submission_id = ?").get(subId).n, 0);
});

test("guard skips: toggle off, cancelled order, resolved outcome, kill switch", async () => {
  settingsService.updateWhatsAppSettings({ enabled: true, notificationsEnabled: true });
  service.setNotifyCategory("mock", "OFD_TEST_STATUS", "out_for_delivery", "admin-1");

  // Per-purpose toggle off.
  const toggled = submitted();
  const toggleMock = createMockProvider();
  toggleMock.setTrackingStatus(toggled.code, "OFD_TEST_STATUS");
  settingsService.updateWhatsAppSettings({ notifyOutForDelivery: false });
  await pollOnce(toggleMock);
  assert.equal(outboxRows(toggled.orderId).length, 0, "toggle off skips the notification");
  settingsService.updateWhatsAppSettings({ notifyOutForDelivery: true });

  // Cancelled order.
  const cancelled = submitted({ cancelled: true });
  const cancelledMock = createMockProvider();
  cancelledMock.setTrackingStatus(cancelled.code, "OFD_TEST_STATUS");
  await pollOnce(cancelledMock);
  assert.equal(outboxRows(cancelled.orderId).length, 0, "cancelled orders are skipped");

  // Already resolved outcome.
  const resolved = submitted();
  db.prepare("UPDATE orders SET delivery_outcome = 'delivered' WHERE id = ?").run(resolved.orderId);
  const resolvedMock = createMockProvider();
  resolvedMock.setTrackingStatus(resolved.code, "OFD_TEST_STATUS");
  await pollOnce(resolvedMock);
  assert.equal(outboxRows(resolved.orderId).length, 0, "resolved orders are skipped");

  // Master switch off.
  settingsService.updateWhatsAppSettings({ enabled: false });
  const disabled = submitted();
  const disabledMock = createMockProvider();
  disabledMock.setTrackingStatus(disabled.code, "OFD_TEST_STATUS");
  await pollOnce(disabledMock);
  assert.equal(outboxRows(disabled.orderId).length, 0, "kill switch stops notifications");
  settingsService.updateWhatsAppSettings({ enabled: true });
});

test("customer conversation language drives the message locale", async () => {
  settingsService.updateWhatsAppSettings({ enabled: true, notificationsEnabled: true });
  const { orderId, subId } = submitted();
  db.prepare(`INSERT INTO wa_conversations (id, phone, language, created_at, updated_at)
    VALUES ('conv-ar', '+212600000001', 'ar', ?, ?)`).run(now, now);
  try {
    assert.equal(
      service.maybeNotifyFromRawStatus(orderId, subId, "ISSUE_TEST_STATUS", "mock"),
      true,
    );
    const rows = outboxRows(orderId);
    assert.equal(rows.length, 1);
    assert.match(rows[0].body, /[\u0600-\u06FF]/, "Arabic script message for ar language");
  } finally {
    // Outbox rows reference the conversation (FK) — clear them first.
    db.prepare("DELETE FROM wa_outbox WHERE conversation_id = 'conv-ar'").run();
    db.prepare("DELETE FROM wa_conversations WHERE id = 'conv-ar'").run();
  }
});

// --- API route: admin only.

test("route GET & PUT /api/crm/carrier-statuses auth, origin and validation", async () => {
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
    route = loadSource("@/app/api/crm/carrier-statuses/route");
  } finally {
    Module._load = prevLoad;
  }

  const url = "https://crm.example.test/api/crm/carrier-statuses";

  // 1. GET unauthenticated -> 401
  assert.equal((await route.GET(new Request(url))).status, 401);

  // 2. GET as agent -> 403
  mockUser = { id: "agent-1", role: "agent", name: "Agent" };
  assert.equal((await route.GET(new Request(url))).status, 403);

  // 3. GET as admin -> 200 with statuses
  mockUser = { id: "admin-1", role: "admin", name: "Admin" };
  const adminGet = await route.GET(new Request(url));
  assert.equal(adminGet.status, 200);
  assert.equal(adminGet.headers.get("Cache-Control"), "no-store");
  const getBody = await adminGet.json();
  assert.ok(Array.isArray(getBody.statuses));
  assert.ok(getBody.statuses.length > 0);
  assert.ok("rawStatus" in getBody.statuses[0] && "category" in getBody.statuses[0]);

  // Provider filter works.
  const filtered = await route.GET(new Request(`${url}?provider=sendit`));
  const filteredBody = await filtered.json();
  assert.ok(filteredBody.statuses.every((row) => row.provider === "sendit"));

  // 4. PUT unauthenticated -> 401
  mockUser = null;
  const unauthPut = await route.PUT(
    new Request(url, {
      method: "PUT",
      headers: { origin: "https://crm.example.test", "content-type": "application/json" },
      body: JSON.stringify({ provider: "mock", rawStatus: "OFD_TEST_STATUS", category: "ignore" }),
    }),
  );
  assert.equal(unauthPut.status, 401);

  // 5. PUT as agent -> 403
  mockUser = { id: "agent-1", role: "agent", name: "Agent" };
  const agentPut = await route.PUT(
    new Request(url, {
      method: "PUT",
      headers: { origin: "https://crm.example.test", "content-type": "application/json" },
      body: JSON.stringify({ provider: "mock", rawStatus: "OFD_TEST_STATUS", category: "ignore" }),
    }),
  );
  assert.equal(agentPut.status, 403);

  // 6. PUT from a disallowed origin -> 403
  mockUser = { id: "admin-1", role: "admin", name: "Admin" };
  const badOriginPut = await route.PUT(
    new Request(url, {
      method: "PUT",
      headers: { origin: "https://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ provider: "mock", rawStatus: "OFD_TEST_STATUS", category: "ignore" }),
    }),
  );
  assert.equal(badOriginPut.status, 403);

  // 7. PUT invalid category -> 400
  const invalidPut = await route.PUT(
    new Request(url, {
      method: "PUT",
      headers: { origin: "https://crm.example.test", "content-type": "application/json" },
      body: JSON.stringify({ provider: "mock", rawStatus: "OFD_TEST_STATUS", category: "delivered" }),
    }),
  );
  assert.equal(invalidPut.status, 400);

  // 8. PUT unknown field -> 400
  const unknownFieldPut = await route.PUT(
    new Request(url, {
      method: "PUT",
      headers: { origin: "https://crm.example.test", "content-type": "application/json" },
      body: JSON.stringify({ provider: "mock", rawStatus: "OFD_TEST_STATUS", category: "ignore", extra: 1 }),
    }),
  );
  assert.equal(unknownFieldPut.status, 400);

  // 9. PUT as admin -> 200 and persisted
  const validPut = await route.PUT(
    new Request(url, {
      method: "PUT",
      headers: { origin: "https://crm.example.test", "content-type": "application/json" },
      body: JSON.stringify({ provider: "mock", rawStatus: "VIA_API_STATUS", category: "ignore" }),
    }),
  );
  assert.equal(validPut.status, 200);
  assert.equal(mapping("mock", "VIA_API_STATUS").notify_category, "ignore");
  assert.equal(mapping("mock", "VIA_API_STATUS").mapped_by, "admin-1");

  // 10. PUT null category unmaps
  const unmapPut = await route.PUT(
    new Request(url, {
      method: "PUT",
      headers: { origin: "https://crm.example.test", "content-type": "application/json" },
      body: JSON.stringify({ provider: "mock", rawStatus: "VIA_API_STATUS", category: null }),
    }),
  );
  assert.equal(unmapPut.status, 200);
  assert.equal(mapping("mock", "VIA_API_STATUS").notify_category, null);
  assert.equal(mapping("mock", "VIA_API_STATUS").mapped_by, null);
});
