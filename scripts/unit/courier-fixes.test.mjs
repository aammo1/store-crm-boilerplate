import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module from "node:module";
import ts from "typescript";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import { loadSource } from "../test-source.mjs";
import { createFakeCourierHttp } from "./fixtures/fake-courier-http.mjs";
import { createOrder } from "../fulfillment-fixtures.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "courier-fixes-"));
process.env.DELIVERY_PROVIDER = "mock";
process.env.DB_PATH = path.join(dir, "crm.db");
process.env.AUTH_SECRET = "x".repeat(40);

const { getDb } = loadSource("@/lib/db");
const { createSenditProvider, __resetSenditTokenCache } = loadSource("@/lib/shipping/sendit");
const { createOzonProvider } = loadSource("@/lib/shipping/ozon");
const { getDashboard } = loadSource("@/lib/services/dashboard");
const { pollOnce, TRACKING_LAST_SYNC_KEY, TRACKING_THROTTLED_UNTIL_KEY } = loadSource("@/lib/services/tracking");
const { openStock, reserveForOrder, dispatchOrder } = loadSource("@/lib/services/inventory");
const { getAppState, setAppState } = loadSource("@/lib/services/app-state");
const { ProviderError } = loadSource("@/lib/shipping/errors");
const { confirmOrder } = loadSource("@/lib/services/confirmation");
Module._extensions[".tsx"] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
  });
  module._compile(outputText, filename);
};
const { aliasKeysFor } = loadSource("@/components/crm/city-combobox");
const tariffs = loadSource("@/lib/services/city-tariffs");

const db = getDb();
const now = new Date().toISOString();
const originalWarn = console.warn;
const originalError = console.error;

after(() => {
  console.warn = originalWarn;
  console.error = originalError;
  delete process.env.MOCK_COURIER_PROFILE;
  delete process.env.OZON_USE_CUSTOM_TRACKING;
  try { db.close(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
});

function resetSubmissions() {
  for (const table of ["delivery_note_parcels", "delivery_notes", "tracking_events", "returns", "courier_submissions"]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
}

const SENDIT = { publicKey: "PUBKEY-ABCDEFGH-1234", secretKey: "SECKEY-ZYXWVUTS-9876" };

function sendit(fakeHttp, { loginRoute = true, settings = {} } = {}) {
  __resetSenditTokenCache();
  if (loginRoute) {
    fakeHttp.route("POST", /\/login$/, () => fakeHttp.json({ data: { token: "TOKEN-FIXES-1" } }));
  }
  return createSenditProvider({
    env: {
      SENDIT_PUBLIC_KEY: SENDIT.publicKey,
      SENDIT_SECRET_KEY: SENDIT.secretKey,
      SENDIT_BASE_URL: "https://app.sendit.ma/api/v1",
    },
    getSettings: () => ({
      senditPickupDistrictId: 10,
      senditAllowOpen: true,
      senditAllowTry: false,
      ...settings,
    }),
    fetchImpl: fakeHttp.fetch,
  });
}

const parcelRequest = {
  reference: "STORE-77",
  orderId: "77",
  receiver: "Karim Tazi",
  phoneLocal: "0612345678",
  cityId: 10,
  cityName: "Casablanca",
  address: "42 Boulevard d'Anfa",
  codAmountMad: 250,
  description: "T-Shirt x1",
  items: [{ name: "T-Shirt", options: [], quantity: 1, sku: null }],
};

let fakeHttp;
beforeEach(() => {
  fakeHttp = createFakeCourierHttp();
});
afterEach(() => {
  fakeHttp.restoreGlobal();
  console.warn = originalWarn;
  console.error = originalError;
});

describe("1. dashboard 'À expédier' for couriers without BL", () => {
  db.prepare(`INSERT INTO products (id, slug, name, category, price, created_at, updated_at)
    VALUES ('dp', 'dp', 'Lampe', 'maison', 100, ?, ?)`).run(now, now);
  db.prepare("INSERT INTO variants (id, product_id, sku, label, options_json, options_key) VALUES ('dv', 'dp', 'dv', 'Std', '[]', '[]')").run();
  openStock("dv", 100, "test");
  let n = 0;
  function submittedParcel({ dispatched = false, draftBl = false, savedBl = false }) {
    const id = `dash${++n}`;
    createOrder({
      id,
      customerName: `Cliente ${n}`,
      customerPhone: "+212612345678",
      items: [],
      subtotal: 100,
      shipping: 0,
      total: 100,
    });
    db.prepare("UPDATE orders SET confirmation_status = 'confirmed' WHERE id = ?").run(id);
    db.prepare(`INSERT INTO courier_submissions
      (id, order_id, provider, status, tracking_number, next_retry_at, created_at, updated_at)
      VALUES (?, ?, 'mock', 'submitted', ?, ?, ?, ?)`).run(`s${id}`, id, `TRK-${id}`, now, now, now);
    if (dispatched) {
      reserveForOrder(id, [{ variantId: "dv", qty: 1 }], "test", "test");
      dispatchOrder(id, "test");
    }
    if (draftBl || savedBl) {
      db.prepare("INSERT INTO delivery_notes (id, ref, status, created_at) VALUES (?, ?, ?, ?)")
        .run(`dn-${id}`, `BL-${id}`, savedBl ? "saved" : "draft", now);
      db.prepare("INSERT INTO delivery_note_parcels (delivery_note_id, submission_id, added_at) VALUES (?, ?, ?)")
        .run(`dn-${id}`, `s${id}`, now);
    }
    return `s${id}`;
  }

  test("Sendit profile: handed-off parcels leave the list; not-yet-dispatched stay", () => {
    resetSubmissions();
    process.env.MOCK_COURIER_PROFILE = "sendit";
    const ready = submittedParcel({});
    const handedOff = submittedParcel({ dispatched: true });
    const card = getDashboard().readyBl;
    const ids = card.rows.map((r) => r.submissionId);
    assert.ok(ids.includes(ready));
    assert.ok(!ids.includes(handedOff), "a handed-off Sendit parcel must not stay in À expédier");
    const before = card.count;
    submittedParcel({ dispatched: true });
    submittedParcel({});
    assert.equal(getDashboard().readyBl.count, before + 1, "only the not-yet-dispatched parcel is counted");
  });

  test("Ozon profile: list unchanged (saved BL excluded, draft BL and non-BL parcels listed)", () => {
    resetSubmissions();
    process.env.MOCK_COURIER_PROFILE = "ozon";
    const plain = submittedParcel({});
    const draft = submittedParcel({ draftBl: true });
    const saved = submittedParcel({ savedBl: true });
    const rows = getDashboard().readyBl.rows;
    const ids = rows.map((r) => r.submissionId);
    assert.ok(ids.includes(plain));
    assert.ok(ids.includes(draft));
    assert.ok(!ids.includes(saved));
    assert.equal(rows.find((r) => r.submissionId === draft).blRef, `BL-${draft.slice(1)}`);
  });
});

describe("2/3. Sendit track(): errors surface, 429 stops the pass", () => {
  test("auth refused on login: throws permanent after a single login attempt", async () => {
    fakeHttp.route("POST", /\/login$/, () => fakeHttp.json({ message: "Unauthorized" }, { status: 401 }));
    const provider = sendit(fakeHttp, { loginRoute: false });
    await assert.rejects(
      provider.track(["A1", "A2", "A3", "A4", "A5"]),
      (err) => err instanceof ProviderError && err.kind === "permanent" && !err.message.includes(SENDIT.secretKey),
    );
    assert.equal(fakeHttp.calls.filter((c) => /\/login$/.test(c.url)).length, 1);
    assert.equal(fakeHttp.calls.filter((c) => /\/deliveries/.test(c.url)).length, 0);
  });

  test("network failure on every code: throws retryable instead of returning 'no status'", async () => {
    fakeHttp.route("GET", /\/deliveries\//, () => {
      throw new Error("ECONNRESET");
    });
    const provider = sendit(fakeHttp);
    await assert.rejects(
      provider.track(["B1", "B2", "B3", "B4"]),
      (err) => err instanceof ProviderError && err.kind === "retryable",
    );
  });

  test("login network failure throws retryable once (no login per parcel)", async () => {
    fakeHttp.route("POST", /\/login$/, () => {
      throw new Error("ENOTFOUND");
    });
    const provider = sendit(fakeHttp, { loginRoute: false });
    await assert.rejects(
      provider.track(["B1", "B2", "B3", "B4", "B5", "B6"]),
      (err) => err instanceof ProviderError && err.kind === "retryable",
    );
    assert.ok(fakeHttp.calls.filter((c) => /\/login$/.test(c.url)).length <= 3);
  });

  test("HTTP 5xx on every code throws retryable; all-404 is a real answer", async () => {
    fakeHttp.route("GET", /\/deliveries\/C/, () => fakeHttp.json({ message: "boom" }, { status: 503 }));
    const provider = sendit(fakeHttp);
    await assert.rejects(
      provider.track(["C1", "C2", "C3"]),
      (err) => err.kind === "retryable",
    );

    fakeHttp.clearRoutes();
    fakeHttp.route("GET", /\/deliveries\/D/, () => fakeHttp.json({ message: "nf" }, { status: 404 }));
    const results = await provider.track(["D1", "D2"]);
    assert.deepEqual(results.map((r) => [r.found, r.skipped]), [[false, undefined], [false, undefined]]);
  });

  test("mixed batch: failed codes are flagged skipped:'error', answered codes keep their status", async () => {
    fakeHttp.route("GET", /\/deliveries\/E1$/, () => fakeHttp.json({ data: { status: "DELIVERED" } }));
    fakeHttp.route("GET", /\/deliveries\/E2$/, () => fakeHttp.json({ message: "boom" }, { status: 500 }));
    const provider = sendit(fakeHttp);
    const results = await provider.track(["E1", "E2"]);
    assert.equal(results[0].rawStatus, "DELIVERED");
    assert.equal(results[0].skipped, undefined);
    assert.equal(results[1].rawStatus, null);
    assert.equal(results[1].skipped, "error");
  });

  test("429 on the very first code (nothing answered) throws throttled with retryAfterSec", async () => {
    fakeHttp.route("GET", /\/deliveries\//, () =>
      fakeHttp.json({ message: "slow down" }, { status: 429, headers: { "Retry-After": "120" } }),
    );
    const provider = sendit(fakeHttp);
    await assert.rejects(
      provider.track(["F1", "F2", "F3", "F4", "F5", "F6"]),
      (err) => err.kind === "throttled" && err.retryAfterSec === 120,
    );
  });
});

describe("2/3. pollOnce with failing / throttled providers", () => {
  let n = 0;
  function submitted(lastSyncAt = null) {
    const id = `poll${++n}`;
    createOrder({ id, customerName: "C", customerPhone: "+212612345678", items: [], subtotal: 1, shipping: 0, total: 1 });
    db.prepare(`INSERT INTO courier_submissions
      (id, order_id, provider, status, tracking_number, next_retry_at, last_sync_at, created_at, updated_at)
      VALUES (?, ?, 'mock', 'submitted', ?, ?, ?, ?, ?)`).run(`s${id}`, id, `P-${id}`, now, lastSyncAt, now, now);
    return { sub: `s${id}`, code: `P-${id}` };
  }
  const lastSync = (sub) => db.prepare("SELECT last_sync_at v FROM courier_submissions WHERE id = ?").get(sub).v;

  beforeEach(() => {
    resetSubmissions();
    db.prepare("DELETE FROM app_state WHERE key IN (?, ?)").run(TRACKING_LAST_SYNC_KEY, TRACKING_THROTTLED_UNTIL_KEY);
    process.env.MOCK_COURIER_PROFILE = "sendit";
    process.env.COURIER_TRACK_BATCH = "2";
    console.warn = () => {};
    console.error = () => {};
  });
  after(() => {
    delete process.env.COURIER_TRACK_BATCH;
  });

  test("a thrown provider error records a failed pass: no last-sync refresh, no per-parcel touch", async () => {
    const a = submitted();
    await pollOnce({
      profile: "sendit",
      track: async () => {
        throw new ProviderError("permanent", "Clés Sendit refusées");
      },
    });
    assert.equal(getAppState(TRACKING_LAST_SYNC_KEY), null);
    assert.equal(lastSync(a.sub), null);
  });

  test("skipped results neither touch last_sync_at nor count as a status", async () => {
    const a = submitted();
    const b = submitted();
    await pollOnce({
      profile: "sendit",
      track: async (codes) =>
        codes.map((code) =>
          code === a.code
            ? { trackingNumber: code, rawStatus: "DELIVERED", raw: {}, found: true }
            : { trackingNumber: code, rawStatus: null, raw: null, found: true, skipped: "error" },
        ),
    });
    assert.ok(lastSync(a.sub));
    assert.equal(lastSync(b.sub), null);
  });

  test("throttled result stops the pass (no further batch) and Retry-After pauses the next pass", async () => {
    for (let i = 0; i < 5; i++) submitted();
    const batches = [];
    const throttledProvider = {
      profile: "sendit",
      track: async (codes) => {
        batches.push(codes.length);
        return codes.map((code) => ({
          trackingNumber: code,
          rawStatus: null,
          raw: null,
          found: true,
          skipped: "throttled",
          retryAfterSec: 600,
        }));
      },
    };
    await pollOnce(throttledProvider);
    assert.equal(batches.length, 1, "only the first batch of 2 is requested");
    const until = Date.parse(getAppState(TRACKING_THROTTLED_UNTIL_KEY));
    assert.ok(until > Date.now() + 500_000 && until < Date.now() + 700_000);

    await pollOnce(throttledProvider);
    assert.equal(batches.length, 1, "pause active: next pass does not call the courier");

    setAppState(TRACKING_THROTTLED_UNTIL_KEY, new Date(Date.now() - 1000).toISOString());
    await pollOnce(throttledProvider);
    assert.equal(batches.length, 2);
  });

  test("a thrown throttled error also stops the loop", async () => {
    for (let i = 0; i < 5; i++) submitted();
    let calls = 0;
    await pollOnce({
      profile: "sendit",
      track: async () => {
        calls++;
        throw new ProviderError("throttled", "429", { retryAfterSec: 30 });
      },
    });
    assert.equal(calls, 1);
    assert.equal(getAppState(TRACKING_LAST_SYNC_KEY), null);
  });

  test("Ozon-like failing batch still continues with the next batch", async () => {
    for (let i = 0; i < 4; i++) submitted();
    let calls = 0;
    await pollOnce({
      profile: "ozon",
      track: async (codes) => {
        calls++;
        if (calls === 1) throw new ProviderError("retryable", "boom");
        return codes.map((code) => ({ trackingNumber: code, rawStatus: null, raw: null, found: true }));
      },
    });
    assert.equal(calls, 2);
    assert.ok(getAppState(TRACKING_LAST_SYNC_KEY));
  });
});

describe("4. Sendit lookup without last_page", () => {
  const phone = "0612345678";

  test("short page without last_page proves nothing → inconclusive", async () => {
    fakeHttp.route("GET", /\/deliveries\?querystring=/, () =>
      fakeHttp.json({ data: [{ reference: "OTHER", status: "DELIVERED", code: "X1" }] }),
    );
    const result = await sendit(fakeHttp).findParcelByReference("STORE-77", phone);
    assert.deepEqual(result, { complete: false, parcel: null });
  });

  test("empty first page without last_page is conclusive (no parcel for this phone)", async () => {
    fakeHttp.route("GET", /\/deliveries\?querystring=/, () => fakeHttp.json({ data: [] }));
    const result = await sendit(fakeHttp).findParcelByReference("STORE-77", phone);
    assert.deepEqual(result, { complete: true, parcel: null });
  });

  test("with last_page reported the search stays conclusive; a match is returned even without last_page", async () => {
    fakeHttp.route("GET", /page=1$/, () =>
      fakeHttp.json({ data: [{ reference: "OTHER", status: "DELIVERED", code: "X1" }], last_page: 2 }),
    );
    fakeHttp.route("GET", /page=2$/, () => fakeHttp.json({ data: [], last_page: 2 }));
    const result = await sendit(fakeHttp).findParcelByReference("STORE-77", phone);
    assert.deepEqual(result, { complete: true, parcel: null }, "last_page reported: page 2 is the end");

    fakeHttp.clearRoutes();
    fakeHttp.route("GET", /\/deliveries\?querystring=/, () =>
      fakeHttp.json({ data: [{ reference: "STORE-77", status: "PENDING", code: "FOUND-1" }] }),
    );
    const found = await sendit(fakeHttp).findParcelByReference("STORE-77", phone);
    assert.deepEqual(found, { complete: true, parcel: { trackingNumber: "FOUND-1", rawStatus: "PENDING" } });
  });
});

describe("5. Ozon behaviour restored", () => {
  function ozon() {
    process.env.OZON_CLIENT_ID = "OZ-CLIENT-1";
    process.env.OZON_API_KEY = "OZ-KEY-1";
    process.env.OZON_BASE_URL = "https://api.ozon.test";
    fakeHttp.installGlobal();
    return createOzonProvider();
  }

  test("OZON_USE_CUSTOM_TRACKING=1 fails permanently without any request and never sends tracking-number", async () => {
    process.env.OZON_USE_CUSTOM_TRACKING = "1";
    fakeHttp.route("POST", /\/add-parcel$/, () => fakeHttp.json({ result: "SUCCESS", "tracking-number": "X" }));
    try {
      await assert.rejects(
        ozon().createParcel(parcelRequest),
        (err) => err.kind === "permanent" && /customTrackingCode requis/.test(err.message),
      );
      assert.equal(fakeHttp.calls.length, 0);
    } finally {
      delete process.env.OZON_USE_CUSTOM_TRACKING;
    }
  });

  test("parcel-nature is omitted when the description is empty, present otherwise; no tracking-number field", async () => {
    delete process.env.OZON_USE_CUSTOM_TRACKING;
    fakeHttp.route("POST", /\/add-parcel$/, () =>
      fakeHttp.json({ result: "SUCCESS", "tracking-number": "OZ-OK-1" }),
    );
    const provider = ozon();
    await provider.createParcel({ ...parcelRequest, description: "" });
    await provider.createParcel(parcelRequest);
    const [empty, full] = fakeHttp.calls.map((c) => c.formData);
    assert.equal("parcel-nature" in empty, false);
    assert.equal(full["parcel-nature"], "T-Shirt x1");
    assert.equal("tracking-number" in full, false);
    assert.equal(full["parcel-stock"], "0");
  });
});

describe("7. Sendit error text: redact before truncating", () => {
  test("a secret straddling the 500-char cut never leaks a fragment", async () => {
    const prefixLength = "Échec (HTTP 400): ".length;
    const message = "a".repeat(500 - prefixLength - 6) + SENDIT.secretKey + " fin";
    fakeHttp.route("POST", /\/deliveries$/, () => fakeHttp.json({ message }, { status: 400 }));
    await assert.rejects(
      sendit(fakeHttp).createParcel(parcelRequest),
      (err) => {
        assert.equal(err.kind, "permanent");
        assert.ok(err.message.length <= 500);
        assert.ok(!err.message.includes(SENDIT.secretKey.slice(0, 4)), `leaked fragment in: ${err.message.slice(-40)}`);
        return true;
      },
    );
  });
});

describe("11. Sendit login failure before create is retryable, not uncertain", () => {
  async function createWithLogin(handler) {
    fakeHttp.route("POST", /\/login$/, handler);
    fakeHttp.route("POST", /\/deliveries$/, () => fakeHttp.json({ success: true, data: { code: "NEVER" } }));
    const provider = sendit(fakeHttp, { loginRoute: false });
    try {
      await provider.createParcel(parcelRequest);
      assert.fail("expected createParcel to throw");
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(fakeHttp.calls.filter((c) => /\/deliveries$/.test(c.url)).length, 0, "create request never sent");
      return err;
    }
  }

  test("login network error → throttled (requeue), nothing sent", async () => {
    const err = await createWithLogin(() => {
      throw new Error("ECONNREFUSED");
    });
    assert.equal(err.kind, "throttled");
  });

  test("login 503 → throttled (requeue)", async () => {
    const err = await createWithLogin(() => fakeHttp.json({ message: "down" }, { status: 503 }));
    assert.equal(err.kind, "throttled");
  });

  test("login 401/403 (keys refused) stays permanent", async () => {
    const err = await createWithLogin(() => fakeHttp.json({ message: "no" }, { status: 401 }));
    assert.equal(err.kind, "permanent");
  });

  test("failure of the create request itself stays uncertain (unknown)", async () => {
    fakeHttp.route("POST", /\/deliveries$/, () => {
      throw new Error("socket hang up");
    });
    await assert.rejects(sendit(fakeHttp).createParcel(parcelRequest), (err) => err.kind === "unknown");
  });
});

describe("9. confirmation address messages", () => {
  test("too long gets its own message; too short keeps the original", () => {
    createOrder({ id: "addr1", customerName: "C", customerPhone: "+212612345678", items: [], subtotal: 1, shipping: 0, total: 1 });
    const actor = { id: "u", name: "U", role: "admin" };
    const attempt = (address) => () => confirmOrder("addr1", { lines: [], address, cityId: 1 }, actor);
    assert.throws(attempt("x".repeat(501)), (err) => err.status === 400 && /trop longue/.test(err.message) && /500/.test(err.message));
    assert.throws(attempt("abc"), (err) => err.status === 400 && /trop courte/.test(err.message));
  });
});

describe("10. city tariffs scoped to the active provider; alias search by ville", () => {
  test("other-provider cities are hidden/rejected unless they already have a tariff row", () => {
    db.prepare("DELETE FROM city_tariffs").run();
    db.prepare("DELETE FROM cities").run();
    db.prepare("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('adm', 'a@x.test', 'x', 'A', 'admin', ?)").run(now);
    db.prepare(`INSERT INTO cities (id, name, updated_at, provider) VALUES
      (1, 'Casablanca', ?, 'mock'), (2, 'Ozon-only', ?, 'ozon'), (3, 'Ozon-tariffed', ?, 'ozon')`).run(now, now, now);
    db.prepare("INSERT INTO city_tariffs (city_id, courier_cost, updated_at) VALUES (3, 22, ?)").run(now);

    assert.deepEqual(tariffs.listCityTariffs().map((t) => t.cityName), ["Casablanca", "Ozon-tariffed"]);
    const base = { courierCost: 10, customerFeeOverride: null, overrideIgnoresFreeThreshold: false };
    assert.throws(() => tariffs.upsertCityTariff({ ...base, cityId: 2 }, "adm"), { status: 404 });
    assert.equal(tariffs.upsertCityTariff({ ...base, cityId: 1 }, "adm").courierCost, 10);
    assert.equal(tariffs.upsertCityTariff({ ...base, cityId: 3, courierCost: 25 }, "adm").courierCost, 25);
    assert.equal(tariffs.getCityTariff(3).courierCost, 25);
  });

  test("aliasKeysFor matches ville and district parts of 'Casablanca - Maarif'", () => {
    assert.ok(aliasKeysFor("Casablanca - Maarif").includes("casa"));
    assert.ok(aliasKeysFor("Maârif - Casablanca").includes("casa"));
    assert.ok(aliasKeysFor("Marrakech - Gueliz").includes("kech"));
    assert.ok(aliasKeysFor("Casablanca").includes("darbeida"));
    assert.deepEqual(aliasKeysFor("Maarif"), []);
  });
});

describe("12. .env.example stays loadable by the simple env loader", () => {
  test("no inline comments after values", () => {
    const text = fs.readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim() || line.startsWith("#")) continue;
      assert.match(line, /^[A-Z][A-Z0-9_]*=("[^"]*"|[^#\s"]*)$/, `inline comment or odd value: ${line}`);
    }
  });
});
