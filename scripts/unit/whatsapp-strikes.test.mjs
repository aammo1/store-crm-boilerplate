import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "../test-source.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-strikes-"));
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
const strikes = loadSource("@/lib/services/whatsapp-strikes");
const customers = loadSource("@/lib/services/customers");
const settings = loadSource("@/lib/services/whatsapp-settings");
const db = getDb();

const DAY = 24 * 60 * 60 * 1000;
const t0 = new Date("2026-01-15T10:00:00.000Z");
const at = (ms) => new Date(t0.getTime() + ms);

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("autoBlock ON: 1 pt warns, 2 pts final warning, 3 pts blocks as system", () => {
  settings.updateWhatsAppSettings({ autoBlockEnabled: true });
  const phone = "0610000001";

  assert.deepEqual(strikes.addStrike({ phone, reason: "manipulation", detail: "trol", now: t0 }), {
    action: "warn",
    level: 1,
    points: 1,
  });
  assert.deepEqual(strikes.addStrike({ phone, reason: "spam_burst", now: at(1000) }), {
    action: "warn",
    level: 2,
    points: 2,
  });
  assert.deepEqual(strikes.addStrike({ phone, reason: "repeated_cancel", now: at(2000) }), {
    action: "blocked",
    points: 3,
  });

  const row = db.prepare("SELECT phone, reason, source, created_by FROM blocked_phones WHERE phone = ?").get("+212610000001");
  assert.equal(row.source, "system");
  assert.equal(row.created_by, null);
  assert.equal(row.reason, "Auto : annulations répétées (3 pts)");
  assert.equal(customers.isPhoneBlocked(phone), true);
  assert.equal(customers.getBlockedPhone(phone).source, "system");
  assert.equal(customers.getBlockedPhone(phone).createdBy, null);
  assert.ok(customers.listBlockedPhones().some((b) => b.phone === "+212610000001" && b.source === "system"));
});

test("strikes on an already blocked phone still record history and return already_blocked", () => {
  const phone = "0610000001";
  const decision = strikes.addStrike({ phone, reason: "insult", now: at(3000) });
  assert.deepEqual(decision, { action: "already_blocked", points: 5 });
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM wa_strikes WHERE phone = ?").get("+212610000001").c, 4);
});

test("autoBlock OFF: threshold flags needs_human and never blocks; severe too", () => {
  settings.updateWhatsAppSettings({ autoBlockEnabled: false });
  const phone = "0610000002";
  assert.deepEqual(strikes.addStrike({ phone, reason: "ref_guessing", now: t0 }), {
    action: "warn",
    level: 1,
    points: 1,
  });
  assert.deepEqual(strikes.addStrike({ phone, reason: "manipulation", now: at(1000) }), {
    action: "warn",
    level: 2,
    points: 2,
  });
  assert.deepEqual(strikes.addStrike({ phone, reason: "spam_burst", now: at(2000) }), {
    action: "needs_human",
    points: 3,
  });
  assert.equal(customers.isPhoneBlocked(phone), false);

  // Severe reaches the threshold but respects the OFF toggle.
  assert.deepEqual(strikes.addStrike({ phone: "0610000003", reason: "severe", now: t0 }), {
    action: "needs_human",
    points: 3,
  });
  assert.equal(customers.isPhoneBlocked("0610000003"), false);
});

test("severe blocks immediately when autoBlock is ON", () => {
  settings.updateWhatsAppSettings({ autoBlockEnabled: true });
  const phone = "0610000004";
  assert.deepEqual(strikes.addStrike({ phone, reason: "severe", detail: "classifier: severe", now: t0 }), {
    action: "blocked",
    points: 3,
  });
  assert.equal(customers.getBlockedPhone(phone).reason, "Auto : menaces / contenu grave (3 pts)");
  assert.equal(customers.getBlockedPhone(phone).source, "system");
});

test("duplicate order+reason gives none and does not double count", () => {
  settings.updateWhatsAppSettings({ autoBlockEnabled: false });
  const phone = "0610000005";
  assert.deepEqual(
    strikes.addStrike({ phone, reason: "repeated_cancel", orderId: "ORD-DUP-1", now: t0 }),
    { action: "warn", level: 1, points: 1 },
  );
  assert.deepEqual(
    strikes.addStrike({ phone, reason: "repeated_cancel", orderId: "ORD-DUP-1", now: at(1000) }),
    { action: "none", points: 1 },
  );
  assert.equal(strikes.activePoints(phone, at(1500)), 1);

  // Same order, different reason still counts.
  assert.deepEqual(
    strikes.addStrike({ phone, reason: "ref_guessing", orderId: "ORD-DUP-1", now: at(2000) }),
    { action: "warn", level: 2, points: 2 },
  );

  // Without an order id there is no dedupe.
  const phone2 = "0610000010";
  assert.deepEqual(strikes.addStrike({ phone: phone2, reason: "manipulation", now: t0 }), {
    action: "warn",
    level: 1,
    points: 1,
  });
  assert.deepEqual(strikes.addStrike({ phone: phone2, reason: "manipulation", now: at(1000) }), {
    action: "warn",
    level: 2,
    points: 2,
  });
});

test("points expire after 90 days", () => {
  const phone = "0610000006";
  strikes.addStrike({ phone, reason: "manipulation", now: t0 });
  strikes.addStrike({ phone, reason: "ref_guessing", now: at(89 * DAY) });
  assert.equal(strikes.activePoints(phone, at(89 * DAY)), 2);

  const after = at(90 * DAY + 60_000);
  // The first strike expired exactly at 90 days; only ref_guessing remains.
  assert.equal(strikes.activePoints(phone, after), 1);
  assert.deepEqual(strikes.addStrike({ phone, reason: "spam_burst", now: after }), {
    action: "warn",
    level: 2,
    points: 2,
  });
  const remaining = strikes.listStrikes(phone, after);
  assert.equal(remaining.length, 2);
  assert.ok(!remaining.some((s) => s.reason === "manipulation"));
  assert.equal(strikes.activePoints(phone, at(271 * DAY)), 0);
});

test("listStrikes shape, detail truncation, clearStrikes", () => {
  const phone = "0610000007";
  strikes.addStrike({ phone, reason: "insult", detail: "x".repeat(301), now: t0 });
  const rows = strikes.listStrikes(phone, t0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, "insult");
  assert.equal(rows[0].points, 2);
  assert.equal(rows[0].detail.length, 300);
  assert.ok(rows[0].id);
  assert.ok(rows[0].createdAt);
  assert.equal(rows[0].expiresAt, new Date(t0.getTime() + 90 * DAY).toISOString());

  assert.equal(strikes.clearStrikes(phone), 1);
  assert.equal(strikes.activePoints(phone, at(1000)), 0);
  assert.equal(strikes.listStrikes(phone, at(1000)).length, 0);
  assert.equal(strikes.clearStrikes(phone), 0);
});

test("invalid input throws and unchanged activePoints for unknown phone", () => {
  assert.throws(() => strikes.addStrike({ phone: "123", reason: "insult" }), /invalide/);
  assert.throws(() => strikes.addStrike({ phone: "0610000008", reason: "nope" }), /inconnu/);
  assert.equal(strikes.activePoints("0610000009"), 0);
});
