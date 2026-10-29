import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "../test-source.mjs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-obs-"));
process.env.DB_PATH = path.join(tempDir, "test.db");
process.env.UPLOAD_DIR = path.join(tempDir, "uploads");
process.env.DELIVERY_PROVIDER = "mock";

const { getDb } = loadSource("@/lib/db");
const { formatLog, sanitizeLogValue } = loadSource("@/lib/log");
const { redactText } = loadSource("@/lib/shipping/redact");
const ws = loadSource("@/lib/services/worker-status");
const db = getDb();
after(() => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });

test("Bearer tokens and secret_key JSON values are redacted in free text and logs", () => {
  const line = formatLog(
    "error",
    "request failed",
    {
      detail: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature",
      body: '{"public_key":"pk_live_123","secret_key":"sk_live_456","token":"tok_secret"}',
      query: "https://app.sendit.ma/api/v1/deliveries?public_key=pk_query&secret_key=sk_query",
    },
    "json",
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(line.includes("eyJhbGciOi"), false);
  assert.equal(line.includes("pk_live_123"), false);
  assert.equal(line.includes("sk_live_456"), false);
  assert.equal(line.includes("tok_secret"), false);
  assert.equal(line.includes("pk_query"), false);
  assert.equal(line.includes("sk_query"), false);
  assert.match(line, /Bearer \*\*\*/);
  assert.match(JSON.parse(line).body, /"secret_key":\s*"\*\*\*"/);
  assert.match(line, /public_key=\*\*\*/);
  assert.match(line, /secret_key=\*\*\*/);

  const raw = 'Bearer test_token_xyz {"secret_key":"my_secret","public_key":"my_public"}';
  const scrubbed = redactText(raw);
  assert.equal(scrubbed.includes("test_token_xyz"), false);
  assert.equal(scrubbed.includes("my_secret"), false);
  assert.equal(scrubbed.includes("my_public"), false);
  assert.match(scrubbed, /Bearer \*\*\*/);
  assert.match(scrubbed, /"secret_key":\s*"\*\*\*"/);
  assert.match(scrubbed, /"public_key":\s*"\*\*\*"/);
});

test("json log is one line with denied keys and Ozon URLs redacted", () => {
  const line = formatLog("error", "x\nevil", {
    phone: "+212600000000", customerPhone: "0600", Authorization: "Bearer abc",
    nested: { token: "t", ok: 1 },
    url: "https://api.ozonexpress.ma/customers/123/SECRETKEY/track?token=zzz",
    error: new Error("boom https://h/customers/9/KEY/x"),
  }, "json", "2026-01-01T00:00:00.000Z");
  assert.equal(line.includes("\n"), false);
  const parsed = JSON.parse(line);
  assert.equal(parsed.level, "error");
  assert.equal(parsed.phone, "[redacted]");
  assert.equal(parsed.customerPhone, "[redacted]");
  assert.equal(parsed.Authorization, "[redacted]");
  assert.equal(parsed.nested.token, "[redacted]");
  assert.equal(parsed.nested.ok, 1);
  assert.doesNotMatch(line, /SECRETKEY|zzz|\/KEY\/|0600/);
  assert.match(parsed.error, /customers\/\*\*\*\/\*\*\*/);
});

test("pretty format is human readable", () => {
  const line = formatLog("info", "worker.tick", { worker: "tracking" }, "pretty", "T");
  assert.equal(line, "T INFO worker.tick worker=tracking");
  assert.equal(sanitizeLogValue({ password: "p" }).password, "[redacted]");
});

test("stale computation: 3 intervals, throttle floor, disabled never stale", () => {
  const now = Date.parse("2026-01-01T01:00:00Z");
  const ago = (ms) => new Date(now - ms).toISOString();
  const h = 60 * 60_000;
  assert.equal(ws.isWorkerStale(true, ago(3 * 30 * 60_000 + 1000), 30 * 60_000, now), true);
  assert.equal(ws.isWorkerStale(true, ago(3 * 30 * 60_000 - 1000), 30 * 60_000, now), false);
  assert.equal(ws.isWorkerStale(true, ago(40_000), 5000, now), false); // floor 45 s
  assert.equal(ws.isWorkerStale(true, ago(50_000), 5000, now), true);
  assert.equal(ws.isWorkerStale(false, ago(h), 5000, now), false);
  assert.equal(ws.isWorkerStale(true, null, 5000, now), false);
});

test("overall status degrades on stale or >=5 consecutive errors", () => {
  const ok = { enabled: true, stale: false, consecutiveErrors: 4 };
  assert.equal(ws.overallStatus([ok]), "ok");
  assert.equal(ws.overallStatus([{ ...ok, stale: true }]), "degraded");
  assert.equal(ws.overallStatus([{ ...ok, consecutiveErrors: 5 }]), "degraded");
  assert.equal(ws.overallStatus([{ enabled: false, stale: true, consecutiveErrors: 9 }]), "ok");
});

test("worker status: throttled ticks, redacted errors, tick resets errors", () => {
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  ws.recordWorkerTick("tracking", t0);
  ws.recordWorkerTick("tracking", t0 + 5000); // throttled
  assert.equal(ws.readWorkerStatus("tracking").lastTickAt, new Date(t0).toISOString());
  ws.recordWorkerTick("tracking", t0 + 16_000);
  assert.equal(ws.readWorkerStatus("tracking").lastTickAt, new Date(t0 + 16_000).toISOString());

  for (let i = 0; i < 5; i++) {
    ws.recordWorkerError("tracking", new Error("fail https://h/customers/1/KEY/x " + "y".repeat(400)), t0 + 17_000 + i);
  }
  const s = ws.readWorkerStatus("tracking");
  assert.equal(s.consecutiveErrors, 5);
  assert.ok(s.lastError.length <= 300);
  assert.doesNotMatch(s.lastError, /KEY/);
  assert.equal(db.prepare("SELECT 1 FROM app_state WHERE key = 'worker_status:tracking'").get() !== undefined, true);

  ws.recordWorkerTick("tracking", t0 + 60_000);
  assert.equal(ws.readWorkerStatus("tracking").consecutiveErrors, 0);
  assert.equal(ws.readWorkerStatus("meta").lastTickAt, null);
});
