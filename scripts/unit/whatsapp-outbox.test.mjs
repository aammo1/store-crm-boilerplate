import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "../test-source.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-outbox-"));
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
const outbox = loadSource("@/lib/services/whatsapp-outbox");
const settingsService = loadSource("@/lib/services/whatsapp-settings");
const appState = loadSource("@/lib/services/app-state");
const pacing = loadSource("@/lib/whatsapp/pacing");
const db = getDb();

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// Independent Casablanca formatter (not the code under test) for round-trip checks.
const casablancaFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Casablanca",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const casablancaStamp = (instant) => {
  const parts = Object.fromEntries(casablancaFormatter.formatToParts(instant).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};

// Stable-offset stretch of the year (no Africa/Casablanca transition nearby).
const DAY = "2026-06-15";
const NEXT_DAY = "2026-06-16";
const PHONE_A = "+212600000010";
const PHONE_B = "+212600000011";
const PHONE_ADMIN = "+212700000001";
const PHONE_CONV_A = "+212600000020";
const PHONE_CONV_B = "+212600000021";
const PHONE_ORDER = "+212600000030";

const setSettings = (patch) => settingsService.updateWhatsAppSettings(patch);
const resetOutbox = () => {
  db.prepare("DELETE FROM wa_outbox").run();
  db.prepare("DELETE FROM app_state WHERE key = 'wa_next_send_at'").run();
};
const outboxCount = () => db.prepare("SELECT COUNT(*) AS n FROM wa_outbox").get().n;
const rowByKey = (key) => db.prepare("SELECT * FROM wa_outbox WHERE dedupe_key = ?").get(key);
const rowById = (id) => db.prepare("SELECT * FROM wa_outbox WHERE id = ?").get(id);
const atDay = (date, time) => pacing.casablancaDateTimeToDate(date, time);
const dueAt = (now) => new Date(now.getTime() - 1_000).toISOString();

let convSeq = 0;
function insertConversation(phone, { noWhatsapp = 0 } = {}) {
  convSeq += 1;
  const id = `conv-${convSeq}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO wa_conversations (id, phone, no_whatsapp, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, phone, noWhatsapp, now, now);
  return id;
}

function insertUser(id) {
  db.prepare("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, 'agent', ?)")
    .run(id, `${id}@example.test`, "h".repeat(60), "Agent Test", new Date().toISOString());
  return id;
}

function insertOrder(id, phone) {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO orders (id, customer_name, customer_phone, items_json, subtotal, shipping, total, created_at, updated_at) VALUES (?, ?, ?, '[]', 100, 30, 130, ?, ?)",
  ).run(id, "Client Test", phone, now, now);
  return id;
}

test("pacing: Casablanca parts, window boundaries at 08:59/09:00/20:59/21:00 and gaps", () => {
  // The date builder round-trips through an independent formatter.
  for (const time of ["00:00", "08:59", "09:00", "12:00", "20:59", "21:00", "23:59"]) {
    const instant = atDay(DAY, time);
    assert.equal(casablancaStamp(instant), `${DAY} ${time}`, time);
    const parts = pacing.casablancaParts(instant);
    assert.equal(parts.date, DAY, time);
    assert.equal(parts.minutes, Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)), time);
  }

  // Window [09:00, 21:00): closed at 08:59 and 21:00, open at 09:00 and 20:59.
  assert.equal(pacing.inWindow(atDay(DAY, "08:59"), "09:00", "21:00"), false);
  assert.equal(pacing.inWindow(atDay(DAY, "09:00"), "09:00", "21:00"), true);
  assert.equal(pacing.inWindow(atDay(DAY, "20:59"), "09:00", "21:00"), true);
  assert.equal(pacing.inWindow(atDay(DAY, "21:00"), "09:00", "21:00"), false);

  // start >= end is invalid: the default 09:00-21:00 applies, never "always open".
  assert.equal(pacing.inWindow(atDay(DAY, "03:00"), "21:00", "09:00"), false);
  assert.equal(pacing.inWindow(atDay(DAY, "12:00"), "21:00", "09:00"), true);
  assert.equal(pacing.inWindow(atDay(DAY, "22:00"), "09:00", "09:00"), false);
  assert.deepEqual(pacing.effectiveWindow("21:00", "09:00"), { start: "09:00", end: "21:00" });
  assert.deepEqual(pacing.effectiveWindow("08:00", "20:00"), { start: "08:00", end: "20:00" });

  // Next opening: today when still ahead of the start, tomorrow otherwise.
  const beforeOpen = pacing.nextWindowOpen(atDay(DAY, "08:59"), "09:00");
  assert.equal(casablancaStamp(beforeOpen), `${DAY} 09:00`);
  assert.ok(beforeOpen.getTime() > atDay(DAY, "08:59").getTime());
  const afterClose = pacing.nextWindowOpen(atDay(DAY, "21:00"), "09:00");
  assert.equal(casablancaStamp(afterClose), `${NEXT_DAY} 09:00`);

  // Cap deferral target: tomorrow's window opening.
  const tomorrowOpen = pacing.tomorrowWindowOpen(atDay(DAY, "10:00"), "09:00");
  assert.equal(casablancaStamp(tomorrowOpen), `${NEXT_DAY} 09:00`);

  // Random gaps: whole seconds within [min, max], deterministic with an injected rnd.
  assert.equal(pacing.randomGapMs(30, 120, () => 0), 30_000);
  assert.equal(pacing.randomGapMs(30, 120, () => 0.5), 75_000);
  assert.equal(pacing.randomGapMs(30, 120, () => 0.999), 120_000);
  assert.equal(pacing.randomGapMs(30, 30, () => 0.9), 30_000);
  assert.equal(pacing.randomGapMs(2, 5, () => 0), 2_000);
  assert.equal(pacing.randomGapMs(2, 5, () => 0.999), 5_000);
});

test("enqueueOutbox skips everything while the kill switch is off", () => {
  db.prepare("DELETE FROM wa_outbox").run();
  // Settings untouched so far: enabled=false.
  assert.equal(outbox.enqueueOutbox({ dedupeKey: "t2:notify", phone: PHONE_A, purpose: "notify_confirmed", body: "Bonjour" }), false);
  assert.equal(outbox.enqueueOutbox({ dedupeKey: "t2:ai", phone: PHONE_A, purpose: "ai_reply", body: "Reponse" }), false);
  assert.equal(outbox.enqueueOutbox({ dedupeKey: "t2:admin", phone: PHONE_ADMIN, purpose: "admin_alert", body: "Alerte" }), false);
  assert.equal(outboxCount(), 0);
});

test("enqueueOutbox dedupes on dedupe_key and applies purpose-class defaults", () => {
  setSettings({ enabled: true, notificationsEnabled: true });
  const convId = insertConversation(PHONE_A);

  assert.equal(outbox.enqueueOutbox({ dedupeKey: "order:o1:confirmed", phone: PHONE_A, purpose: "notify_confirmed", body: "Confirmee", conversationId: convId }), true);
  // Same dedupe key again: one row only, whatever the phone or body.
  assert.equal(outbox.enqueueOutbox({ dedupeKey: "order:o1:confirmed", phone: PHONE_B, purpose: "notify_confirmed", body: "Confirmee", conversationId: convId }), false);
  assert.equal(outboxCount(), 1);
  const first = rowByKey("order:o1:confirmed");
  assert.equal(first.phone, PHONE_A);
  assert.equal(first.status, "queued");
  assert.equal(first.conversation_id, convId);
  assert.equal(first.respect_window, 1);
  assert.equal(first.counts_toward_cap, 1);

  const enqueue = (key, purpose, extra = {}) => {
    const ok = outbox.enqueueOutbox({ dedupeKey: key, phone: PHONE_A, purpose, body: "x", conversationId: convId, ...extra });
    assert.equal(ok, true, key);
    return rowByKey(key);
  };

  const relance = enqueue("t3:relance", "relance_no_answer");
  assert.equal(relance.respect_window, 1);
  assert.equal(relance.counts_toward_cap, 1);

  const card = enqueue("t3:card", "product_card");
  assert.equal(card.respect_window, 1);
  assert.equal(card.counts_toward_cap, 1);

  for (const [key, purpose] of [["t3:ai", "ai_reply"], ["t3:agent", "agent_reply"], ["t3:strike", "strike_warning"]]) {
    const row = enqueue(key, purpose);
    assert.equal(row.respect_window, 0, purpose);
    assert.equal(row.counts_toward_cap, 0, purpose);
  }

  // Admin alerts follow the quiet-hours toggle and never count toward the cap.
  const adminAlert = (key) => {
    const ok = outbox.enqueueOutbox({ dedupeKey: key, phone: PHONE_ADMIN, purpose: "admin_alert", body: "x" });
    assert.equal(ok, true, key);
    return rowByKey(key);
  };
  let alert = adminAlert("t3:admin-open");
  assert.equal(alert.respect_window, 0);
  assert.equal(alert.counts_toward_cap, 0);
  setSettings({ adminQuietHours: true });
  alert = adminAlert("t3:admin-quiet");
  assert.equal(alert.respect_window, 1);
  assert.equal(alert.counts_toward_cap, 0);
  setSettings({ adminQuietHours: false });

  // Explicit overrides win (product cards ride along with AI replies).
  const cardOverride = enqueue("t3:card-override", "product_card", {
    respectWindow: false,
    countsTowardCap: false,
    kind: "image",
    mediaRef: "https://cdn.example.test/p.webp",
  });
  assert.equal(cardOverride.respect_window, 0);
  assert.equal(cardOverride.counts_toward_cap, 0);
  assert.equal(cardOverride.kind, "image");

  // author_user_id is stored for agent replies (task 18 sets it).
  insertUser("u-agent-1");
  const agentRow = enqueue("t3:agent-author", "agent_reply", { authorUserId: "u-agent-1" });
  assert.equal(agentRow.author_user_id, "u-agent-1");
});

test("enqueueOutbox skips notification-gated, blocked and no-WhatsApp phones", () => {
  setSettings({ notificationsEnabled: false });
  const convB = insertConversation(PHONE_B);
  // notify_* and relance respect notificationsEnabled; replies and admin alerts don't.
  assert.equal(outbox.enqueueOutbox({ dedupeKey: "t4:notify", phone: PHONE_B, purpose: "notify_confirmed", body: "x", conversationId: convB }), false);
  assert.equal(outbox.enqueueOutbox({ dedupeKey: "t4:relance", phone: PHONE_B, purpose: "relance_no_answer", body: "x", conversationId: convB }), false);
  assert.equal(outbox.enqueueOutbox({ dedupeKey: "t4:ai", phone: PHONE_B, purpose: "ai_reply", body: "x", conversationId: convB }), true);
  setSettings({ notificationsEnabled: true });

  // Blocked phone: skipped for customer-facing purposes...
  const blockedPhone = "+212600000004";
  db.prepare("INSERT INTO blocked_phones (phone, reason, created_at) VALUES (?, ?, ?)")
    .run(blockedPhone, "Client abusif", new Date().toISOString());
  assert.equal(outbox.enqueueOutbox({ dedupeKey: "t4:blocked-notify", phone: blockedPhone, purpose: "notify_confirmed", body: "x" }), false);
  assert.equal(outbox.enqueueOutbox({ dedupeKey: "t4:blocked-ai", phone: blockedPhone, purpose: "ai_reply", body: "x" }), false);
  // ...but admin alerts still go through to a blocked number.
  db.prepare("INSERT INTO blocked_phones (phone, reason, created_at) VALUES (?, ?, ?)")
    .run(PHONE_ADMIN, "Test", new Date().toISOString());
  assert.equal(outbox.enqueueOutbox({ dedupeKey: "t4:blocked-admin", phone: PHONE_ADMIN, purpose: "admin_alert", body: "x" }), true);

  // no_whatsapp conversation: skipped, by conversation id and by phone.
  const convNoWa = insertConversation("+212600000005", { noWhatsapp: 1 });
  assert.equal(outbox.enqueueOutbox({ dedupeKey: "t4:nowa-conv", phone: "+212600000005", purpose: "ai_reply", body: "x", conversationId: convNoWa }), false);
  assert.equal(outbox.enqueueOutbox({ dedupeKey: "t4:nowa-phone", phone: "+212600000005", purpose: "notify_confirmed", body: "x" }), false);

  // Unparseable phone.
  assert.equal(outbox.enqueueOutbox({ dedupeKey: "t4:bad-phone", phone: "pas-un-numero", purpose: "ai_reply", body: "x" }), false);
});

test("claimNextOutbox defers window-closed notifications but still claims replies", () => {
  resetOutbox();
  setSettings({ sendWindowStart: "09:00", sendWindowEnd: "21:00", minGapSeconds: 30, maxGapSeconds: 30 });
  const now = atDay(DAY, "08:00");
  const due = dueAt(now);
  outbox.enqueueOutbox({ dedupeKey: "t5:notif", phone: PHONE_A, purpose: "notify_confirmed", body: "Confirmee", availableAt: due });
  outbox.enqueueOutbox({ dedupeKey: "t5:reply", phone: PHONE_B, purpose: "ai_reply", body: "Reponse", availableAt: due });

  // Replies bypass the window and jump the queue.
  const claimed = outbox.claimNextOutbox(now);
  assert.ok(claimed);
  assert.equal(claimed.purpose, "ai_reply");
  assert.equal(claimed.attempts, 1);
  assert.ok(claimed.lease);
  outbox.markOutboxSent(claimed.id, claimed.lease, "wamid-t5");

  // The 2-5s reply gap blocks an immediate second claim.
  assert.equal(outbox.claimNextOutbox(now), null);

  // Once the gap passes, the notification is deferred to the next 09:00 opening — not attempted.
  const later = new Date(now.getTime() + 10_000);
  assert.equal(outbox.claimNextOutbox(later), null);
  const notif = rowByKey("t5:notif");
  assert.equal(notif.status, "queued");
  assert.equal(notif.attempts, 0);
  assert.equal(notif.lease, null);
  assert.equal(notif.available_at, pacing.nextWindowOpen(later, "09:00").toISOString());
  assert.equal(casablancaStamp(new Date(notif.available_at)), `${DAY} 09:00`);
});

test("claimNextOutbox honours the global send gap", () => {
  resetOutbox();
  setSettings({ sendWindowStart: "09:00", sendWindowEnd: "21:00", minGapSeconds: 30, maxGapSeconds: 30 });
  const now = atDay(DAY, "10:00");
  outbox.enqueueOutbox({ dedupeKey: "t6:a", phone: PHONE_A, purpose: "notify_confirmed", body: "a", availableAt: dueAt(now) });
  outbox.enqueueOutbox({ dedupeKey: "t6:b", phone: PHONE_B, purpose: "notify_confirmed", body: "b", availableAt: now.toISOString() });

  const first = outbox.claimNextOutbox(now);
  assert.ok(first);
  assert.equal(first.phone, PHONE_A);
  // min == max => deterministic gap of exactly 30s.
  assert.equal(appState.getAppState("wa_next_send_at"), new Date(now.getTime() + 30_000).toISOString());
  assert.equal(outbox.claimNextOutbox(now), null);
  assert.equal(outbox.claimNextOutbox(new Date(now.getTime() + 29_000)), null);

  const second = outbox.claimNextOutbox(new Date(now.getTime() + 30_100));
  assert.ok(second);
  assert.equal(second.phone, PHONE_B);
  assert.equal(second.attempts, 1);
});

test("replies pace with a short 2-5s gap", () => {
  resetOutbox();
  setSettings({ sendWindowStart: "09:00", sendWindowEnd: "21:00" });
  const now = atDay(DAY, "10:00");
  outbox.enqueueOutbox({ dedupeKey: "t7:r", phone: PHONE_A, purpose: "ai_reply", body: "r", availableAt: dueAt(now) });
  const claimed = outbox.claimNextOutbox(now);
  assert.ok(claimed);
  const gap = new Date(appState.getAppState("wa_next_send_at")).getTime() - now.getTime();
  assert.ok(gap >= 2_000 && gap <= 5_000, `gap ${gap}ms`);
});

test("daily cap defers cap-counting rows to tomorrow's opening; replies still go", () => {
  resetOutbox();
  setSettings({ sendWindowStart: "09:00", sendWindowEnd: "21:00", minGapSeconds: 5, maxGapSeconds: 5, dailyOutboundCap: 2 });
  const now = atDay(DAY, "10:00");
  const due = dueAt(now);
  for (const key of ["t8:1", "t8:2", "t8:3"]) {
    outbox.enqueueOutbox({ dedupeKey: key, phone: PHONE_A, purpose: "notify_confirmed", body: key, availableAt: due });
  }
  // Two sends already counted today (Casablanca day).
  db.prepare("UPDATE wa_outbox SET status = 'sent', sent_at = ? WHERE dedupe_key IN ('t8:1','t8:2')")
    .run(atDay(DAY, "12:00").toISOString());

  assert.equal(outbox.claimNextOutbox(now), null);
  const third = rowByKey("t8:3");
  assert.equal(third.status, "queued");
  assert.equal(third.attempts, 0);
  assert.equal(third.available_at, pacing.tomorrowWindowOpen(now, "09:00").toISOString());
  assert.equal(casablancaStamp(new Date(third.available_at)), `${NEXT_DAY} 09:00`);

  // Replies don't count toward the cap and stay claimable.
  outbox.enqueueOutbox({ dedupeKey: "t8:ai", phone: PHONE_B, purpose: "ai_reply", body: "r", availableAt: due });
  const claimed = outbox.claimNextOutbox(now);
  assert.ok(claimed);
  assert.equal(claimed.purpose, "ai_reply");
});

test("markOutboxRetry requeues with capped backoff and fails after 10 attempts", () => {
  resetOutbox();
  setSettings({ sendWindowStart: "00:00", sendWindowEnd: "23:59" });
  outbox.enqueueOutbox({ dedupeKey: "t9:r", phone: PHONE_A, purpose: "ai_reply", body: "r" });
  const claimed = outbox.claimNextOutbox();
  assert.ok(claimed);

  outbox.markOutboxRetry(claimed.id, claimed.lease, "Evolution indisponible");
  let row = rowById(claimed.id);
  assert.equal(row.status, "queued");
  assert.equal(row.lease, null);
  assert.equal(row.last_error, "Evolution indisponible");
  const backoff = new Date(row.available_at).getTime() - Date.now();
  assert.ok(backoff >= 29_000 && backoff <= 31_500, `backoff ${backoff}ms`); // 15s * 2^1

  // After 10 attempts the row fails for good.
  db.prepare("UPDATE wa_outbox SET attempts = 10, available_at = ? WHERE id = ?")
    .run(new Date().toISOString(), claimed.id);
  const again = outbox.claimNextOutbox(new Date(Date.now() + 10_000));
  assert.ok(again && again.id === claimed.id);
  assert.equal(again.attempts, 11);
  outbox.markOutboxRetry(again.id, again.lease, "toujours ko");
  row = rowById(claimed.id);
  assert.equal(row.status, "failed");
  assert.equal(row.lease, null);

  // The backoff is capped at one hour.
  outbox.enqueueOutbox({ dedupeKey: "t9:c", phone: PHONE_A, purpose: "ai_reply", body: "r" });
  db.prepare("UPDATE wa_outbox SET attempts = 8 WHERE dedupe_key = 't9:c'").run();
  // Claim past the 2-5s reply gap left by the previous claim.
  const cappedClaim = outbox.claimNextOutbox(new Date(Date.now() + 20_000));
  assert.ok(cappedClaim);
  outbox.markOutboxRetry(cappedClaim.id, cappedClaim.lease, "ko");
  const capped = rowById(cappedClaim.id);
  assert.equal(capped.status, "queued");
  const cappedBackoff = new Date(capped.available_at).getTime() - Date.now();
  assert.ok(cappedBackoff >= 3_595_000 && cappedBackoff <= 3_601_000, `capped backoff ${cappedBackoff}ms`);
});

test("failed is terminal and uncertain is never re-claimed", () => {
  resetOutbox();
  outbox.enqueueOutbox({ dedupeKey: "t10:a", phone: PHONE_A, purpose: "ai_reply", body: "a" });
  outbox.enqueueOutbox({ dedupeKey: "t10:b", phone: PHONE_A, purpose: "ai_reply", body: "b" });

  const first = outbox.claimNextOutbox();
  assert.ok(first);
  outbox.markOutboxFailed(first.id, first.lease, "Erreur permanente");
  let row = rowById(first.id);
  assert.equal(row.status, "failed");
  assert.equal(row.last_error, "Erreur permanente");
  assert.equal(row.lease, null);

  const second = outbox.claimNextOutbox(new Date(Date.now() + 10_000));
  assert.ok(second);
  outbox.markOutboxUncertain(second.id, second.lease, "Resultat inconnu");
  row = rowById(second.id);
  assert.equal(row.status, "uncertain");

  // Neither a failed nor an uncertain row is ever handed out again.
  assert.equal(outbox.claimNextOutbox(new Date(Date.now() + 120_000)), null);
  assert.equal(rowById(second.id).status, "uncertain");
});

test("recoverStaleSending turns stale sending rows into uncertain", () => {
  resetOutbox();
  outbox.enqueueOutbox({ dedupeKey: "t11:stale", phone: PHONE_A, purpose: "ai_reply", body: "s" });
  outbox.enqueueOutbox({ dedupeKey: "t11:fresh", phone: PHONE_A, purpose: "ai_reply", body: "f" });
  const staleId = rowByKey("t11:stale").id;
  const freshId = rowByKey("t11:fresh").id;
  db.prepare("UPDATE wa_outbox SET status = 'sending', lease = 'lease-stale', updated_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 6 * 60_000).toISOString(), staleId);
  db.prepare("UPDATE wa_outbox SET status = 'sending', lease = 'lease-fresh', updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), freshId);

  assert.equal(outbox.recoverStaleSending(), 1);
  const stale = rowById(staleId);
  assert.equal(stale.status, "uncertain");
  assert.equal(stale.lease, null);
  assert.equal(rowById(freshId).status, "sending");
  // Idempotent.
  assert.equal(outbox.recoverStaleSending(), 0);
});

test("resolveUncertain requeues, records manual sends and cancels", () => {
  resetOutbox();
  setSettings({ sendWindowStart: "00:00", sendWindowEnd: "23:59" });
  const resolver = insertUser("u-resolver");
  const convId = insertConversation(PHONE_CONV_A);

  outbox.enqueueOutbox({ dedupeKey: "t12:r", phone: PHONE_CONV_A, purpose: "notify_confirmed", body: "Commande confirmee", conversationId: convId });
  const idR = rowByKey("t12:r").id;
  db.prepare("UPDATE wa_outbox SET status = 'uncertain', last_error = 'timeout' WHERE id = ?").run(idR);

  assert.equal(outbox.resolveUncertain(idR, resolver, "not_sent_requeue"), true);
  let row = rowById(idR);
  assert.equal(row.status, "queued");
  assert.equal(row.resolved_by, resolver);
  assert.ok(row.resolved_at);
  assert.equal(row.lease, null);

  const claimed = outbox.claimNextOutbox();
  assert.ok(claimed && claimed.id === idR);
  outbox.markOutboxSent(claimed.id, claimed.lease, "wamid-manual-1");
  row = rowById(idR);
  assert.equal(row.status, "sent");
  assert.equal(row.wa_message_id, "wamid-manual-1");
  assert.ok(row.sent_at);
  assert.equal(row.lease, null);

  const msg = db.prepare("SELECT * FROM wa_messages WHERE outbox_id = ?").get(idR);
  assert.ok(msg);
  assert.equal(msg.direction, "out");
  assert.equal(msg.author, "system");
  assert.equal(msg.wa_message_id, "wamid-manual-1");
  const conv = db.prepare("SELECT * FROM wa_conversations WHERE id = ?").get(convId);
  assert.ok(conv.last_outbound_at);

  // Only uncertain rows can be resolved.
  assert.equal(outbox.resolveUncertain(idR, resolver, "cancel"), false);

  outbox.enqueueOutbox({ dedupeKey: "t12:c", phone: PHONE_CONV_A, purpose: "ai_reply", body: "rep", conversationId: convId });
  const idC = rowByKey("t12:c").id;
  db.prepare("UPDATE wa_outbox SET status = 'uncertain' WHERE id = ?").run(idC);
  assert.equal(outbox.resolveUncertain(idC, resolver, "cancel"), true);
  const cancelled = rowById(idC);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.resolved_by, resolver);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wa_messages WHERE outbox_id = ?").get(idC).n, 0);
});

test("markOutboxSent records authors by purpose and never duplicates a wa_messages row", () => {
  resetOutbox();
  const convId = insertConversation(PHONE_CONV_B);
  insertUser("u-agent-2");
  outbox.enqueueOutbox({ dedupeKey: "t13:agent", phone: PHONE_CONV_B, purpose: "agent_reply", body: "Je regarde cela", conversationId: convId, authorUserId: "u-agent-2" });
  outbox.enqueueOutbox({ dedupeKey: "t13:ai", phone: PHONE_CONV_B, purpose: "ai_reply", body: "Bonjour, comment puis-je aider ?", conversationId: convId });
  outbox.enqueueOutbox({
    dedupeKey: "t13:card",
    phone: PHONE_CONV_B,
    purpose: "product_card",
    kind: "image",
    body: "Robe bleue",
    mediaRef: "https://cdn.example.test/robe.webp",
    conversationId: convId,
    respectWindow: false,
    countsTowardCap: false,
  });

  // A wa_messages row with this outbox id already exists: no duplicate may be inserted.
  const cardId = rowByKey("t13:card").id;
  db.prepare("INSERT INTO wa_messages (id, conversation_id, direction, author, kind, body, outbox_id, created_at) VALUES (?, ?, 'out', 'ai', 'image', 'Robe bleue', ?, ?)")
    .run("wm-pre-existing", convId, cardId, new Date().toISOString());

  let tick = 0;
  for (const key of ["t13:agent", "t13:ai", "t13:card"]) {
    tick += 1;
    const claimed = outbox.claimNextOutbox(new Date(Date.now() + tick * 60_000));
    assert.ok(claimed, key);
    outbox.markOutboxSent(claimed.id, claimed.lease, `wamid-${key}`);
  }

  const messages = db.prepare("SELECT * FROM wa_messages WHERE conversation_id = ?").all(convId);
  assert.equal(messages.length, 3);
  const agentMsg = messages.find((m) => m.outbox_id === rowByKey("t13:agent").id);
  assert.equal(agentMsg.author, "agent");
  assert.equal(agentMsg.author_user_id, "u-agent-2");
  assert.equal(agentMsg.kind, "text");
  const aiMsg = messages.find((m) => m.outbox_id === rowByKey("t13:ai").id);
  assert.equal(aiMsg.author, "ai");
  const cardMsgs = messages.filter((m) => m.outbox_id === cardId);
  assert.equal(cardMsgs.length, 1);
  assert.equal(cardMsgs[0].id, "wm-pre-existing");

  const conv = db.prepare("SELECT * FROM wa_conversations WHERE id = ?").get(convId);
  assert.ok(conv.last_outbound_at);
  assert.ok(conv.last_agent_reply_at);
});

test("cancelQueuedForOrder cancels queued rows of an order, optionally by purpose", () => {
  resetOutbox();
  insertOrder("ord-t14", PHONE_ORDER);
  const due = new Date().toISOString();
  for (const [key, purpose] of [["t14:1", "notify_confirmed"], ["t14:2", "notify_shipped"], ["t14:3", "ai_reply"]]) {
    assert.equal(outbox.enqueueOutbox({ dedupeKey: key, phone: PHONE_ORDER, purpose, body: "x", orderId: "ord-t14", availableAt: due }), true, key);
  }
  db.prepare("UPDATE wa_outbox SET status = 'sent' WHERE dedupe_key = 't14:2'").run();

  assert.equal(outbox.cancelQueuedForOrder("ord-t14"), 2);
  assert.equal(rowByKey("t14:1").status, "cancelled");
  assert.equal(rowByKey("t14:3").status, "cancelled");
  assert.equal(rowByKey("t14:2").status, "sent");

  assert.equal(outbox.enqueueOutbox({ dedupeKey: "t14:4", phone: PHONE_ORDER, purpose: "notify_confirmed", body: "x", orderId: "ord-t14", availableAt: due }), true);
  assert.equal(outbox.enqueueOutbox({ dedupeKey: "t14:5", phone: PHONE_ORDER, purpose: "ai_reply", body: "x", orderId: "ord-t14", availableAt: due }), true);
  assert.equal(outbox.cancelQueuedForOrder("ord-t14", ["notify_confirmed"]), 1);
  assert.equal(rowByKey("t14:4").status, "cancelled");
  assert.equal(rowByKey("t14:5").status, "queued");
});

test("purgeOutbox removes terminal rows older than 30 days", () => {
  resetOutbox();
  const seed = (key, status, updatedAt) => {
    db.prepare(
      "INSERT INTO wa_outbox (id, dedupe_key, phone, purpose, body, status, available_at, created_at, updated_at) VALUES (?, ?, ?, 'notify_confirmed', 'x', ?, ?, ?, ?)",
    ).run(`id-${key}`, key, PHONE_A, status, updatedAt, updatedAt, updatedAt);
  };
  const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
  const recent = new Date().toISOString();
  seed("t15:sent-old", "sent", old);
  seed("t15:failed-old", "failed", old);
  seed("t15:cancelled-old", "cancelled", old);
  seed("t15:sent-recent", "sent", recent);
  seed("t15:queued-old", "queued", old);
  seed("t15:uncertain-old", "uncertain", old);

  assert.equal(outbox.purgeOutbox(), 3);
  assert.equal(rowByKey("t15:sent-old"), undefined);
  assert.equal(rowByKey("t15:failed-old"), undefined);
  assert.equal(rowByKey("t15:cancelled-old"), undefined);
  assert.ok(rowByKey("t15:sent-recent"));
  assert.ok(rowByKey("t15:queued-old"));
  assert.ok(rowByKey("t15:uncertain-old"));
});

test("outboxStats summarises the queue against the daily cap", () => {
  resetOutbox();
  setSettings({ sendWindowStart: "09:00", sendWindowEnd: "21:00", dailyOutboundCap: 40 });
  const now = new Date();
  const today = pacing.casablancaParts(now).date;
  const [y, m, d] = today.split("-").map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  const sentToday = atDay(today, "12:00").toISOString();
  const sentYesterday = atDay(yesterday, "12:00").toISOString();
  const seed = (key, { status, counts = 1, sentAt = null, updatedAt = null }) => {
    const createdAt = updatedAt ?? new Date().toISOString();
    db.prepare(
      "INSERT INTO wa_outbox (id, dedupe_key, phone, purpose, body, status, counts_toward_cap, available_at, created_at, updated_at, sent_at) VALUES (?, ?, ?, ?, 'x', ?, ?, ?, ?, ?, ?)",
    ).run(
      `id-${key}`,
      key,
      PHONE_A,
      counts === 1 ? "notify_confirmed" : "ai_reply",
      status,
      counts,
      createdAt,
      createdAt,
      updatedAt ?? createdAt,
      sentAt,
    );
  };
  seed("t16:q1", { status: "queued" });
  seed("t16:q2", { status: "queued" });
  seed("t16:u1", { status: "uncertain" });
  seed("t16:f1", { status: "failed", updatedAt: new Date(now.getTime() - 3_600_000).toISOString() });
  for (const key of ["t16:s1", "t16:s2", "t16:s3"]) seed(key, { status: "sent", sentAt: sentToday });
  for (const key of ["t16:a1", "t16:a2", "t16:a3", "t16:a4", "t16:a5"]) seed(key, { status: "sent", counts: 0, sentAt: sentToday });
  seed("t16:y1", { status: "sent", sentAt: sentYesterday });
  seed("t16:y2", { status: "sent", sentAt: sentYesterday });

  assert.deepEqual(outbox.outboxStats(now), { queued: 2, uncertain: 1, failed24h: 1, sentToday: 3, capRemaining: 37 });

  // capRemaining never goes negative.
  setSettings({ dailyOutboundCap: 2 });
  assert.equal(outbox.outboxStats(now).capRemaining, 0);
});

test("enqueueOutbox stays inert when WhatsApp env is not configured", () => {
  resetOutbox();
  setSettings({ enabled: true, notificationsEnabled: true });
  const saved = process.env.EVOLUTION_API_KEY;
  delete process.env.EVOLUTION_API_KEY;
  try {
    assert.equal(outbox.enqueueOutbox({ dedupeKey: "t17:notify", phone: PHONE_A, purpose: "notify_confirmed", body: "Bonjour" }), false);
    assert.equal(outbox.enqueueOutbox({ dedupeKey: "t17:admin", phone: PHONE_ADMIN, purpose: "admin_alert", body: "Alerte" }), false);
    assert.equal(outboxCount(), 0);
  } finally {
    process.env.EVOLUTION_API_KEY = saved;
  }
  assert.equal(outbox.enqueueOutbox({ dedupeKey: "t17:notify", phone: PHONE_A, purpose: "notify_confirmed", body: "Bonjour" }), true);
});

test("enqueueOutbox rejects empty and oversized bodies without throwing", () => {
  resetOutbox();
  setSettings({ enabled: true, notificationsEnabled: true });
  assert.equal(outbox.enqueueOutbox({ dedupeKey: "t18:empty", phone: PHONE_A, purpose: "ai_reply", body: "   " }), false);
  assert.equal(outbox.enqueueOutbox({ dedupeKey: "t18:long", phone: PHONE_A, purpose: "ai_reply", body: "x".repeat(4097) }), false);
  assert.equal(outbox.enqueueOutbox({ dedupeKey: "t18:max", phone: PHONE_A, purpose: "ai_reply", body: "x".repeat(4096) }), true);
  assert.equal(outboxCount(), 1);
});

test("claimNextOutbox cancels queued rows past their max age instead of sending them", () => {
  resetOutbox();
  setSettings({ enabled: true, notificationsEnabled: true, sendWindowStart: "00:00", sendWindowEnd: "23:59" });
  const old = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const seed = (key, purpose, createdAt, extra = {}) =>
    db.prepare(
      "INSERT INTO wa_outbox (id, dedupe_key, phone, purpose, body, status, counts_toward_cap, available_at, created_at, updated_at, resolved_at) VALUES (?, ?, ?, ?, 'x', 'queued', 0, ?, ?, ?, ?)",
    ).run(`id-${key}`, key, PHONE_A, purpose, createdAt, createdAt, createdAt, extra.resolvedAt ?? null);
  seed("t19:notify-old", "notify_shipped", old(49));
  seed("t19:relance-old", "relance_no_answer", old(72));
  seed("t19:admin-old", "admin_alert", old(25));
  seed("t19:ai-old", "ai_reply", old(2));
  seed("t19:notify-fresh", "notify_shipped", old(20));
  seed("t19:ai-fresh", "ai_reply", old(0.5));
  seed("t19:requeued", "notify_confirmed", old(100), { resolvedAt: old(1) });

  const claimed = outbox.claimNextOutbox();
  assert.ok(claimed);
  for (const key of ["t19:notify-old", "t19:relance-old", "t19:admin-old", "t19:ai-old"]) {
    const row = rowByKey(key);
    assert.equal(row.status, "cancelled", key);
    assert.match(row.last_error, /expiré/);
  }
  for (const key of ["t19:notify-fresh", "t19:ai-fresh", "t19:requeued"]) {
    assert.notEqual(rowByKey(key).status, "cancelled", key);
  }
});

test("an invalid persisted send window falls back to 09:00-21:00 instead of always open", () => {
  resetOutbox();
  setSettings({ enabled: true, notificationsEnabled: true });
  appState.setAppState(
    settingsService.WHATSAPP_SETTINGS_KEY,
    JSON.stringify({ ...settingsService.getWhatsAppSettings(), sendWindowStart: "21:00", sendWindowEnd: "09:00" }),
  );
  const stored = settingsService.getWhatsAppSettings();
  assert.equal(stored.sendWindowStart, "09:00");
  assert.equal(stored.sendWindowEnd, "21:00");

  outbox.enqueueOutbox({ dedupeKey: "t20:n", phone: PHONE_A, purpose: "notify_confirmed", body: "x" });
  const midnight = atDay(DAY, "03:00");
  db.prepare("UPDATE wa_outbox SET available_at = ?").run(dueAt(midnight));
  assert.equal(outbox.claimNextOutbox(midnight), null);
  assert.equal(casablancaStamp(new Date(rowByKey("t20:n").available_at)), `${DAY} 09:00`);
  setSettings({ sendWindowStart: "09:00", sendWindowEnd: "21:00" });
});

test("outbox error text is redacted and truncated", () => {
  resetOutbox();
  setSettings({ enabled: true, sendWindowStart: "00:00", sendWindowEnd: "23:59" });
  const failWith = (key, text, mark) => {
    outbox.enqueueOutbox({ dedupeKey: key, phone: PHONE_A, purpose: "ai_reply", body: "x" });
    db.prepare("DELETE FROM app_state WHERE key = 'wa_next_send_at'").run();
    const claimed = outbox.claimNextOutbox();
    assert.ok(claimed && rowById(claimed.id).dedupe_key === key);
    mark(claimed.id, claimed.lease, text);
    return rowById(claimed.id);
  };
  const failed = failWith(
    "t21:f",
    "number 212600000010@s.whatsapp.net / +212 600 000 010 apikey evolution-ephemeral-key https://x.test/api?token=abc123",
    outbox.markOutboxFailed,
  );
  assert.ok(!failed.last_error.includes("212600000010"));
  assert.ok(!failed.last_error.includes("600 000 010"));
  assert.ok(!failed.last_error.includes("evolution-ephemeral-key"));
  assert.ok(!failed.last_error.includes("abc123"));

  const uncertain = failWith("t21:u", "e".repeat(2000), outbox.markOutboxUncertain);
  assert.equal(uncertain.status, "uncertain");
  assert.equal(uncertain.last_error.length, 500);

  const retried = failWith("t21:r", "refus +212600000010", outbox.markOutboxRetry);
  assert.ok(!retried.last_error.includes("600000010"));
});
