import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadSource } from "../test-source.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-kpis-"));
process.env.DELIVERY_PROVIDER = "mock";
process.env.DB_PATH = path.join(dir, "crm.db");
process.env.AUTH_SECRET = "x".repeat(40);

const { getDb } = loadSource("@/lib/db");
const { getKpis, resolveKpiRange, kpiRangeBounds } = loadSource("@/lib/services/kpis");
const { upsertAdSpend } = loadSource("@/lib/services/ad-spend");
const { setDefaultCourierCost } = loadSource("@/lib/services/city-tariffs");
const db = getDb();
after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const now = new Date().toISOString();
const range = { from: "2026-10-10", to: "2026-10-12" };
// Edge instants derived from the service's own Casablanca day bounds (offset-agnostic).
const bounds = kpiRangeBounds(range.from, range.to);
const shift = (iso, min) => new Date(Date.parse(iso) + min * 60_000).toISOString();
const IN_FIRST = shift(bounds.start, 30);
const IN_LAST = shift(bounds.end, -30);
const BEFORE = shift(bounds.start, -30);
const AFTER = shift(bounds.end, 30);

db.prepare("INSERT INTO cities (id, name, updated_at, provider) VALUES (1,'Casablanca',?,'mock'),(2,'Fès',?,'mock'),(3,'Taza',?,'mock')").run(now, now, now);
db.prepare("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('ag1','a1@x.test','x','Salma','agent',?),('ag2','a2@x.test','x','Omar','agent',?)").run(now, now);
db.prepare("INSERT INTO city_tariffs (city_id, courier_cost, updated_at) VALUES (1, 30, ?)").run(now);
setDefaultCourierCost(20);
for (const [p, n] of [["p1", "Lampe"], ["p2", "Tapis"], ["p3", "Vase"]]) {
  db.prepare("INSERT INTO products (id, slug, name, category, price, created_at, updated_at) VALUES (?,?,?,?,100,?,?)").run(p, p, n, "x", now, now);
}
for (const [v, p, cost] of [["v1", "p1", 40], ["v2", "p2", 10], ["v3", "p3", null]]) {
  db.prepare("INSERT INTO variants (id, product_id, sku, cost_price) VALUES (?,?,?,?)").run(v, p, v.toUpperCase(), cost);
}

const item = (variant, product, name, qty, lineTotal) => ({
  product_id: product, variant_id: variant, sku: variant, name, variant_label: "", options: [],
  quantity: qty, unit_price: lineTotal / qty, line_total: lineTotal,
});
function order(id, o) {
  db.prepare(`INSERT INTO orders (id, customer_name, customer_phone, items_json, upsell_status, upsell_items_json,
      subtotal, shipping, total, currency, created_at, updated_at, confirmation_status, city_id, cod_status,
      assigned_to, delivery_outcome, utm_source, utm_campaign, archived_at)
    VALUES (?,?,?,?,?,?,?,?,?,'MAD',?,?,?,?,?,?,?,?,?,?)`).run(
    id, "Client", "+212612345678", JSON.stringify(o.items), o.upsell ? "accepted" : "closed",
    o.upsell ? JSON.stringify(o.upsell) : null, o.total, 0, o.total, o.at ?? IN_FIRST, o.at ?? IN_FIRST,
    o.status ?? "confirmed", o.city ?? 1, o.cod ?? "awaiting_payment", o.agent ?? null, o.outcome ?? null,
    o.source ?? null, o.campaign ?? null, o.archived ?? null);
}
function remit(id, orderId, paid, fee) {
  db.prepare("INSERT OR IGNORE INTO cod_remittances (id, reference, received_on, created_at) VALUES (?,?,?,?)").run(id, id, "2026-10-14", now);
  db.prepare("INSERT INTO cod_remittance_lines (remittance_id, order_id, expected_amount, paid_amount, fee_amount) VALUES (?,?,?,?,?)").run(id, orderId, paid, paid, fee);
}

order("A", { items: [item("v1", "p1", "Lampe", 2, 200)], total: 200, outcome: "delivered", city: 1, cod: "paid", agent: "ag1", source: "meta", campaign: "spring" });
order("B", { items: [item("v2", "p2", "Tapis", 1, 60)], upsell: [item("v1", "p1", "Lampe", 1, 40)], total: 100, outcome: "delivered", city: 2, agent: "ag1", source: "meta", campaign: "spring", at: IN_LAST });
order("C", { items: [item("v2", "p2", "Tapis", 1, 150)], total: 150, outcome: "refused", city: 1, agent: "ag2", source: "tiktok" });
order("D", { items: [item("v2", "p2", "Tapis", 1, 90)], total: 90, agent: "ag1" });
order("E", { items: [item("v2", "p2", "Tapis", 1, 60)], total: 60, status: "cancelled" });
order("F", { items: [item("v2", "p2", "Tapis", 1, 70)], total: 70, status: "new" });
order("G", { items: [item("v1", "p1", "Lampe", 1, 500)], total: 500, outcome: "delivered", archived: now });
order("H", { items: [item("v1", "p1", "Lampe", 1, 700)], total: 700, outcome: "delivered", at: BEFORE });
order("I", { items: [item("v1", "p1", "Lampe", 1, 800)], total: 800, outcome: "delivered", at: AFTER });
remit("R1", "A", 200, 25); // fee ignored: A has a tariff cost

upsertAdSpend({ day: "2026-10-10", channel: "meta", campaign: "spring", amount: 50 }, null);
upsertAdSpend({ day: "2026-10-11", channel: "meta", campaign: "", amount: 25 }, null);
upsertAdSpend({ day: "2026-10-12", channel: "tiktok", campaign: "ghost", amount: 15 }, null);
upsertAdSpend({ day: "2026-10-13", channel: "meta", campaign: "spring", amount: 999 }, null);
upsertAdSpend({ day: "2026-10-09", channel: "meta", campaign: "spring", amount: 999 }, null);

test("day bounds follow Africa/Casablanca midnight", () => {
  const b = kpiRangeBounds("2026-10-10", "2026-10-12");
  assert.equal(Date.parse(b.end) - Date.parse(b.start), 3 * 86_400_000);
  assert.ok(Math.abs(Date.parse(b.start) - Date.parse("2026-10-10T00:00:00Z")) <= 3_600_000);
  assert.throws(() => kpiRangeBounds("2026-10-12", "2026-10-10"), { name: "KpiRangeError" });
  assert.throws(() => kpiRangeBounds("2026-02-31", "2026-03-01"), { name: "KpiRangeError" });
  assert.deepEqual(resolveKpiRange({ range: "7d" }, new Date("2026-10-12T12:00:00Z")),
    { preset: "7d", from: "2026-10-06", to: "2026-10-12" });
  assert.equal(resolveKpiRange({ range: "custom", from: "bad", to: "x" }, new Date("2026-10-12T12:00:00Z")).preset, "today");
});

test("admin KPIs match the fixture exactly", () => {
  const k = getKpis({ ...range, role: "admin" });
  assert.deepEqual(k.counts, {
    orders: 6, stillNew: 1, confirmed: 4, cancelled: 1, delivered: 2, refused: 1, pendingOutcome: 1,
    confirmationRate: 80, deliveryRate: 66.7, refusalRate: 33.3,
  });
  assert.deepEqual(k.money, {
    revenueDelivered: 300, cashCollected: 200, outstanding: 100, courierFees: 25,
    cogs: 130, missingCostLines: 0, courierCost: 80, missingTariff: 0,
    adSpend: 90, margin: 90, netProfit: 0, cpaConfirmed: 23, cpaDelivered: 45, roas: 3.33,
  });
  assert.deepEqual(k.bySource, [
    { key: "", orders: 3, confirmed: 1, delivered: 0, revenue: 0 },
    { key: "meta", orders: 2, confirmed: 2, delivered: 2, revenue: 300 },
    { key: "tiktok", orders: 1, confirmed: 1, delivered: 0, revenue: 0 },
  ]);
  assert.deepEqual(k.byCampaign, [
    { key: "spring", orders: 2, confirmed: 2, delivered: 2, revenue: 300, adSpend: 50, roas: 6 },
    { key: "ghost", orders: 0, confirmed: 0, delivered: 0, revenue: 0, adSpend: 15, roas: 0 },
  ]);
  const byName = Object.fromEntries(k.byAgent.map((a) => [a.name, a]));
  assert.deepEqual([byName.Salma.orders, byName.Salma.confirmed, byName.Salma.delivered, byName.Salma.deliveryRate], [3, 3, 2, 100]);
  assert.deepEqual([byName.Omar.refused, byName.Omar.deliveryRate], [1, 0]);
  assert.equal(byName["Non assigné"].orders, 2);
  assert.deepEqual(k.topProducts, [
    { productId: "p1", name: "Lampe", units: 3, revenue: 240 },
    { productId: "p2", name: "Tapis", units: 1, revenue: 60 },
  ]);
});

test("agents never receive money fields", () => {
  const k = getKpis({ ...range, role: "agent" });
  assert.equal(k.counts.confirmationRate, 80);
  assert.equal(k.money, undefined);
  const json = JSON.stringify(k);
  for (const word of ["revenue", "cash", "outstanding", "cogs", "margin", "netProfit", "roas", "adSpend", "courier", "cpa", "money"]) {
    assert.ok(!json.includes(word), `agent payload leaks ${word}`);
  }
  assert.equal(JSON.stringify(getKpis({ ...range, role: "weird" })).includes("revenue"), false);
});

test("unknown cost price or tariff or spend yields null, not zero", () => {
  const r = { from: "2026-11-01", to: "2026-11-01" };
  const at = "2026-11-01T10:00:00.000Z";
  setDefaultCourierCost(null);
  order("J", { items: [item("v3", "p3", "Vase", 1, 100)], total: 100, outcome: "delivered", city: 3, at });
  const k = getKpis({ ...r, role: "admin" });
  assert.equal(k.money.cogs, null);
  assert.equal(k.money.missingCostLines, 1);
  assert.equal(k.money.missingTariff, 1);
  assert.equal(k.money.margin, null);
  assert.equal(k.money.netProfit, null);
  assert.equal(k.money.adSpend, null);
  assert.equal(k.money.roas, null);
  assert.equal(k.money.cpaDelivered, null);
  // Remittance fee is the fallback when no tariff/default exists.
  remit("R2", "J", 100, 18);
  const k2 = getKpis({ ...r, role: "admin" });
  assert.equal(k2.money.courierCost, 18);
  assert.equal(k2.money.missingTariff, 0);
  setDefaultCourierCost(20);
});

test("empty range never divides by zero", () => {
  const k = getKpis({ from: "2027-01-01", to: "2027-01-31", role: "admin" });
  assert.deepEqual(k.counts, {
    orders: 0, stillNew: 0, confirmed: 0, cancelled: 0, delivered: 0, refused: 0, pendingOutcome: 0,
    confirmationRate: null, deliveryRate: null, refusalRate: null,
  });
  assert.equal(k.money.adSpend, null);
  assert.equal(k.money.roas, null);
  assert.equal(k.money.netProfit, null);
  assert.equal(k.money.revenueDelivered, 0);
  assert.deepEqual([k.bySource, k.byCampaign, k.byAgent, k.topProducts], [[], [], [], []]);
});
