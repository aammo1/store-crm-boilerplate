import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { loadSource } from "../test-source.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-worker-"));
process.env.DELIVERY_PROVIDER = "mock";
process.env.DB_PATH = path.join(dir, "crm.db");
process.env.AUTH_SECRET = "x".repeat(40);
process.env.CRM_PUBLIC_URL = "https://crm.example.test";
process.env.SECURITY_ALLOWED_ORIGINS = "https://crm.example.test";
process.env.HEALTH_DETAILS_TOKEN = "h".repeat(32);
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
const db = getDb();

const {
  waTick,
  waMaintenance,
  startWhatsAppWorker,
  __setSleepForTest,
  __resetWhatsAppWorkerForTest,
} = loadSource("@/lib/workers/whatsapp");
const { workerHealth, stopWorkerTimers } = loadSource("@/lib/workers");
const { GET: healthGet } = loadSource("@/app/api/health/route");
const settingsService = loadSource("@/lib/services/whatsapp-settings");
const { setAppState } = loadSource("@/lib/services/app-state");
const outbox = loadSource("@/lib/services/whatsapp-outbox");
const inboundEvents = loadSource("@/lib/services/whatsapp-inbound-events");
const conversations = loadSource("@/lib/services/whatsapp-conversations");

// Stub sleep so typing simulations run instantly in tests
__setSleepForTest(async () => {});

let fetchCalls = [];
let fetchQueue = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init });
  const handler = fetchQueue.shift();
  if (!handler) {
    throw new Error(`Stub fetch: appel reseau inattendu: ${String(url)}`);
  }
  if (typeof handler === "function") {
    return handler(url, init);
  }
  return handler;
};

after(() => {
  globalThis.fetch = originalFetch;
  __resetWhatsAppWorkerForTest();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fetchCalls = [];
  fetchQueue = [];
  __resetWhatsAppWorkerForTest();
  __setSleepForTest(async () => {});
  db.prepare("DELETE FROM wa_outbox").run();
  db.prepare("DELETE FROM wa_inbound_events").run();
  db.prepare("DELETE FROM wa_messages").run();
  db.prepare("DELETE FROM wa_conversations").run();
  setAppState("wa_next_send_at", new Date(0).toISOString());
  settingsService.updateWhatsAppSettings({
    enabled: true,
    notificationsEnabled: true,
    aiEnabled: true,
    sendWindowStart: "00:00",
    sendWindowEnd: "23:59",
  });
});

const jsonResponse = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

test("unconfigured WhatsApp: worker doesn't start, health shows whatsapp.enabled = false", async () => {
  const origBase = process.env.EVOLUTION_BASE_URL;
  const origSecret = process.env.WHATSAPP_WEBHOOK_SECRET;
  try {
    delete process.env.EVOLUTION_BASE_URL;
    delete process.env.WHATSAPP_WEBHOOK_SECRET;

    startWhatsAppWorker();
    const g = globalThis;
    assert.equal(g.__crmWhatsAppWorker, undefined);
    assert.equal(g.__crmWhatsAppMaintenance, undefined);

    const health = workerHealth();
    assert.equal(health.whatsapp.enabled, false);

    // Check /api/health
    const pubReq = new Request("https://crm.example.test/api/health");
    const pubRes = await healthGet(pubReq);
    assert.equal(pubRes.status, 200);
    const pubJson = await pubRes.json();
    assert.equal(pubJson.status, "ok");

    const privReq = new Request("https://crm.example.test/api/health", {
      headers: { Authorization: `Bearer ${process.env.HEALTH_DETAILS_TOKEN}` },
    });
    const privRes = await healthGet(privReq);
    assert.equal(privRes.status, 200);
    const privJson = await privRes.json();
    assert.equal(privJson.workers.whatsapp.enabled, false);
    assert.equal(privJson.whatsapp.configured, false);
  } finally {
    process.env.EVOLUTION_BASE_URL = origBase;
    process.env.WHATSAPP_WEBHOOK_SECRET = origSecret;
  }
});

test("queued ai_reply is sent with presence first and marked sent with wa_message_id", async () => {
  const phone = "+212600000001";
  conversations.getOrCreateConversation(phone, null, "Fatima");

  // Enqueue an ai_reply
  db.transaction(() => {
    outbox.enqueueOutbox({
      dedupeKey: "test-ai-reply-1",
      phone,
      purpose: "ai_reply",
      body: "Salam Fatima, votre commande est confirmee.",
      kind: "text",
    });
  })();

  // 1st call expected: sendPresence
  fetchQueue.push(() => jsonResponse({ success: true }));
  // 2nd call expected: sendText
  fetchQueue.push(() =>
    jsonResponse({
      key: { id: "wa-msg-id-777", remoteJid: "212600000001@s.whatsapp.net", fromMe: true },
    }),
  );

  await waTick();

  // Verify fetch calls
  assert.equal(fetchCalls.length, 2);
  const [presenceCall, sendCall] = fetchCalls;

  // 1. sendPresence
  assert.ok(presenceCall.url.includes("/chat/sendPresence/test-instance"));
  const presenceBody = JSON.parse(presenceCall.init.body);
  assert.equal(presenceBody.number, "212600000001");
  assert.equal(presenceBody.presence, "composing");
  assert.ok(presenceBody.delay >= 1200 && presenceBody.delay <= 6800);

  // 2. sendText
  assert.ok(sendCall.url.includes("/message/sendText/test-instance"));
  const sendBody = JSON.parse(sendCall.init.body);
  assert.equal(sendBody.number, "212600000001");
  assert.equal(sendBody.text, "Salam Fatima, votre commande est confirmee.");

  // Verify outbox row status in DB
  const row = db.prepare("SELECT * FROM wa_outbox WHERE dedupe_key = 'test-ai-reply-1'").get();
  assert.equal(row.status, "sent");
  assert.equal(row.wa_message_id, "wa-msg-id-777");
  assert.equal(row.lease, null);
  assert.ok(row.sent_at);

  // Verify outbound message was inserted into wa_messages
  const msg = db.prepare("SELECT * FROM wa_messages WHERE wa_message_id = 'wa-msg-id-777'").get();
  assert.ok(msg);
  assert.equal(msg.direction, "out");
  assert.equal(msg.author, "ai");
});

test("timeout on send gives uncertain and it is not re-sent on next ticks", async () => {
  const phone = "+212600000002";
  db.transaction(() => {
    outbox.enqueueOutbox({
      dedupeKey: "test-timeout-1",
      phone,
      purpose: "notify_confirmed",
      body: "Commande confirmee.",
      kind: "text",
      respectWindow: false,
    });
  })();

  // Outbound sendText throws timeout
  fetchQueue.push(() => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    throw err;
  });

  await waTick();

  // Outbox row must be uncertain (never retry!)
  const row = db.prepare("SELECT * FROM wa_outbox WHERE dedupe_key = 'test-timeout-1'").get();
  assert.equal(row.status, "uncertain");
  assert.equal(row.lease, null);
  assert.ok(row.last_error.includes("timeout"));

  // Subsequent tick: should NOT claim or re-send
  fetchCalls = [];
  await waTick();
  assert.equal(fetchCalls.length, 0);

  const rowAfter = db.prepare("SELECT * FROM wa_outbox WHERE dedupe_key = 'test-timeout-1'").get();
  assert.equal(rowAfter.status, "uncertain");
});

test("401 on send gives failed", async () => {
  const phone = "+212600000003";
  db.transaction(() => {
    outbox.enqueueOutbox({
      dedupeKey: "test-401-1",
      phone,
      purpose: "notify_shipped",
      body: "Colis expedie.",
      kind: "text",
      respectWindow: false,
    });
  })();

  fetchQueue.push(() => jsonResponse({ message: "Unauthorized: invalid API key" }, 401));

  await waTick();

  const row = db.prepare("SELECT * FROM wa_outbox WHERE dedupe_key = 'test-401-1'").get();
  assert.equal(row.status, "failed");
  assert.equal(row.lease, null);
  assert.ok(row.last_error.includes("Unauthorized"));
});

test("not_on_whatsapp marks conversation no_whatsapp=1 and cancels other queued rows", async () => {
  const phone = "+212600000004";
  conversations.getOrCreateConversation(phone, null, "Amine");

  db.transaction(() => {
    outbox.enqueueOutbox({
      dedupeKey: "test-not-wa-1",
      phone,
      purpose: "notify_confirmed",
      body: "Message 1",
      kind: "text",
      respectWindow: false,
    });
    outbox.enqueueOutbox({
      dedupeKey: "test-not-wa-2",
      phone,
      purpose: "notify_shipped",
      body: "Message 2",
      kind: "text",
      respectWindow: false,
    });
  })();

  // Evolution returns 400 not on whatsapp
  fetchQueue.push(() =>
    jsonResponse(
      {
        message: "The number 212600000004 is not on whatsapp",
        exists: false,
      },
      400,
    ),
  );

  await waTick();

  // 1st row marked failed
  const row1 = db.prepare("SELECT * FROM wa_outbox WHERE dedupe_key = 'test-not-wa-1'").get();
  assert.equal(row1.status, "failed");
  assert.ok(row1.last_error.includes("not_on_whatsapp"));

  // 2nd row for same phone cancelled
  const row2 = db.prepare("SELECT * FROM wa_outbox WHERE dedupe_key = 'test-not-wa-2'").get();
  assert.equal(row2.status, "cancelled");

  // Conversation has no_whatsapp = 1
  const conv = conversations.getConversationByPhone(phone);
  assert.ok(conv);
  assert.equal(conv.noWhatsapp, true);
});

test("with kill switch OFF, nothing is sent while inbound events are still processed", async () => {
  // Disable WhatsApp via settings
  settingsService.updateWhatsAppSettings({ enabled: false });

  // Insert an outbox row directly (enqueueOutbox skips when disabled)
  const outId = "outbox-kill-off";
  db.prepare(`
    INSERT INTO wa_outbox (
      id, dedupe_key, phone, purpose, kind, body, respect_window,
      counts_toward_cap, status, attempts, available_at, created_at, updated_at
    ) VALUES (
      ?, 'dedupe-kill-off', '+212600000005', 'ai_reply', 'text', 'Test',
      0, 0, 'queued', 0, datetime('now', '-1 minute'), datetime('now'), datetime('now')
    )
  `).run(outId);

  // Store an inbound event
  inboundEvents.storeInboundEvent({
    eventType: "messages.upsert",
    waMessageId: "in-msg-kill-off",
    payload: {
      key: { id: "in-msg-kill-off", remoteJid: "212600000005@s.whatsapp.net", fromMe: false },
      pushName: "Salma",
      message: { conversation: "Bonjour je veux des infos" },
    },
  });

  await waTick();

  // Outbox row must remain queued, nothing sent
  const outRow = db.prepare("SELECT * FROM wa_outbox WHERE id = ?").get(outId);
  assert.equal(outRow.status, "queued");
  assert.equal(fetchCalls.length, 0);

  // Inbound event must be processed (status 'done')
  const inRow = db.prepare("SELECT * FROM wa_inbound_events WHERE wa_message_id = 'in-msg-kill-off'").get();
  assert.equal(inRow.status, "done");

  // Conversation recorded in inbox
  const conv = conversations.getConversationByPhone("+212600000005");
  assert.ok(conv);
  assert.equal(conv.unreadCount, 1);
});

test("maintenance purges old outbox rows, old inbound events, and refreshes connection state", async () => {
  const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 86_400_000).toISOString();
  const twentyDaysAgo = new Date(Date.now() - 20 * 86_400_000).toISOString();

  // Old sent outbox row (> 30 days)
  db.prepare(`
    INSERT INTO wa_outbox (
      id, dedupe_key, phone, purpose, kind, body, respect_window,
      counts_toward_cap, status, attempts, available_at, created_at, updated_at
    ) VALUES (
      'out-purge-1', 'dedupe-purge-1', '+212600000006', 'notify_confirmed', 'text', 'Old',
      0, 0, 'sent', 1, ?, ?, ?
    )
  `).run(thirtyFiveDaysAgo, thirtyFiveDaysAgo, thirtyFiveDaysAgo);

  // Recent sent outbox row (< 30 days)
  const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString();
  db.prepare(`
    INSERT INTO wa_outbox (
      id, dedupe_key, phone, purpose, kind, body, respect_window,
      counts_toward_cap, status, attempts, available_at, created_at, updated_at
    ) VALUES (
      'out-keep-1', 'dedupe-keep-1', '+212600000006', 'notify_confirmed', 'text', 'Keep',
      0, 0, 'sent', 1, ?, ?, ?
    )
  `).run(fiveDaysAgo, fiveDaysAgo, fiveDaysAgo);

  // Old done inbound event (> 14 days)
  db.prepare(`
    INSERT INTO wa_inbound_events (
      id, event_type, wa_message_id, payload_json, status, attempts, available_at, received_at, processed_at
    ) VALUES (
      'in-purge-1', 'messages.upsert', 'msg-purge-1', '{}', 'done', 1, ?, ?, ?
    )
  `).run(twentyDaysAgo, twentyDaysAgo, twentyDaysAgo);

  // Connection state mock for maintenance
  fetchQueue.push(() =>
    jsonResponse({
      instance: { state: "open" },
    }),
  );

  await waMaintenance();

  // out-purge-1 should be deleted, out-keep-1 remains
  const purgedOut = db.prepare("SELECT * FROM wa_outbox WHERE id = 'out-purge-1'").get();
  assert.equal(purgedOut, undefined);
  const keptOut = db.prepare("SELECT * FROM wa_outbox WHERE id = 'out-keep-1'").get();
  assert.ok(keptOut);

  // in-purge-1 should be deleted
  const purgedIn = db.prepare("SELECT * FROM wa_inbound_events WHERE id = 'in-purge-1'").get();
  assert.equal(purgedIn, undefined);

  // Connection state updated
  const conn = settingsService.getWhatsAppConnectionState();
  assert.equal(conn.state, "open");
});

test("losing worker lease stops WhatsApp timers", () => {
  const g = globalThis;
  // Simulate registered worker timers
  g.__crmWhatsAppWorker = setInterval(() => {}, 10_000);
  g.__crmWhatsAppMaintenance = setInterval(() => {}, 10_000);

  assert.ok(g.__crmWhatsAppWorker);
  assert.ok(g.__crmWhatsAppMaintenance);
  assert.equal(workerHealth().whatsapp.enabled, true);

  // Lease lost -> stopWorkerTimers()
  stopWorkerTimers();

  assert.equal(g.__crmWhatsAppWorker, undefined);
  assert.equal(g.__crmWhatsAppMaintenance, undefined);
  assert.equal(workerHealth().whatsapp.enabled, false);
});

test("queued image message is sent with sendImage and correct payload", async () => {
  const phone = "+212600000008";
  db.transaction(() => {
    outbox.enqueueOutbox({
      dedupeKey: "test-image-1",
      phone,
      purpose: "ai_reply",
      body: "Voici la photo du produit",
      kind: "image",
      mediaRef: "wa/2026/10/product.png",
      respectWindow: false,
    });
  })();

  // 1st: sendPresence
  fetchQueue.push(() => jsonResponse({ success: true }));
  // 2nd: sendMedia
  fetchQueue.push(() =>
    jsonResponse({
      key: { id: "wa-img-id-999" },
    }),
  );

  await waTick();

  assert.equal(fetchCalls.length, 2);
  const sendCall = fetchCalls[1];
  assert.ok(sendCall.url.includes("/message/sendMedia/test-instance"));
  const body = JSON.parse(sendCall.init.body);
  assert.equal(body.number, "212600000008");
  assert.equal(body.mediatype, "image");
  assert.equal(body.mimetype, "image/png");
  assert.equal(body.fileName, "product.png");
  assert.equal(body.caption, "Voici la photo du produit");
  assert.equal(body.media, "wa/2026/10/product.png");

  const row = db.prepare("SELECT * FROM wa_outbox WHERE dedupe_key = 'test-image-1'").get();
  assert.equal(row.status, "sent");
  assert.equal(row.wa_message_id, "wa-img-id-999");
});

test("maintenance recovers stale sending rows to uncertain and stale inbound to pending", async () => {
  const sixMinutesAgo = new Date(Date.now() - 6 * 60_000).toISOString();

  // Outbox row stuck in sending for 6 mins
  db.prepare(`
    INSERT INTO wa_outbox (
      id, dedupe_key, phone, purpose, kind, body, respect_window,
      counts_toward_cap, status, attempts, lease, available_at, created_at, updated_at
    ) VALUES (
      'out-stale-1', 'dedupe-stale-1', '+212600000009', 'notify_confirmed', 'text', 'Stuck',
      0, 0, 'sending', 1, 'stale-lease-123', ?, ?, ?
    )
  `).run(sixMinutesAgo, sixMinutesAgo, sixMinutesAgo);

  // Inbound event stuck in processing with available_at in the past
  db.prepare(`
    INSERT INTO wa_inbound_events (
      id, event_type, wa_message_id, payload_json, status, attempts, lease, available_at, received_at
    ) VALUES (
      'in-stale-1', 'messages.upsert', 'msg-stale-1', '{}', 'processing', 1, 'lease-in-123', ?, ?
    )
  `).run(sixMinutesAgo, sixMinutesAgo);

  fetchQueue.push(() =>
    jsonResponse({
      instance: { state: "open" },
    }),
  );

  await waMaintenance();

  const outRow = db.prepare("SELECT * FROM wa_outbox WHERE id = 'out-stale-1'").get();
  assert.equal(outRow.status, "uncertain");
  assert.equal(outRow.lease, null);

  const inRow = db.prepare("SELECT * FROM wa_inbound_events WHERE id = 'in-stale-1'").get();
  assert.equal(inRow.status, "pending");
  assert.equal(inRow.lease, null);
});
