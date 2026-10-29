import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "../test-source.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-webhook-"));
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
const service = loadSource("@/lib/services/whatsapp-inbound-events");
const { budgetKey } = loadSource("@/lib/services/security-budgets");
const route = loadSource("@/app/api/whatsapp/webhook/[secret]/route");
const db = getDb();

// Ephemeral secret for this test run only; never a real credential.
const SECRET = "whatsapp-webhook-test-secret-0123456789abcdef";
const WEBHOOK_URL = "https://crm.example.test/api/whatsapp/webhook";
const BUDGET_KEY = budgetKey("wa_webhook", "global");

function configureEnv() {
  process.env.EVOLUTION_BASE_URL = "https://evolution.example.test";
  process.env.EVOLUTION_INSTANCE = "test-instance";
  process.env.EVOLUTION_API_KEY = "test-evo-api-key";
  process.env.WHATSAPP_WEBHOOK_SECRET = SECRET;
}

function unconfigureEnv() {
  delete process.env.EVOLUTION_BASE_URL;
  delete process.env.EVOLUTION_INSTANCE;
  delete process.env.EVOLUTION_API_KEY;
  delete process.env.WHATSAPP_WEBHOOK_SECRET;
}

configureEnv();

function clearBudget() {
  db.prepare("DELETE FROM security_budgets WHERE key = ?").run(BUDGET_KEY);
}

function resetEvents() {
  db.prepare("DELETE FROM wa_inbound_events").run();
}

function post(body, { pathSecret = SECRET, headerSecret = SECRET } = {}) {
  const headers = {};
  if (headerSecret !== null) headers["x-webhook-secret"] = headerSecret;
  return route.POST(
    new Request(`${WEBHOOK_URL}/${pathSecret}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ secret: pathSecret }) },
  );
}

function eventRow(waMessageId) {
  return db.prepare("SELECT * FROM wa_inbound_events WHERE wa_message_id = ?").get(waMessageId);
}

function countEvents(eventType = null) {
  return eventType
    ? db.prepare("SELECT COUNT(*) AS c FROM wa_inbound_events WHERE event_type = ?").get(eventType).c
    : db.prepare("SELECT COUNT(*) AS c FROM wa_inbound_events").get().c;
}

function customerMessage(id) {
  return {
    key: { remoteJid: "212600000000@s.whatsapp.net", fromMe: false, id },
    pushName: "Client",
    message: { conversation: "salam, lwnsit?" },
  };
}

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Service: whatsapp-inbound-events
// ---------------------------------------------------------------------------

test("storeInboundEvent stores a pending event once and dedupes by message id", () => {
  resetEvents();
  const now = new Date("2026-10-29T10:00:00.000Z");
  const first = service.storeInboundEvent({
    eventType: "messages.upsert",
    waMessageId: "msg-1",
    payload: { key: { id: "msg-1" }, message: { conversation: "bonjour" } },
    now,
  });
  assert.deepEqual(first, { stored: true, duplicate: false });

  const row = db.prepare("SELECT * FROM wa_inbound_events WHERE wa_message_id = 'msg-1'").get();
  assert.equal(row.event_type, "messages.upsert");
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 0);
  assert.equal(row.available_at, "2026-10-29T10:00:00.000Z");
  assert.equal(row.received_at, "2026-10-29T10:00:00.000Z");
  assert.equal(row.lease, null);
  assert.deepEqual(JSON.parse(row.payload_json), {
    key: { id: "msg-1" },
    message: { conversation: "bonjour" },
  });

  const again = service.storeInboundEvent({
    eventType: "messages.upsert",
    waMessageId: "msg-1",
    payload: { key: { id: "msg-1" } },
    now,
  });
  assert.deepEqual(again, { stored: false, duplicate: true });
  assert.equal(countEvents(), 1);
});

test("storeInboundEvent rejects payloads over 256 KB after stringify", () => {
  resetEvents();
  const res = service.storeInboundEvent({
    eventType: "messages.upsert",
    waMessageId: "msg-big",
    payload: { pad: "x".repeat(300 * 1024) },
  });
  assert.deepEqual(res, { stored: false, duplicate: false });
  assert.equal(countEvents(), 0);
});

test("storeInboundEvent rejects a payload that cannot be stringified", () => {
  resetEvents();
  const res = service.storeInboundEvent({
    eventType: "connection.update",
    waMessageId: null,
    payload: undefined,
  });
  assert.deepEqual(res, { stored: false, duplicate: false });
  assert.equal(countEvents(), 0);
});

test("storeInboundEvent allows several null-message-id events (connection.update)", () => {
  resetEvents();
  const a = service.storeInboundEvent({
    eventType: "connection.update",
    waMessageId: null,
    payload: { event: "connection.update", state: "open" },
  });
  const b = service.storeInboundEvent({
    eventType: "connection.update",
    waMessageId: null,
    payload: { event: "connection.update", state: "close" },
  });
  assert.equal(a.stored, true);
  assert.equal(b.stored, true);
  assert.equal(countEvents("connection.update"), 2);
});

test("claimNextInboundEvent claims the oldest pending event atomically", () => {
  resetEvents();
  const t1 = new Date("2026-10-29T10:00:00.000Z");
  const t2 = new Date("2026-10-29T10:01:00.000Z");
  service.storeInboundEvent({ eventType: "messages.upsert", waMessageId: "old", payload: { n: 1 }, now: t1 });
  service.storeInboundEvent({ eventType: "connection.update", waMessageId: null, payload: { n: 2 }, now: t2 });

  const claimed = service.claimNextInboundEvent(t2);
  assert.ok(claimed);
  assert.equal(claimed.eventType, "messages.upsert");
  assert.deepEqual(claimed.payload, { n: 1 });
  assert.equal(claimed.attempts, 1);
  assert.ok(claimed.lease);

  const row = db.prepare("SELECT * FROM wa_inbound_events WHERE id = ?").get(claimed.id);
  assert.equal(row.status, "processing");
  assert.equal(row.lease, claimed.lease);
  assert.equal(row.attempts, 1);
  assert.equal(row.available_at, "2026-10-29T10:06:00.000Z"); // lease window: +5 min

  const second = service.claimNextInboundEvent(t2);
  assert.ok(second);
  assert.equal(second.eventType, "connection.update");
  assert.notEqual(second.lease, claimed.lease);

  assert.equal(service.claimNextInboundEvent(t2), null);
});

test("markInboundDone finalizes only with the matching lease", () => {
  resetEvents();
  const now = new Date("2026-10-29T10:00:00.000Z");
  service.storeInboundEvent({ eventType: "connection.update", waMessageId: null, payload: {}, now });
  const claimed = service.claimNextInboundEvent(now);

  service.markInboundDone(claimed.id, "wrong-lease");
  let row = db.prepare("SELECT * FROM wa_inbound_events WHERE id = ?").get(claimed.id);
  assert.equal(row.status, "processing"); // wrong lease is a no-op

  service.markInboundDone(claimed.id, claimed.lease, new Date("2026-10-29T10:00:05.000Z"));
  row = db.prepare("SELECT * FROM wa_inbound_events WHERE id = ?").get(claimed.id);
  assert.equal(row.status, "done");
  assert.equal(row.lease, null);
  assert.equal(row.processed_at, "2026-10-29T10:00:05.000Z");

  assert.equal(service.claimNextInboundEvent(now), null); // done rows are never reclaimed
});

test("markInboundIgnored stores a redacted reason truncated to 300 chars", () => {
  resetEvents();
  const now = new Date("2026-10-29T10:00:00.000Z");
  service.storeInboundEvent({ eventType: "connection.update", waMessageId: null, payload: {}, now });
  const claimed = service.claimNextInboundEvent(now);

  const reason = `https://api.ozon.test/customers/12345/SECRETKEY/orders failed: ${"z".repeat(400)}`;
  service.markInboundIgnored(claimed.id, claimed.lease, reason);
  const row = db.prepare("SELECT * FROM wa_inbound_events WHERE id = ?").get(claimed.id);
  assert.equal(row.status, "ignored");
  assert.ok(row.last_error.includes("/customers/***/***"));
  assert.ok(!row.last_error.includes("SECRETKEY"));
  assert.equal(row.last_error.length, 300);
  assert.equal(row.lease, null);
  assert.ok(row.processed_at);
});

test("markInboundRetry backs off exponentially, caps at 10 min, fails after 8 attempts", () => {
  resetEvents();
  const now = new Date("2026-10-29T10:00:00.000Z");
  service.storeInboundEvent({ eventType: "messages.upsert", waMessageId: "retry-1", payload: {}, now });
  const claimed = service.claimNextInboundEvent(now); // attempts = 1

  service.markInboundRetry(claimed.id, claimed.lease, "boom https://api.ozon.test/customers/1/KEY/x", now);
  let row = db.prepare("SELECT * FROM wa_inbound_events WHERE id = ?").get(claimed.id);
  assert.equal(row.status, "pending");
  assert.equal(row.lease, null);
  assert.equal(row.available_at, "2026-10-29T10:00:10.000Z"); // min(10 min, 5s * 2^1)
  assert.ok(row.last_error.includes("/customers/***/***"));
  assert.ok(!row.last_error.includes("KEY/x") || row.last_error.includes("***"));

  // Not claimable before the backoff elapses, claimable once due.
  assert.equal(service.claimNextInboundEvent(new Date("2026-10-29T10:00:05.000Z")), null);
  const second = service.claimNextInboundEvent(new Date("2026-10-29T10:00:12.000Z"));
  assert.ok(second);
  assert.equal(second.id, claimed.id);
  assert.equal(second.attempts, 2);

  // attempts = 2 -> 5s * 2^2 = 20s
  service.markInboundRetry(second.id, second.lease, "boom", new Date("2026-10-29T10:00:12.000Z"));
  row = db.prepare("SELECT * FROM wa_inbound_events WHERE id = ?").get(claimed.id);
  assert.equal(row.available_at, "2026-10-29T10:00:32.000Z");

  // Cap: attempts = 7 -> 5s * 2^7 = 640s > 600s, so 10 min.
  db.prepare(
    "UPDATE wa_inbound_events SET status = 'processing', lease = 'lease-7', attempts = 7 WHERE id = ?",
  ).run(claimed.id);
  service.markInboundRetry(claimed.id, "lease-7", "boom", now);
  row = db.prepare("SELECT * FROM wa_inbound_events WHERE id = ?").get(claimed.id);
  assert.equal(row.available_at, "2026-10-29T10:10:00.000Z");

  // attempts = 8 -> failed for good.
  db.prepare(
    "UPDATE wa_inbound_events SET status = 'processing', lease = 'lease-8', attempts = 8 WHERE id = ?",
  ).run(claimed.id);
  service.markInboundRetry(claimed.id, "lease-8", "boom", now);
  row = db.prepare("SELECT * FROM wa_inbound_events WHERE id = ?").get(claimed.id);
  assert.equal(row.status, "failed");
  assert.equal(row.lease, null);
  assert.ok(row.processed_at);
});

test("markInboundRetry with a stale lease is a no-op", () => {
  resetEvents();
  const now = new Date("2026-10-29T10:00:00.000Z");
  service.storeInboundEvent({ eventType: "connection.update", waMessageId: null, payload: {}, now });
  const claimed = service.claimNextInboundEvent(now);

  service.markInboundRetry(claimed.id, "stale-lease", "boom", now);
  const row = db.prepare("SELECT * FROM wa_inbound_events WHERE id = ?").get(claimed.id);
  assert.equal(row.status, "processing");
  assert.equal(row.lease, claimed.lease);
  assert.equal(row.last_error, null);
});

test("markInboundFailed marks the event failed with the redacted error", () => {
  resetEvents();
  const now = new Date("2026-10-29T10:00:00.000Z");
  service.storeInboundEvent({ eventType: "connection.update", waMessageId: null, payload: {}, now });
  const claimed = service.claimNextInboundEvent(now);

  service.markInboundFailed(claimed.id, claimed.lease, "unreadable payload");
  const row = db.prepare("SELECT * FROM wa_inbound_events WHERE id = ?").get(claimed.id);
  assert.equal(row.status, "failed");
  assert.equal(row.last_error, "unreadable payload");
  assert.equal(row.lease, null);
  assert.ok(row.processed_at);

  assert.equal(service.claimNextInboundEvent(now), null);
});

test("recoverStaleInbound requeues processing rows whose lease expired over 5 min ago", () => {
  resetEvents();
  const t0 = new Date("2026-10-29T10:00:00.000Z");
  service.storeInboundEvent({ eventType: "messages.upsert", waMessageId: "stale-1", payload: {}, now: t0 });
  const claimed = service.claimNextInboundEvent(t0); // lease valid until 10:05

  assert.equal(service.recoverStaleInbound(new Date("2026-10-29T10:04:59.000Z")), 0);
  let row = db.prepare("SELECT * FROM wa_inbound_events WHERE id = ?").get(claimed.id);
  assert.equal(row.status, "processing");

  assert.equal(service.recoverStaleInbound(new Date("2026-10-29T10:05:00.000Z")), 1);
  row = db.prepare("SELECT * FROM wa_inbound_events WHERE id = ?").get(claimed.id);
  assert.equal(row.status, "pending");
  assert.equal(row.lease, null);
  assert.equal(row.attempts, 1); // attempts are preserved
  assert.equal(row.available_at, "2026-10-29T10:05:00.000Z");

  const reclaimed = service.claimNextInboundEvent(new Date("2026-10-29T10:05:01.000Z"));
  assert.ok(reclaimed);
  assert.equal(reclaimed.id, claimed.id);
  assert.equal(reclaimed.attempts, 2);
});

test("purgeInboundEvents removes old terminal events, keeps recent and pending ones", () => {
  resetEvents();
  const now = new Date("2026-10-29T12:00:00.000Z");
  const daysAgo = (n) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
  const finish = (claimed, at) => new Date(at.getTime() + 1000);

  // Rows are fully finalized one at a time so each claim takes the only pending row.
  service.storeInboundEvent({ eventType: "connection.update", waMessageId: "done-old", payload: {}, now: daysAgo(20) });
  let claimed = service.claimNextInboundEvent(daysAgo(20));
  service.markInboundDone(claimed.id, claimed.lease, finish(claimed, daysAgo(20)));

  service.storeInboundEvent({ eventType: "connection.update", waMessageId: "done-recent", payload: {}, now: daysAgo(10) });
  claimed = service.claimNextInboundEvent(daysAgo(10));
  service.markInboundDone(claimed.id, claimed.lease, finish(claimed, daysAgo(10)));

  service.storeInboundEvent({ eventType: "connection.update", waMessageId: null, payload: {}, now: daysAgo(20) });
  claimed = service.claimNextInboundEvent(daysAgo(20));
  service.markInboundIgnored(claimed.id, claimed.lease, "old-not-needed", finish(claimed, daysAgo(20)));

  service.storeInboundEvent({ eventType: "connection.update", waMessageId: null, payload: {}, now: daysAgo(10) });
  claimed = service.claimNextInboundEvent(daysAgo(10));
  service.markInboundIgnored(claimed.id, claimed.lease, "recent-not-needed", finish(claimed, daysAgo(10)));

  service.storeInboundEvent({ eventType: "connection.update", waMessageId: "failed-old", payload: {}, now: daysAgo(40) });
  claimed = service.claimNextInboundEvent(daysAgo(40));
  service.markInboundFailed(claimed.id, claimed.lease, "boom", finish(claimed, daysAgo(40)));

  service.storeInboundEvent({ eventType: "connection.update", waMessageId: "failed-recent", payload: {}, now: daysAgo(20) });
  claimed = service.claimNextInboundEvent(daysAgo(20));
  service.markInboundFailed(claimed.id, claimed.lease, "boom", finish(claimed, daysAgo(20)));

  service.storeInboundEvent({ eventType: "connection.update", waMessageId: "pending-ancient", payload: {}, now: daysAgo(40) });

  assert.equal(service.purgeInboundEvents(now), 3);
  assert.equal(eventRow("done-old"), undefined);
  assert.equal(eventRow("failed-old"), undefined);
  assert.ok(!db.prepare("SELECT 1 FROM wa_inbound_events WHERE last_error = 'old-not-needed'").get());
  assert.ok(eventRow("done-recent"));
  assert.ok(eventRow("failed-recent"));
  assert.ok(eventRow("pending-ancient"));
  assert.ok(db.prepare("SELECT 1 FROM wa_inbound_events WHERE last_error = 'recent-not-needed'").get());
});

// ---------------------------------------------------------------------------
// Route: POST /api/whatsapp/webhook/[secret]
// ---------------------------------------------------------------------------

test("route: 404 with empty body when WhatsApp is unconfigured", async () => {
  unconfigureEnv();
  try {
    const res = await post({ event: "messages.upsert", data: customerMessage("unconfigured") });
    assert.equal(res.status, 404);
    assert.equal(await res.text(), "");
  } finally {
    configureEnv();
  }
  assert.equal(eventRow("unconfigured"), undefined);
});

test("route: wrong path secret -> 404, wrong or missing header -> 401", async () => {
  clearBudget();
  const wrongPath = await post(
    { event: "messages.upsert", data: customerMessage("sec-1") },
    { pathSecret: "not-the-secret-segment-at-all-1234567890" },
  );
  assert.equal(wrongPath.status, 404);
  assert.equal(await wrongPath.text(), "");

  const wrongHeader = await post(
    { event: "messages.upsert", data: customerMessage("sec-1") },
    { headerSecret: "wrong-header-value-0123456789" },
  );
  assert.equal(wrongHeader.status, 401);

  const missingHeader = await post(
    { event: "messages.upsert", data: customerMessage("sec-1") },
    { headerSecret: null },
  );
  assert.equal(missingHeader.status, 401);

  assert.equal(eventRow("sec-1"), undefined);
});

test("route: stores a customer message once; a duplicate post stays one row", async () => {
  clearBudget();
  const payload = { event: "MESSAGES_UPSERT", instance: "test-instance", data: customerMessage("route-msg-1") };

  const res = await post(payload);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  const row = eventRow("route-msg-1");
  assert.ok(row);
  assert.equal(row.event_type, "messages.upsert");
  assert.equal(row.status, "pending");
  const stored = JSON.parse(row.payload_json);
  assert.equal(stored.instance, "test-instance");
  assert.equal(stored.key.id, "route-msg-1");
  assert.equal(stored.key.remoteJid, "212600000000@s.whatsapp.net");
  assert.deepEqual(stored.message, { conversation: "salam, lwnsit?" });

  // Same key.id again (lowercase event name this time): 200, still one row.
  const dup = await post({ ...payload, event: "messages.upsert" });
  assert.equal(dup.status, 200);
  assert.deepEqual(await dup.json(), { ok: true });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM wa_inbound_events WHERE wa_message_id = 'route-msg-1'").get().c,
    1,
  );
});

test("route: fromMe, group, status, broadcast, newsletter and missing key.id are not stored", async () => {
  clearBudget();
  const cases = [
    { tag: "own-1", data: { key: { remoteJid: "212600000000@s.whatsapp.net", fromMe: true, id: "own-1" }, message: { conversation: "moi" } } },
    { tag: "grp-1", data: { key: { remoteJid: "120363021234@g.us", fromMe: false, id: "grp-1" }, message: { conversation: "groupe" } } },
    { tag: "st-1", data: { key: { remoteJid: "status@broadcast", fromMe: false, id: "st-1" }, message: { conversation: "statut" } } },
    { tag: "bct-1", data: { key: { remoteJid: "list@broadcast", fromMe: false, id: "bct-1" }, message: { conversation: "liste" } } },
    { tag: "nws-1", data: { key: { remoteJid: "12345@newsletter", fromMe: false, id: "nws-1" }, message: { conversation: "canal" } } },
    { tag: "noid-1", data: { key: { remoteJid: "212600000000@s.whatsapp.net", fromMe: false }, message: { conversation: "sans id" } } },
  ];
  for (const { data } of cases) {
    const res = await post({ event: "messages.upsert", data });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  }
  for (const { tag } of cases) {
    assert.equal(eventRow(tag), undefined, `event ${tag} must not be stored`);
  }
});

test("route: data may be an array; only valid messages are stored", async () => {
  clearBudget();
  const res = await post({
    event: "messages.upsert",
    instance: "test-instance",
    data: [
      customerMessage("arr-1"),
      { key: { remoteJid: "120363021234@g.us", fromMe: false, id: "arr-group" }, message: {} },
      customerMessage("arr-2"),
    ],
  });
  assert.equal(res.status, 200);
  assert.ok(eventRow("arr-1"));
  assert.ok(eventRow("arr-2"));
  assert.equal(eventRow("arr-group"), undefined);
});

test("route: connection.update is stored with a null message id; unknown events store nothing", async () => {
  clearBudget();
  const res = await post({
    event: "CONNECTION_UPDATE",
    instance: "test-instance",
    data: { state: "open" },
    marker: "route-conn-update",
  });
  assert.equal(res.status, 200);
  const row = db
    .prepare("SELECT * FROM wa_inbound_events WHERE payload_json LIKE '%route-conn-update%'")
    .get();
  assert.ok(row);
  assert.equal(row.event_type, "connection.update");
  assert.equal(row.wa_message_id, null);

  const before = countEvents();
  const unknown = await post({ event: "messages.update", data: { x: 1 } });
  assert.equal(unknown.status, 200);
  const noEvent = await post({ data: { x: 1 } });
  assert.equal(noEvent.status, 200);
  assert.equal(countEvents(), before);

  // A JSON array body is not an event object: acknowledged, nothing stored.
  const weird = await route.POST(
    new Request(`${WEBHOOK_URL}/${SECRET}`, {
      method: "POST",
      headers: { "x-webhook-secret": SECRET },
      body: JSON.stringify([1, 2, 3]),
    }),
    { params: Promise.resolve({ secret: SECRET }) },
  );
  assert.equal(weird.status, 200);
  assert.equal(countEvents(), before);
});

test("route: oversize body -> 413, invalid or empty JSON -> 400", async () => {
  clearBudget();
  const big = { event: "messages.upsert", data: customerMessage("big-1"), pad: "x".repeat(600 * 1024) };
  const res413 = await post(big);
  assert.equal(res413.status, 413);
  assert.equal(await res413.text(), "");
  assert.equal(eventRow("big-1"), undefined);

  const res400 = await route.POST(
    new Request(`${WEBHOOK_URL}/${SECRET}`, {
      method: "POST",
      headers: { "x-webhook-secret": SECRET },
      body: "{not json",
    }),
    { params: Promise.resolve({ secret: SECRET }) },
  );
  assert.equal(res400.status, 400);

  const empty = await route.POST(
    new Request(`${WEBHOOK_URL}/${SECRET}`, {
      method: "POST",
      headers: { "x-webhook-secret": SECRET },
      body: "",
    }),
    { params: Promise.resolve({ secret: SECRET }) },
  );
  assert.equal(empty.status, 400);
});

test("route: non-POST methods get 405, or 404 while unconfigured", async () => {
  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
    const res = await route[method]();
    assert.equal(res.status, 405);
  }
  unconfigureEnv();
  try {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const res = await route[method]();
      assert.equal(res.status, 404);
    }
  } finally {
    configureEnv();
  }
});

test("route: 429 with Retry-After when the global webhook budget is exhausted", async () => {
  clearBudget();
  const ok = await post({ event: "messages.upsert", data: customerMessage("rate-ok") });
  assert.equal(ok.status, 200);

  db.prepare(
    "INSERT INTO security_budgets(key, hits, expires_at) VALUES (?, 600, ?) " +
      "ON CONFLICT(key) DO UPDATE SET hits = 600, expires_at = excluded.expires_at",
  ).run(BUDGET_KEY, Date.now() + 60_000);

  const limited = await post({ event: "messages.upsert", data: customerMessage("rate-limited") });
  assert.equal(limited.status, 429);
  const retryAfter = Number(limited.headers.get("Retry-After"));
  assert.ok(Number.isInteger(retryAfter) && retryAfter > 0);
  assert.equal(eventRow("rate-limited"), undefined);

  clearBudget();
});
