import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "../test-source.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "city-tariffs-"));
process.env.DELIVERY_PROVIDER = "mock";
process.env.DB_PATH = path.join(dir, "crm.db");
process.env.AUTH_SECRET = "x".repeat(40);

const { getDb } = loadSource("@/lib/db");
const t = loadSource("@/lib/services/city-tariffs");
const db = getDb();
after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const now = new Date().toISOString();
db.prepare("INSERT INTO cities (id, name, updated_at, provider) VALUES (1, 'Casablanca', ?, 'mock'), (2, 'Laâyoune', ?, 'mock')").run(now, now);
db.prepare("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('admin', 'a@x.test', 'x', 'A', 'admin', ?)").run(now);

test("default courier cost round-trips and validates", () => {
  assert.equal(t.defaultCourierCost(), null);
  t.setDefaultCourierCost(30);
  assert.equal(t.defaultCourierCost(), 30);
  assert.throws(() => t.setDefaultCourierCost(-1), { status: 400 });
  assert.throws(() => t.setDefaultCourierCost(1.5), { status: 400 });
  t.setDefaultCourierCost(null);
  assert.equal(t.defaultCourierCost(), null);
  t.setDefaultCourierCost(30);
});

test("upsert, list, fallback to default cost, and clearing", () => {
  assert.equal(t.listCityTariffs().length, 2);
  assert.equal(t.courierCostFor(1), 30);
  const saved = t.upsertCityTariff({ cityId: 2, courierCost: 45, customerFeeOverride: 60, overrideIgnoresFreeThreshold: true }, "admin");
  assert.deepEqual([saved.courierCost, saved.customerFeeOverride, saved.overrideIgnoresFreeThreshold], [45, 60, true]);
  assert.equal(t.courierCostFor(2), 45);
  assert.equal(t.getCityTariff(1).courierCost, null);
  assert.equal(t.getCityTariff(999), null);
  // Ignore flag is dropped when there is no override.
  const noFee = t.upsertCityTariff({ cityId: 2, courierCost: 45, customerFeeOverride: null, overrideIgnoresFreeThreshold: true }, "admin");
  assert.equal(noFee.overrideIgnoresFreeThreshold, false);
  t.upsertCityTariff({ cityId: 2, courierCost: null, customerFeeOverride: null, overrideIgnoresFreeThreshold: false }, "admin");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM city_tariffs").get().n, 0);
});

test("validation rejects negatives, non-integers, unknown cities; bulk is atomic", () => {
  const base = { courierCost: 10, customerFeeOverride: null, overrideIgnoresFreeThreshold: false };
  assert.throws(() => t.upsertCityTariff({ ...base, cityId: 1, courierCost: -5 }, "admin"), { status: 400 });
  assert.throws(() => t.upsertCityTariff({ ...base, cityId: 1, customerFeeOverride: 2.5 }, "admin"), { status: 400 });
  assert.throws(() => t.upsertCityTariff({ ...base, cityId: 999 }, "admin"), { status: 404 });
  assert.throws(() => t.upsertCityTariffs([{ ...base, cityId: 1 }, { ...base, cityId: 999 }], "admin"), { status: 404 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM city_tariffs").get().n, 0);
  assert.equal(t.upsertCityTariffs([{ ...base, cityId: 1 }, { ...base, cityId: 2 }], "admin"), 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM city_tariffs").get().n, 2);
});
