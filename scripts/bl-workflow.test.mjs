import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { loadSource } from "./test-source.mjs";

const childAction = process.env.CRM_BL_TEST_ACTION;
const tempDir = childAction ? null : fs.mkdtempSync(path.join(os.tmpdir(), "crm-bl-workflow-"));
if (tempDir) process.env.DB_PATH = path.join(tempDir, "test.db");
if (tempDir) process.env.UPLOAD_DIR = path.join(tempDir, "uploads");
process.env.DELIVERY_PROVIDER = "mock";
process.env.OZON_CLIENT_ID = "";
process.env.OZON_API_KEY = "";
globalThis.fetch = async () => { throw new Error("HTTP disabled in isolated fulfillment tests"); };
const { getDb } = loadSource("@/lib/db");
import { createOrder } from "./fulfillment-fixtures.mjs";
const { confirmOrder } = loadSource("@/lib/services/confirmation");
const { openStock } = loadSource("@/lib/services/inventory");
const { createOrResumeBl, resumeBlOperation, reconcileBlOperation, BlError } = loadSource("@/lib/services/delivery-notes");
const { getShipmentBoard, handoffParcel, handoffBl } = loadSource("@/lib/services/expeditions");
const db = getDb();
const actor = { id: "test-agent" };
const evidence = "Portail Ozon vérifié : résultat et codes de suivi confirmés avec le support.";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

if (childAction) {
  const provider = {
    async createDeliveryNote() {
      const ref = `BLCHILD-${process.pid}`;
      db.prepare("INSERT INTO test_courier_calls(kind, ref) VALUES ('create', ?)").run(ref);
      if (childAction === "crash") process.exit(0); // External success, no local acknowledgement.
      await pause(150);
      return { ref };
    },
    async addParcelsToDeliveryNote(ref, codes) {
      db.prepare("INSERT INTO test_courier_calls(kind, ref, codes) VALUES ('attach', ?, ?)").run(ref, JSON.stringify(codes));
      await pause(100);
    },
    async saveDeliveryNote(ref) {
      db.prepare("INSERT INTO test_courier_calls(kind, ref) VALUES ('save', ?)").run(ref);
      await pause(100);
    },
  };
  process.once("message", async () => {
    try {
      const data = JSON.parse(process.env.CRM_BL_TEST_INPUT);
      const result = childAction === "resume" ? await resumeBlOperation(data.id, actor, provider)
        : childAction === "reconcile" ? reconcileBlOperation(data.id, data.input, actor)
        : await createOrResumeBl(data.ids, actor, provider);
      process.send({ ok: true, result });
    } catch (error) { process.send({ ok: false, status: error.status, message: error.message }); }
    finally { db.close(); process.disconnect(); }
  });
  process.send({ ready: true });
} else {
  after(() => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO products (id, slug, name, category, price, created_at, updated_at)
    VALUES ('test-product', 'test-product', 'Sérum test', 'soins', 300, ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO variants (id, product_id, sku, label, options_json, options_key)
    VALUES ('test-main', 'test-product', 'TEST-500', '500 ml', '[{"name":"Contenance","value":"500 ml"}]', '[["contenance","500 ml"]]')`).run();
  openStock("test-main", 1000, actor.id);
  db.prepare("INSERT INTO cities (id, name, updated_at, provider) VALUES (1, 'Casablanca', ?, 'mock')").run(now);
  db.exec("CREATE TABLE test_courier_calls (kind TEXT, ref TEXT, codes TEXT)");
  let parcelSeq = 0;
  let refSeq = 0;
  function parcel() {
    const id = `order-${++parcelSeq}`;
    createOrder({ id, customerName: "Cliente test", customerPhone: "+212612345678",
      items: [{ product_id: "test-product", variant_id: "test-main", sku: "TEST-500", name: "Sérum test", variant_label: "500 ml", options: [{ name: "Contenance", value: "500 ml" }], quantity: 1, unit_price: 300, line_total: 300 }],
      upsellOffer: null, subtotal: 300, shipping: 29, total: 329 });
    const result = confirmOrder(id, { lines: [{ lineIndex: 0, variantId: "test-main" }], address: "12 rue test", cityId: 1 }, actor);
    db.prepare("UPDATE courier_submissions SET status = 'submitted', tracking_number = ? WHERE id = ?").run(`TRACK-${parcelSeq}`, result.submissionId);
    return result.submissionId;
  }
  function fake(failStage = null) {
    const calls = [];
    const ref = `BLTEST-${++refSeq}`;
    const provider = {
      async createDeliveryNote() { calls.push({ stage: "create", ref }); if (failStage === "create") throw new Error("timeout /customers/client-id/api-key/create"); return { ref }; },
      async addParcelsToDeliveryNote(ref, codes) { calls.push({ stage: "attach", ref, codes }); if (failStage === "attach") throw new Error("timeout /customers/client-id/api-key/attach"); },
      async saveDeliveryNote(ref) { calls.push({ stage: "save", ref }); if (failStage === "save") throw new Error("timeout /customers/client-id/api-key/save"); },
    };
    return { calls, ref, provider };
  }
  const opFor = submissionId => db.prepare(`SELECT op.* FROM bl_operations op JOIN bl_operation_parcels p
    ON p.operation_id = op.id WHERE p.submission_id = ?`).get(submissionId);
  const op = id => db.prepare("SELECT * FROM bl_operations WHERE id = ?").get(id);
  const resolve = (id, outcome, extra = {}) => {
    const current = op(id);
    return reconcileBlOperation(id, { revision: current.revision, stage: current.stage, outcome, evidence, ...extra }, actor);
  };
  async function race(inputs, action = "create") {
    db.prepare("DELETE FROM test_courier_calls").run();
    const children = inputs.map(input => fork(fileURLToPath(import.meta.url), [], {
      env: { ...process.env, CRM_BL_TEST_ACTION: action, CRM_BL_TEST_INPUT: JSON.stringify(input) },
      execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"],
    }));
    try {
      const ready = children.map(child => new Promise((resolve, reject) => {
        child.on("error", reject);
        child.once("message", message => { assert.equal(message.ready, true); resolve(); });
        child.once("exit", () => reject(new Error("Child exited before readiness")));
      }));
      const results = children.map(child => new Promise((resolve, reject) => {
        let result = null;
        child.on("error", reject);
        child.on("message", message => { if (!message.ready) result = message; });
        child.once("exit", code => { if (code !== 0) reject(new Error(`Child exited ${code}`)); else resolve(result); });
      }));
      await Promise.all(ready);
      children.forEach(child => child.send("go"));
      return await Promise.all(results);
    } finally { for (const child of children) if (child.exitCode === null) child.kill(); }
  }

  test("successful selection is immutable, replay is a no-op, and saved BL handoff remains idempotent", async () => {
    const ids = [parcel(), parcel()];
    const p = fake();
    const result = await createOrResumeBl(ids, actor, p.provider);
    assert.equal(result.created, true);
    assert.equal(result.bl.status, "saved");
    assert.deepEqual(p.calls.map(c => c.stage), ["create", "attach", "save"]);
    const replay = await createOrResumeBl([...ids].reverse(), { id: "second-agent" }, p.provider);
    assert.equal(replay.bl.id, result.bl.id);
    assert.equal(replay.created, false);
    assert.equal(p.calls.length, 3);
    await assert.rejects(() => createOrResumeBl([ids[0]], actor, p.provider), { status: 409 });
    assert.ok(!getShipmentBoard().ready.some(p => ids.includes(p.submissionId)));
    assert.equal(handoffBl(result.bl.id, actor.id).results.every(r => r.ok), true);
    assert.equal(handoffParcel(ids[0], actor.id).alreadyDispatched, true);
  });

  test("ineligible parcels and changed tracking codes cannot start provider calls or bypass handoff guards", async () => {
    const id = parcel(); const p = fake();
    db.prepare("UPDATE courier_submissions SET status = 'queued' WHERE id = ?").run(id);
    assert.throws(() => handoffParcel(id, actor.id), { status: 409 });
    await assert.rejects(() => createOrResumeBl([id], actor, p.provider), { status: 409 });
    assert.equal(opFor(id), undefined);
    assert.equal(p.calls.length, 0);
    await assert.rejects(() => createOrResumeBl([], actor, p.provider), { status: 400 });
    await assert.rejects(() => createOrResumeBl(["missing"], actor, p.provider), { status: 404 });
    db.prepare("UPDATE courier_submissions SET status = 'submitted' WHERE id = ?").run(id);
    const failed = fake("save");
    await assert.rejects(() => createOrResumeBl([id], actor, failed.provider), BlError);
    const current = opFor(id);
    resolve(current.id, "not_applied");
    db.prepare("UPDATE courier_submissions SET tracking_number = 'CHANGED-TRACKING' WHERE id = ?").run(id);
    await assert.rejects(() => resumeBlOperation(current.id, actor, p.provider), { status: 409 });
    assert.equal(p.calls.length, 0);
    assert.equal(op(current.id).status, "ready");
  });

  test("saved board limits BLs rather than truncating their parcel selections", async () => {
    for (let index = 0; index < 2; index++) {
      const ids = Array.from({ length: 60 }, () => parcel());
      const result = await createOrResumeBl(ids, actor, fake().provider);
      assert.equal(getShipmentBoard().savedNotes.find(note => note.id === result.bl.id).parcels.length, 60);
    }
  });

  test("batch handoff also rejects an ineligible parcel without consuming its reservation", async () => {
    const ids = [parcel(), parcel()];
    const result = await createOrResumeBl(ids, actor, fake().provider);
    db.prepare("UPDATE courier_submissions SET status = 'needs_review' WHERE id = ?").run(ids[1]);
    const outcomes = handoffBl(result.bl.id, actor.id).results;
    assert.equal(outcomes.find(r => r.submissionId === ids[0]).ok, true);
    assert.equal(outcomes.find(r => r.submissionId === ids[1]).ok, false);
    assert.equal(db.prepare(`SELECT r.status FROM reservations r JOIN courier_submissions cs ON cs.order_id = r.order_id
      WHERE cs.id = ?`).get(ids[1]).status, "active");
    assert.throws(() => handoffParcel(ids[1], actor.id), { status: 409 });
  });

  test("timeout at every stage keeps claims, blocks blind retries and handoff, and resumes only verified missing work", async () => {
    for (const stage of ["create", "attach", "save"]) {
      const id = parcel();
      const p = fake(stage);
      await assert.rejects(() => createOrResumeBl([id], actor, p.provider), { status: 502, stage });
      const current = opFor(id);
      assert.equal(current.status, "needs_review");
      assert.equal(current.stage, stage);
      assert.ok(!current.last_error.includes("api-key"));
      assert.ok(getShipmentBoard().operations.find(o => o.id === current.id)?.canResolve);
      assert.ok(!getShipmentBoard().ready.some(p => p.submissionId === id));
      assert.throws(() => handoffParcel(id, actor.id), { status: 409 });
      const before = p.calls.length;
      await assert.rejects(() => createOrResumeBl([id], { id: "other-agent" }, p.provider), { status: 409 });
      await assert.rejects(() => resumeBlOperation(current.id, actor, p.provider), { status: 409 });
      assert.equal(p.calls.length, before);
      resolve(current.id, "applied", stage === "create" ? { ref: p.ref } : {});
      const continuation = fake();
      const finished = await resumeBlOperation(current.id, { id: "other-agent" }, continuation.provider);
      assert.equal(finished.bl.ref, p.ref);
      assert.deepEqual(continuation.calls.map(c => c.stage), stage === "create" ? ["attach", "save"] : stage === "attach" ? ["save"] : []);
      assert.equal(op(current.id).status, "completed");
      assert.equal(db.prepare("SELECT COUNT(*) n FROM bl_operation_events WHERE operation_id = ? AND kind = 'reconciled'").get(current.id).n, 1);
    }
  });

  test("verified negative outcomes retry just that stage; attachment can be recovered per parcel", async () => {
    for (const stage of ["create", "attach", "save"]) {
      const id = parcel(); const failed = fake(stage);
      await assert.rejects(() => createOrResumeBl([id], actor, failed.provider), BlError);
      const current = opFor(id);
      resolve(current.id, "not_applied");
      const retry = fake();
      const result = await resumeBlOperation(current.id, actor, retry.provider);
      assert.deepEqual(retry.calls.map(c => c.stage), stage === "create" ? ["create", "attach", "save"] : stage === "attach" ? ["attach", "save"] : ["save"]);
      assert.equal(result.bl.ref, stage === "create" ? retry.ref : failed.ref);
    }
    const ids = [parcel(), parcel(), parcel()]; const failed = fake("attach");
    await assert.rejects(() => createOrResumeBl(ids, actor, failed.provider), BlError);
    const current = opFor(ids[0]);
    resolve(current.id, "partial", { attachedSubmissionIds: [ids[1]] });
    const retry = fake();
    await resumeBlOperation(current.id, actor, retry.provider);
    const tracking = ids.filter(id => id !== ids[1]).map(id => db.prepare("SELECT tracking_number FROM courier_submissions WHERE id = ?").get(id).tracking_number);
    assert.deepEqual(retry.calls[0].codes.sort(), tracking.sort());
    assert.equal(db.prepare("SELECT COUNT(*) n FROM delivery_note_parcels WHERE delivery_note_id = ?").get(op(current.id).delivery_note_id).n, 3);
  });

  test("local persistence failure after external success is uncertain at create, attach, and save", async () => {
    for (const stage of ["create", "attach", "save"]) {
      const id = parcel(); const p = fake();
      const table = stage === "create" ? "delivery_notes" : stage === "attach" ? "delivery_note_parcels" : "delivery_notes";
      db.exec(`CREATE TEMP TRIGGER fail_bl BEFORE ${stage === "save" ? "UPDATE" : "INSERT"} ON ${table}
        BEGIN SELECT RAISE(ABORT, 'forced local persistence failure'); END`);
      try {
        await assert.rejects(() => createOrResumeBl([id], actor, p.provider), { status: 502, stage });
        assert.equal(opFor(id).status, "needs_review");
        assert.equal(opFor(id).stage, stage);
        assert.equal(p.calls.filter(c => c.stage === stage).length, 1);
      } finally { db.exec("DROP TRIGGER fail_bl"); }
      resolve(opFor(id).id, "applied", stage === "create" ? { ref: p.ref } : {});
      const recovery = fake();
      await resumeBlOperation(opFor(id).id, actor, recovery.provider);
      assert.ok(!recovery.calls.some(c => c.stage === stage));
    }
  });

  test("duplicate provider reference stops after one external create; database enforces one attachment and claim per parcel/code", async () => {
    const p = fake(); const savedParcel = parcel(); const existing = await createOrResumeBl([savedParcel], actor, p.provider);
    const id = parcel();
    const duplicate = fake(); duplicate.provider.createDeliveryNote = async () => { duplicate.calls.push({ stage: "create" }); return { ref: existing.bl.ref }; };
    await assert.rejects(() => createOrResumeBl([id], actor, duplicate.provider), { status: 502 });
    assert.equal(duplicate.calls.length, 1);
    assert.equal(opFor(id).observed_ref, existing.bl.ref);
    assert.throws(() => resolve(opFor(id).id, "applied", { ref: existing.bl.ref }), { status: 409 });
    const other = parcel();
    db.prepare("UPDATE courier_submissions SET tracking_number = ? WHERE id = ?").run(db.prepare("SELECT tracking_number FROM courier_submissions WHERE id = ?").get(id).tracking_number, other);
    await assert.rejects(() => createOrResumeBl([other], actor, fake().provider), { status: 409 });
    assert.equal(opFor(other), undefined);
    db.prepare("INSERT INTO delivery_notes VALUES ('constraint-test', 'CONSTRAINT-TEST', 'draft', ?, ?, NULL)").run(actor.id, now);
    assert.throws(() => db.prepare("INSERT INTO delivery_note_parcels VALUES (?, ?, ?)").run("constraint-test", savedParcel, now), /UNIQUE/);
  });

  test("legacy orphan recovery explicitly fixes its selection instead of silently adopting another agent's draft", async () => {
    const id = parcel();
    db.prepare("INSERT INTO delivery_notes VALUES ('legacy-orphan', 'LEGACY-ORPHAN', 'draft', 'old-agent', ?, NULL)").run(now);
    db.prepare(`INSERT INTO bl_operations (id, delivery_note_id, status, stage, created_by, created_at, updated_at)
      VALUES ('legacy:legacy-orphan', 'legacy-orphan', 'needs_review', 'attach', 'old-agent', ?, ?)`).run(now, now);
    const before = fake();
    await assert.rejects(() => createOrResumeBl([id], actor, before.provider), { status: 409 });
    assert.equal(before.calls.length, 0);
    assert.throws(() => resolve("legacy:legacy-orphan", "not_applied"), { status: 400 });
    resolve("legacy:legacy-orphan", "not_applied", { submissionIds: [id] });
    assert.equal(opFor(id).id, "legacy:legacy-orphan");
    const p = fake();
    const result = await resumeBlOperation("legacy:legacy-orphan", actor, p.provider);
    assert.equal(result.bl.ref, "LEGACY-ORPHAN");
    assert.deepEqual(p.calls.map(c => c.stage), ["attach", "save"]);
  });

  test("only a verified unused legacy orphan can be closed, preserving history and permitting fresh selection", async () => {
    db.prepare("INSERT INTO delivery_notes VALUES ('legacy-unused', 'LEGACY-UNUSED', 'draft', 'old-agent', ?, NULL)").run(now);
    db.prepare(`INSERT INTO bl_operations (id, delivery_note_id, status, stage, created_by, created_at, updated_at)
      VALUES ('legacy:legacy-unused', 'legacy-unused', 'needs_review', 'attach', 'old-agent', ?, ?)`).run(now, now);
    const id = parcel(); const p = fake();
    await assert.rejects(() => createOrResumeBl([id], actor, p.provider), { status: 409 });
    const outcome = resolve("legacy:legacy-unused", "unused");
    assert.equal(outcome.status, "abandoned");
    assert.equal(db.prepare("SELECT status FROM delivery_notes WHERE id = 'legacy-unused'").get().status, "failed");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM bl_operation_events WHERE operation_id = 'legacy:legacy-unused'").get().n, 1);
    assert.ok(!getShipmentBoard().operations.some(op => op.id === "legacy:legacy-unused"));
    await assert.rejects(() => resumeBlOperation("legacy:legacy-unused", actor, p.provider), { status: 409 });
    await createOrResumeBl([id], actor, p.provider);
    const failedId = parcel();
    await assert.rejects(() => createOrResumeBl([failedId], actor, fake("create").provider), BlError);
    assert.throws(() => resolve(opFor(failedId).id, "unused"), { status: 400 });
    assert.equal(opFor(failedId).status, "needs_review");
  });

  test("two SQLite processes competing for identical or overlapping selections produce only one external BL", { timeout: 30000 }, async () => {
    for (const overlap of [false, true]) {
      const ids = [parcel(), parcel(), parcel()];
      const results = await race([{ ids: ids.slice(0, 2) }, { ids: overlap ? ids.slice(1) : ids.slice(0, 2).reverse() }]);
      assert.equal(results.filter(r => r.ok).length, 1);
      assert.equal(results.find(r => !r.ok).status, 409);
      assert.deepEqual(db.prepare("SELECT kind FROM test_courier_calls ORDER BY rowid").all().map(r => r.kind), ["create", "attach", "save"]);
      assert.equal(opFor(ids[1]).status, "completed");
    }
  });

  test("concurrent resume and concurrent reconciliation are fenced independently", { timeout: 30000 }, async () => {
    const id = parcel(); const failed = fake("save");
    await assert.rejects(() => createOrResumeBl([id], actor, failed.provider), BlError);
    const current = opFor(id);
    const input = { revision: current.revision, stage: "save", outcome: "not_applied", evidence };
    const resolved = await race([{ id: current.id, input }, { id: current.id, input }], "reconcile");
    assert.equal(resolved.filter(r => r.ok).length, 1);
    assert.equal(resolved.find(r => !r.ok).status, 409);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM test_courier_calls").get().n, 0);
    const resumed = await race([{ id: current.id }, { id: current.id }], "resume");
    assert.equal(resumed.filter(r => r.ok).length, 1);
    assert.deepEqual(db.prepare("SELECT kind FROM test_courier_calls").all().map(r => r.kind), ["save"]);
  });

  test("process death after external create survives restart and lease expiry never grants automatic replay", { timeout: 20000 }, async () => {
    const id = parcel();
    assert.deepEqual(await race([{ ids: [id] }], "crash"), [null]);
    const current = opFor(id);
    assert.equal(current.status, "running");
    assert.equal(current.stage, "create");
    assert.throws(() => resolve(current.id, "not_applied"), { status: 409 });
    db.prepare("UPDATE bl_operations SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(current.id);
    const p = fake();
    await assert.rejects(() => resumeBlOperation(current.id, actor, p.provider), { status: 409 });
    assert.equal(p.calls.length, 0);
    assert.equal(getShipmentBoard().operations.find(o => o.id === current.id).canResolve, true);
    const ref = db.prepare("SELECT ref FROM test_courier_calls WHERE kind = 'create'").get().ref;
    resolve(current.id, "applied", { ref });
    await resumeBlOperation(current.id, actor, p.provider);
    assert.deepEqual(p.calls.map(c => c.stage), ["attach", "save"]);
  });

  test("late original responses cannot overwrite reconciliation, and evidence is sanitized before JSON encoding", async () => {
    const id = parcel(); const p = fake();
    let release; p.provider.createDeliveryNote = () => new Promise(resolve => { release = resolve; });
    const original = createOrResumeBl([id], actor, p.provider);
    const rejection = assert.rejects(() => original, { status: 502 });
    const current = opFor(id);
    db.prepare("UPDATE bl_operations SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(current.id);
    resolve(current.id, "applied", { ref: p.ref, evidence: "Vérification /customers/client-id/api-key" });
    const before = op(current.id);
    release({ ref: "LATE-RESPONSE" });
    await rejection;
    assert.deepEqual(op(current.id), before);
    const history = getShipmentBoard().operations.find(o => o.id === current.id).resolutions;
    assert.ok(!history[0].evidence.includes("api-key"));
    const continuation = fake();
    await resumeBlOperation(current.id, actor, continuation.provider);
  });

  test("invalid/stale resolutions are rejected atomically without courier calls", async () => {
    const ids = [parcel(), parcel()]; const p = fake("attach");
    await assert.rejects(() => createOrResumeBl(ids, actor, p.provider), BlError);
    const current = opFor(ids[0]);
    for (const extra of [{ evidence: "short" }, { revision: 999 }, { stage: "save" },
      { attachedSubmissionIds: ["not-owned"] }, { attachedSubmissionIds: ids }]) {
      const before = op(current.id);
      assert.throws(() => resolve(current.id, "partial", extra), BlError);
      assert.deepEqual(op(current.id), before);
    }
  });

  test("migration preserves saved history, freezes legacy drafts/orphans, and refuses duplicate old attachments", () => {
    const migration = fs.readFileSync(new URL("../migrations/005_bl_operations.sql", import.meta.url), "utf8");
    for (const duplicate of [false, true]) {
      const legacy = new Database(":memory:");
      try {
        legacy.exec(fs.readFileSync(new URL("../migrations/001_init.sql", import.meta.url), "utf8"));
        legacy.exec(`INSERT INTO orders (id,customer_name,customer_phone,items_json,subtotal,shipping,total,created_at,updated_at)
          VALUES ('old-order','Test','+212612345678','[]',1,0,1,'now','now');
          INSERT INTO courier_submissions (id,order_id,status,next_retry_at,tracking_number,created_at,updated_at)
          VALUES ('old-parcel','old-order','submitted','now','OLD-TRACK','now','now');
          INSERT INTO delivery_notes VALUES ('old-saved','OLD-SAVED','saved','old-agent','now','now');
          INSERT INTO delivery_notes VALUES ('old-draft','OLD-DRAFT','draft','old-agent','now',NULL);
          INSERT INTO delivery_note_parcels VALUES ('old-saved','old-parcel','now');`);
        if (duplicate) {
          legacy.exec("INSERT INTO delivery_note_parcels VALUES ('old-draft','old-parcel','now')");
          assert.throws(() => legacy.transaction(() => legacy.exec(migration))(), /UNIQUE/);
          assert.equal(legacy.prepare("SELECT COUNT(*) n FROM delivery_note_parcels").get().n, 2);
        } else {
          legacy.exec(migration);
          assert.equal(legacy.prepare("SELECT status FROM bl_operations WHERE id = 'legacy:old-saved'").get().status, "completed");
          assert.equal(legacy.prepare("SELECT status FROM bl_operations WHERE id = 'legacy:old-draft'").get().status, "needs_review");
          assert.equal(legacy.prepare("SELECT operation_id FROM bl_operation_parcels WHERE submission_id = 'old-parcel'").get().operation_id, "legacy:old-saved");
        }
      } finally { legacy.close(); }
    }
  });

  test("recovery endpoints enforce authentication, validation, and French conflicts", async () => {
    const originalLoad = Module._load;
    let loggedIn = false;
    class GuardError extends Error { toResponse() { return Response.json({ error: "Non autorisé" }, { status: 401 }); } }
    Module._load = function (request, ...args) {
      if (request === "@/lib/auth-guards") return { AuthGuardError: GuardError, requireUser: async () => { if (!loggedIn) throw new GuardError(); return actor; } };
      return originalLoad.call(this, request, ...args);
    };
    try {
      const reconcileRoute = loadSource("@/app/api/crm/bl/operations/[id]/reconcile/route");
      const resumeRoute = loadSource("@/app/api/crm/bl/operations/[id]/resume/route");
      const params = { params: Promise.resolve({ id: "missing" }) };
      assert.equal((await resumeRoute.POST(new Request("http://localhost"), params)).status, 401);
      assert.equal((await reconcileRoute.POST(new Request("http://localhost", { method: "POST", body: "{}" }), params)).status, 401);
      loggedIn = true;
      assert.equal((await reconcileRoute.POST(new Request("http://localhost", { method: "POST", body: "{}" }), params)).status, 400);
      assert.equal((await resumeRoute.POST(new Request("http://localhost"), params)).status, 404);
      const id = parcel(); const failed = fake("create");
      await assert.rejects(() => createOrResumeBl([id], actor, failed.provider), BlError);
      const response = await resumeRoute.POST(new Request("http://localhost"), { params: Promise.resolve({ id: opFor(id).id }) });
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /incertain/);
    } finally { Module._load = originalLoad; }
  });
}
