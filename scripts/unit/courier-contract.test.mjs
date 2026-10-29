import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import { loadSource } from "../test-source.mjs";
import { createFakeCourierHttp } from "./fixtures/fake-courier-http.mjs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "courier-contract-"));
process.env.DELIVERY_PROVIDER = "mock";
process.env.DB_PATH = path.join(tempDir, "test.db");

const { COURIERS } = loadSource("@/lib/shipping/couriers");
const { normalizeStatus } = loadSource("@/lib/shipping/status-map");
const { ProviderError } = loadSource("@/lib/shipping/errors");
const { createMockProvider } = loadSource("@/lib/shipping/mock");
const { createOzonProvider } = loadSource("@/lib/shipping/ozon");
const { createSenditProvider, __resetSenditTokenCache } = loadSource("@/lib/shipping/sendit");

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

after(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  const { getDb } = loadSource("@/lib/db");
  try {
    getDb().close();
  } catch {}
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const standardParcelRequest = {
  reference: "STORE-1001",
  orderId: "order-1001",
  receiver: "Karim Tazi",
  phoneLocal: "0612345678",
  cityId: 10,
  cityName: "Casablanca",
  address: "42 Boulevard d'Anfa",
  codAmountMad: 250,
  description: "T-Shirt x1",
  items: [
    {
      name: "T-Shirt",
      options: [{ name: "Taille", value: "M" }],
      quantity: 1,
      sku: "TS-M",
    },
  ],
};

const OZON_CREDS = {
  clientId: "SECRET-OZON-CLIENT-999",
  apiKey: "SECRET-OZON-KEY-888",
  baseUrl: "https://api.ozon.test",
};

const SENDIT_CREDS = {
  publicKey: "SECRET-SENDIT-PUB-777",
  secretKey: "SECRET-SENDIT-SEC-666",
  baseUrl: "https://app.sendit.ma/api/v1",
};

function setupOzon(fakeHttp) {
  process.env.OZON_CLIENT_ID = OZON_CREDS.clientId;
  process.env.OZON_API_KEY = OZON_CREDS.apiKey;
  process.env.OZON_BASE_URL = OZON_CREDS.baseUrl;
  delete process.env.OZON_USE_CUSTOM_TRACKING;
  fakeHttp.installGlobal();
  return createOzonProvider();
}

function setupSendit(fakeHttp, overrides = {}) {
  __resetSenditTokenCache();
  const env = {
    SENDIT_PUBLIC_KEY: SENDIT_CREDS.publicKey,
    SENDIT_SECRET_KEY: SENDIT_CREDS.secretKey,
    SENDIT_BASE_URL: SENDIT_CREDS.baseUrl,
    ...overrides.env,
  };
  const settings = {
    senditPickupDistrictId: 10,
    senditAllowOpen: true,
    senditAllowTry: false,
    ...overrides.settings,
  };
  // Default login route if not already handled
  fakeHttp.route("POST", /\/login$/, () =>
    fakeHttp.json({ data: { token: "TOKEN-MOCK-INITIAL-123" } }),
  );
  const provider = createSenditProvider({
    env,
    getSettings: () => settings,
    fetchImpl: fakeHttp.fetch,
  });
  return { provider, env, settings };
}

describe("Shared Courier Contract", () => {
  let fakeHttp;

  beforeEach(() => {
    fakeHttp = createFakeCourierHttp();
  });

  afterEach(() => {
    fakeHttp.restoreGlobal();
  });

  test("1. createParcel returns courier code; carries no client price other than snapshot amount", async () => {
    // Ozon
    fakeHttp.clearRoutes();
    fakeHttp.route("POST", /\/add-parcel$/, () =>
      fakeHttp.json({ result: "SUCCESS", "tracking-number": "OZON-PARCEL-100" }),
    );
    const ozon = setupOzon(fakeHttp);
    const ozonRes = await ozon.createParcel(standardParcelRequest);
    assert.equal(ozonRes.trackingNumber, "OZON-PARCEL-100");
    const ozonCall = fakeHttp.calls.find((c) => c.pathname.includes("/add-parcel"));
    assert.ok(ozonCall, "add-parcel must be called");
    assert.equal(ozonCall.formData["parcel-price"], "250");
    assert.equal(ozonCall.formData["price"], undefined);
    assert.equal(ozonCall.formData["client_price"], undefined);

    // Sendit
    fakeHttp.reset();
    fakeHttp.clearRoutes();
    fakeHttp.route("POST", /\/deliveries$/, () =>
      fakeHttp.json({ success: true, data: { code: "SND-PARCEL-200" } }),
    );
    const { provider: sendit } = setupSendit(fakeHttp);
    const senditRes = await sendit.createParcel(standardParcelRequest);
    assert.equal(senditRes.trackingNumber, "SND-PARCEL-200");
    const senditCall = fakeHttp.calls.find((c) => c.pathname.includes("/deliveries"));
    assert.ok(senditCall, "deliveries must be called");
    assert.equal(senditCall.json.amount, 250);
    assert.equal(senditCall.json.price, undefined);
    assert.equal(senditCall.json.client_price, undefined);

    // Mock (ozon profile)
    const mockOzon = createMockProvider({ profile: "ozon" });
    const mockOzonRes = await mockOzon.createParcel(standardParcelRequest);
    assert.match(mockOzonRes.trackingNumber, /^OZEMOCK/);
    assert.equal(mockOzonRes.raw["PRICE"], "250");

    // Mock (sendit profile)
    const mockSendit = createMockProvider({ profile: "sendit" });
    const mockSenditRes = await mockSendit.createParcel(standardParcelRequest);
    assert.match(mockSenditRes.trackingNumber, /^SNDMOCK/);
    assert.equal(mockSenditRes.raw["PRICE"], "250");
  });

  test("2. Invalid input (bad phone, empty address, cityId 0) throws permanent without any fetch call", async () => {
    // Ozon
    const ozon = setupOzon(fakeHttp);
    const invalidOzonCases = [
      { patch: { phoneLocal: "12345" }, desc: "bad phone" },
      { patch: { address: "" }, desc: "empty address" },
      { patch: { cityId: 0 }, desc: "cityId 0" },
      { patch: { receiver: "" }, desc: "empty receiver" },
    ];
    for (const { patch, desc } of invalidOzonCases) {
      fakeHttp.reset();
      await assert.rejects(
        async () => ozon.createParcel({ ...standardParcelRequest, ...patch }),
        (err) => {
          assert.ok(err instanceof ProviderError);
          assert.equal(err.kind, "permanent", `Ozon should reject ${desc} with permanent`);
          return true;
        },
      );
      assert.equal(fakeHttp.calls.length, 0, `Ozon must not call fetch for ${desc}`);
    }

    // Sendit
    fakeHttp.clearRoutes();
    const { provider: sendit } = setupSendit(fakeHttp);
    const invalidSenditCases = [
      { patch: { phoneLocal: "0912345678" }, desc: "bad phone prefix" },
      { patch: { address: "" }, desc: "empty address" },
      { patch: { cityId: 0 }, desc: "cityId 0" },
      { patch: { receiver: "" }, desc: "empty receiver" },
    ];
    for (const { patch, desc } of invalidSenditCases) {
      fakeHttp.reset();
      await assert.rejects(
        async () => sendit.createParcel({ ...standardParcelRequest, ...patch }),
        (err) => {
          assert.ok(err instanceof ProviderError);
          assert.equal(err.kind, "permanent", `Sendit should reject ${desc} with permanent`);
          return true;
        },
      );
      assert.equal(fakeHttp.calls.length, 0, `Sendit must not call fetch for ${desc}`);
    }
  });

  test("3. Network error / abort → kind unknown or retryable (never permanent, never throttled)", async () => {
    // Ozon network error
    fakeHttp.clearRoutes();
    fakeHttp.route("POST", /\/add-parcel$/, () => {
      throw new Error("fetch failed: ECONNRESET");
    });
    const ozon = setupOzon(fakeHttp);
    await assert.rejects(
      async () => ozon.createParcel(standardParcelRequest),
      (err) => {
        assert.ok(
          err.kind === "unknown" || err.kind === "retryable",
          `Ozon network error kind was ${err.kind}`,
        );
        assert.notEqual(err.kind, "permanent");
        assert.notEqual(err.kind, "throttled");
        return true;
      },
    );

    // Ozon abort / timeout
    fakeHttp.clearRoutes();
    fakeHttp.route("GET", /\/cities$/, () => {
      throw new DOMException("The operation was aborted", "TimeoutError");
    });
    await assert.rejects(
      async () => ozon.listCities(),
      (err) => {
        assert.ok(
          err.kind === "unknown" || err.kind === "retryable",
          `Ozon abort kind was ${err.kind}`,
        );
        assert.notEqual(err.kind, "permanent");
        assert.notEqual(err.kind, "throttled");
        return true;
      },
    );

    // Sendit network error on createParcel (uncertainOnThrow -> unknown)
    fakeHttp.clearRoutes();
    fakeHttp.route("POST", /\/deliveries$/, () => {
      throw new Error("fetch failed: ETIMEDOUT");
    });
    const { provider: sendit } = setupSendit(fakeHttp);
    await assert.rejects(
      async () => sendit.createParcel(standardParcelRequest),
      (err) => {
        assert.ok(
          err.kind === "unknown" || err.kind === "retryable",
          `Sendit createParcel error kind was ${err.kind}`,
        );
        assert.notEqual(err.kind, "permanent");
        assert.notEqual(err.kind, "throttled");
        return true;
      },
    );

    // Sendit abort on listCities (retryable)
    fakeHttp.clearRoutes();
    fakeHttp.route("GET", /\/districts/, () => {
      throw new DOMException("The operation was aborted", "TimeoutError");
    });
    await assert.rejects(
      async () => sendit.listCities(),
      (err) => {
        assert.ok(
          err.kind === "unknown" || err.kind === "retryable",
          `Sendit listCities abort kind was ${err.kind}`,
        );
        assert.notEqual(err.kind, "permanent");
        assert.notEqual(err.kind, "throttled");
        return true;
      },
    );
  });

  test("4. HTTP 500 → not permanent, not throttled", async () => {
    // Ozon 500
    fakeHttp.clearRoutes();
    fakeHttp.route("POST", /\/add-parcel$/, () =>
      fakeHttp.text("Internal Server Error", { status: 500 }),
    );
    const ozon = setupOzon(fakeHttp);
    await assert.rejects(
      async () => ozon.createParcel(standardParcelRequest),
      (err) => {
        assert.notEqual(err.kind, "permanent");
        assert.notEqual(err.kind, "throttled");
        assert.equal(err.kind, "retryable");
        return true;
      },
    );

    // Sendit 500 on createParcel
    fakeHttp.clearRoutes();
    fakeHttp.route("POST", /\/deliveries$/, () =>
      fakeHttp.json({ error: "Internal Server Error" }, { status: 500 }),
    );
    const { provider: sendit } = setupSendit(fakeHttp);
    await assert.rejects(
      async () => sendit.createParcel(standardParcelRequest),
      (err) => {
        assert.notEqual(err.kind, "permanent");
        assert.notEqual(err.kind, "throttled");
        assert.equal(err.kind, "unknown");
        return true;
      },
    );

    // Sendit 500 on listCities
    fakeHttp.clearRoutes();
    fakeHttp.route("GET", /\/districts/, () =>
      fakeHttp.json({ error: "Internal Server Error" }, { status: 500 }),
    );
    await assert.rejects(
      async () => sendit.listCities(),
      (err) => {
        assert.notEqual(err.kind, "permanent");
        assert.notEqual(err.kind, "throttled");
        assert.equal(err.kind, "retryable");
        return true;
      },
    );
  });

  test("5. Error messages never contain configured secrets nor Bearer <token>", async () => {
    // Ozon secrets
    fakeHttp.clearRoutes();
    fakeHttp.route("POST", /\/add-parcel$/, () =>
      fakeHttp.text(
        `Failed at ${OZON_CREDS.baseUrl}/customers/${OZON_CREDS.clientId}/${OZON_CREDS.apiKey}/add-parcel with key ${OZON_CREDS.apiKey}`,
        { status: 500 },
      ),
    );
    const ozon = setupOzon(fakeHttp);
    await assert.rejects(
      async () => ozon.createParcel(standardParcelRequest),
      (err) => {
        assert.ok(!err.message.includes(OZON_CREDS.clientId), "clientId must be redacted");
        assert.ok(!err.message.includes(OZON_CREDS.apiKey), "apiKey must be redacted");
        assert.match(err.message, /\/customers\/\*\*\*\/\*\*\*/);
        return true;
      },
    );

    // Sendit secrets and Bearer token
    const testBearer = "SECRET-BEARER-TOKEN-999";
    fakeHttp.clearRoutes();
    fakeHttp.route("POST", /\/login$/, () =>
      fakeHttp.json({ data: { token: testBearer } }),
    );
    fakeHttp.route("POST", /\/deliveries$/, () =>
      fakeHttp.json(
        {
          message: `Failed for ${SENDIT_CREDS.publicKey} and ${SENDIT_CREDS.secretKey} with Bearer ${testBearer}`,
        },
        { status: 500 },
      ),
    );
    const { provider: sendit } = setupSendit(fakeHttp);
    await assert.rejects(
      async () => sendit.createParcel(standardParcelRequest),
      (err) => {
        assert.ok(!err.message.includes(SENDIT_CREDS.publicKey), "publicKey must be redacted");
        assert.ok(!err.message.includes(SENDIT_CREDS.secretKey), "secretKey must be redacted");
        assert.ok(!err.message.includes(testBearer), "bearer token must be redacted");
        assert.match(err.message, /Bearer \*\*\*/, "Bearer token must be masked with ***");
        return true;
      },
    );
  });

  test("6. listCities parses fixture into {id: number, name}", async () => {
    // Ozon
    fakeHttp.clearRoutes();
    fakeHttp.route("GET", /\/cities$/, () =>
      fakeHttp.json([
        { id: 1, name: "Casablanca" },
        { id: 2, name: "Rabat" },
      ]),
    );
    const ozon = setupOzon(fakeHttp);
    const ozonCities = await ozon.listCities();
    assert.equal(ozonCities.length, 2);
    assert.deepEqual(ozonCities, [
      { id: 1, name: "Casablanca" },
      { id: 2, name: "Rabat" },
    ]);

    // Sendit
    fakeHttp.clearRoutes();
    fakeHttp.route("GET", /\/districts\?page=1$/, () =>
      fakeHttp.json({
        data: [
          { id: 10, name: "Tanger Ville", ville: "Tanger" },
          { id: 20, name: "Fès Medina", ville: "Fès" },
        ],
        last_page: 1,
      }),
    );
    const { provider: sendit } = setupSendit(fakeHttp);
    const senditCities = await sendit.listCities();
    assert.equal(senditCities.length, 2);
    assert.equal(senditCities[0].id, 10);
    assert.equal(senditCities[0].name, "Tanger Ville");
    assert.equal(senditCities[1].id, 20);
    assert.equal(senditCities[1].name, "Fès Medina");

    // Mock ozon
    const mockOzon = createMockProvider({ profile: "ozon" });
    const mockOzonCities = await mockOzon.listCities();
    assert.ok(mockOzonCities.length > 0);
    assert.equal(typeof mockOzonCities[0].id, "number");
    assert.equal(typeof mockOzonCities[0].name, "string");

    // Mock sendit
    const mockSendit = createMockProvider({ profile: "sendit" });
    const mockSenditCities = await mockSendit.listCities();
    assert.ok(mockSenditCities.length > 0);
    assert.equal(typeof mockSenditCities[0].id, "number");
    assert.equal(typeof mockSenditCities[0].name, "string");
  });

  test("7. track returns one result per requested code with found semantics", async () => {
    // Ozon
    fakeHttp.clearRoutes();
    fakeHttp.route("POST", /\/tracking$/, () =>
      fakeHttp.json({
        "TRACKING-LIST": {
          "OZ-FOUND": { status: "LIVRE" },
        },
      }),
    );
    const ozon = setupOzon(fakeHttp);
    const ozonTrack = await ozon.track(["OZ-FOUND", "OZ-NOTFOUND"]);
    assert.equal(ozonTrack.length, 2);
    assert.equal(ozonTrack[0].trackingNumber, "OZ-FOUND");
    assert.equal(ozonTrack[0].found, true);
    assert.equal(ozonTrack[0].rawStatus, "LIVRE");
    assert.equal(ozonTrack[1].trackingNumber, "OZ-NOTFOUND");
    assert.equal(ozonTrack[1].found, false);
    assert.equal(ozonTrack[1].rawStatus, null);

    // Sendit
    fakeHttp.clearRoutes();
    fakeHttp.route("GET", /\/deliveries\/SND-FOUND$/, () =>
      fakeHttp.json({ data: { status: "DELIVERED" } }),
    );
    fakeHttp.route("GET", /\/deliveries\/SND-NOTFOUND$/, () =>
      fakeHttp.text("Not found", { status: 404 }),
    );
    const { provider: sendit } = setupSendit(fakeHttp);
    const senditTrack = await sendit.track(["SND-FOUND", "SND-NOTFOUND"]);
    assert.equal(senditTrack.length, 2);
    assert.equal(senditTrack[0].trackingNumber, "SND-FOUND");
    assert.equal(senditTrack[0].found, true);
    assert.equal(senditTrack[0].rawStatus, "DELIVERED");
    assert.equal(senditTrack[1].trackingNumber, "SND-NOTFOUND");
    assert.equal(senditTrack[1].found, false);
    assert.equal(senditTrack[1].rawStatus, null);

    // Mock
    const mock = createMockProvider({ profile: "sendit" });
    const created = await mock.createParcel(standardParcelRequest);
    const mockTrack = await mock.track([created.trackingNumber, "UNKNOWN-CODE-999"]);
    assert.equal(mockTrack.length, 2);
    assert.equal(mockTrack[0].found, true);
    assert.equal(mockTrack[1].found, false);
  });

  test("8. capabilities matches COURIERS[profile].capabilities", () => {
    const ozon = createOzonProvider();
    assert.deepEqual(ozon.capabilities, COURIERS.ozon.capabilities);

    const { provider: sendit } = setupSendit(fakeHttp);
    assert.deepEqual(sendit.capabilities, COURIERS.sendit.capabilities);

    const mockOzon = createMockProvider({ profile: "ozon" });
    assert.deepEqual(mockOzon.capabilities, COURIERS.ozon.capabilities);

    const mockSendit = createMockProvider({ profile: "sendit" });
    assert.deepEqual(mockSendit.capabilities, COURIERS.sendit.capabilities);
  });
});

describe("Sendit Courier Adapter Details", () => {
  let fakeHttp;

  beforeEach(() => {
    fakeHttp = createFakeCourierHttp();
  });

  afterEach(() => {
    fakeHttp.restoreGlobal();
  });

  test("429 on create → throttled with retryAfterSec from Retry-After", async () => {
    fakeHttp.route("POST", /\/deliveries$/, () =>
      fakeHttp.json(
        { message: "Trop de requêtes" },
        { status: 429, headers: { "Retry-After": "45" } },
      ),
    );
    const { provider: sendit } = setupSendit(fakeHttp);
    await assert.rejects(
      async () => sendit.createParcel(standardParcelRequest),
      (err) => {
        assert.equal(err.kind, "throttled");
        assert.equal(err.retryAfterSec, 45);
        return true;
      },
    );
  });

  test("200 success:false → permanent; 200 without data.code → unknown", async () => {
    // 200 success: false
    fakeHttp.route("POST", /\/deliveries$/, () =>
      fakeHttp.json({ success: false, message: "Solde insuffisant" }, { status: 200 }),
    );
    const { provider: sendit } = setupSendit(fakeHttp);
    await assert.rejects(
      async () => sendit.createParcel(standardParcelRequest),
      (err) => {
        assert.equal(err.kind, "permanent");
        assert.match(err.message, /Solde insuffisant/);
        return true;
      },
    );

    // 200 without data.code
    fakeHttp.clearRoutes();
    fakeHttp.route("POST", /\/deliveries$/, () =>
      fakeHttp.json({ success: true, data: {} }, { status: 200 }),
    );
    const { provider: sendit2 } = setupSendit(fakeHttp);
    await assert.rejects(
      async () => sendit2.createParcel(standardParcelRequest),
      (err) => {
        assert.equal(err.kind, "unknown");
        return true;
      },
    );
  });

  test("First call 401 with cached token → exactly one re-login then success; second 401 → permanent", async () => {
    let loginCalls = 0;
    fakeHttp.route("POST", /\/login$/, () => {
      loginCalls++;
      return fakeHttp.json({ data: { token: `TOKEN-ATTEMPT-${loginCalls}` } });
    });

    let deliveryAttempts = 0;
    fakeHttp.route("POST", /\/deliveries$/, ({ getHeader }) => {
      deliveryAttempts++;
      const auth = getHeader("Authorization");
      if (auth === "Bearer TOKEN-ATTEMPT-1") {
        return fakeHttp.json({ message: "Expired token" }, { status: 401 });
      }
      return fakeHttp.json({ success: true, data: { code: "SND-RETRY-OK" } });
    });

    const { provider: sendit } = setupSendit(fakeHttp);
    // Seed the cache with the first token
    await sendit.testConnection();
    assert.equal(loginCalls, 1);

    // Call createParcel: delivery gets 401 on TOKEN-ATTEMPT-1, triggers 1 re-login, succeeds with TOKEN-ATTEMPT-2
    const res = await sendit.createParcel(standardParcelRequest);
    assert.equal(res.trackingNumber, "SND-RETRY-OK");
    assert.equal(loginCalls, 2, "Must perform exactly one re-login");
    assert.equal(deliveryAttempts, 2);

    // Second scenario: Second 401 → permanent
    fakeHttp.clearRoutes();
    fakeHttp.route("POST", /\/login$/, () =>
      fakeHttp.json({ data: { token: "TOKEN-STILL-BAD" } }),
    );
    fakeHttp.route("POST", /\/deliveries$/, () =>
      fakeHttp.json({ message: "Forbidden" }, { status: 401 }),
    );
    const { provider: senditFail } = setupSendit(fakeHttp);
    await senditFail.testConnection();

    await assert.rejects(
      async () => senditFail.createParcel(standardParcelRequest),
      (err) => {
        assert.equal(err.kind, "permanent");
        assert.match(err.message, /refusées/i);
        return true;
      },
    );
  });

  test("Token reused across calls and refreshed when public key changes", async () => {
    let loginCount = 0;
    fakeHttp.route("POST", /\/login$/, () => {
      loginCount++;
      return fakeHttp.json({ data: { token: "TOKEN-REUSED-1" } });
    });
    fakeHttp.route("GET", /\/deliveries\//, () =>
      fakeHttp.json({ data: { status: "DELIVERED" } }),
    );

    const { provider: sendit1 } = setupSendit(fakeHttp);
    await sendit1.getParcelInfo("SND-001");
    await sendit1.getParcelInfo("SND-002");
    await sendit1.getParcelInfo("SND-003");
    assert.equal(loginCount, 1, "Login must be called only once for multiple requests");

    // Change public key
    const { provider: sendit2 } = setupSendit(fakeHttp, {
      env: { SENDIT_PUBLIC_KEY: "KEY-DIFFERENT-123" },
    });
    await sendit2.getParcelInfo("SND-004");
    assert.equal(loginCount, 2, "Login must be called again when public key changes");
  });

  test("Districts: two pages, tatweel-only/Latin arabic_name dropped, Casablanca pickup, decimal price null", async () => {
    fakeHttp.route("GET", /\/districts\?page=1$/, () =>
      fakeHttp.json({
        data: [
          {
            id: 1,
            name: "Casablanca Anfa",
            arabic_name: "الدار البيضاء أنفا",
            ville: "casablanca",
            pickup_district: 0,
            price: 25,
          },
          {
            id: 2,
            name: "Rabat Agdal",
            arabic_name: "ـ ـ ـ", // tatweel-only
            ville: "rabat",
            pickup_district: 0,
            price: 35.5, // decimal price
          },
        ],
        last_page: 2,
      }),
    );

    fakeHttp.route("GET", /\/districts\?page=2$/, () =>
      fakeHttp.json({
        data: [
          {
            id: 3,
            name: "Marrakech Medina",
            arabic_name: "Marrakech", // Latin only
            ville: "marrakech",
            pickup_district: 1,
            price: 40,
          },
        ],
        last_page: 2,
      }),
    );

    const { provider: sendit } = setupSendit(fakeHttp);
    const districts = await sendit.listCities();
    assert.equal(districts.length, 3);

    // Casablanca non-flagged district marked pickup; integer price preserved
    assert.equal(districts[0].id, 1);
    assert.equal(districts[0].name, "Casablanca Anfa");
    assert.equal(districts[0].arabicName, "الدار البيضاء أنفا");
    assert.equal(districts[0].pickup, true);
    assert.equal(districts[0].priceMad, 25);

    // Tatweel-only dropped to null; decimal price dropped to null
    assert.equal(districts[1].id, 2);
    assert.equal(districts[1].name, "Rabat Agdal");
    assert.equal(districts[1].arabicName, null);
    assert.equal(districts[1].pickup, false);
    assert.equal(districts[1].priceMad, null);

    // Latin arabic_name dropped to null; pickup_district 1 marked pickup
    assert.equal(districts[2].id, 3);
    assert.equal(districts[2].name, "Marrakech Medina");
    assert.equal(districts[2].arabicName, null);
    assert.equal(districts[2].pickup, true);
    assert.equal(districts[2].priceMad, 40);
  });

  test("Create body: pickup_district_id from settings, allow_open/allow_try 1/0, products string format, reference passed through", async () => {
    let capturedBody = null;
    fakeHttp.route("POST", /\/deliveries$/, ({ json }) => {
      capturedBody = json;
      return fakeHttp.json({ success: true, data: { code: "SND-FMT-123" } });
    });

    const { provider: sendit } = setupSendit(fakeHttp, {
      settings: {
        senditPickupDistrictId: 77,
        senditAllowOpen: true,
        senditAllowTry: false,
      },
    });

    const request = {
      ...standardParcelRequest,
      reference: "ORDER-ABC-777",
      items: [
        { name: "Chemise", options: [{ name: "Taille", value: "M" }], quantity: 2, sku: "CH-M" },
        { name: "Cravate", options: [], quantity: 1, sku: "CR" },
      ],
    };

    await sendit.createParcel(request);
    assert.ok(capturedBody, "Body must be captured");
    assert.equal(capturedBody.pickup_district_id, 77);
    assert.equal(capturedBody.allow_open, 1);
    assert.equal(capturedBody.allow_try, 0);
    assert.equal(capturedBody.reference, "ORDER-ABC-777");
    assert.equal(capturedBody.products, "Chemise (Taille: M) x2 | Cravate x1");
  });

  test("Missing pickup district → permanent, no fetch; isConfigured() false and configurationIssues() lists it", async () => {
    const { provider: sendit } = setupSendit(fakeHttp, {
      settings: { senditPickupDistrictId: null },
    });

    assert.equal(sendit.isConfigured(), false);
    const issues = sendit.configurationIssues();
    assert.ok(
      issues.some((issue) => issue.includes("District de ramassage Sendit non choisi")),
      `Issues should list pickup district: ${JSON.stringify(issues)}`,
    );

    fakeHttp.reset();
    await assert.rejects(
      async () => sendit.createParcel(standardParcelRequest),
      (err) => {
        assert.equal(err.kind, "permanent");
        assert.match(err.message, /District de ramassage Sendit non configuré/);
        return true;
      },
    );
    assert.equal(fakeHttp.calls.length, 0);
  });

  test("Labels: picks URL from data.file_url; rejects foreign hosts and insecure http", async () => {
    // Valid URL
    fakeHttp.route("POST", /\/deliveries\/getlabels$/, () =>
      fakeHttp.json({ data: { file_url: "https://app.sendit.ma/storage/labels-10x10.pdf" } }),
    );
    const { provider: sendit } = setupSendit(fakeHttp);
    const labels = await sendit.getLabelsPdf(["SND-100", "SND-101"], "10x10");
    assert.equal(labels.url, "https://app.sendit.ma/storage/labels-10x10.pdf");

    // Foreign host rejected
    fakeHttp.clearRoutes();
    fakeHttp.route("POST", /\/deliveries\/getlabels$/, () =>
      fakeHttp.json({ data: { file_url: "https://evil.example/malicious.pdf" } }),
    );
    await assert.rejects(
      async () => sendit.getLabelsPdf(["SND-100"], "10x10"),
      (err) => {
        assert.equal(err.kind, "unknown");
        assert.match(err.message, /Lien d'étiquettes Sendit invalide/);
        return true;
      },
    );

    // Insecure http rejected
    fakeHttp.clearRoutes();
    fakeHttp.route("POST", /\/deliveries\/getlabels$/, () =>
      fakeHttp.json({ data: { file_url: "http://app.sendit.ma/storage/labels.pdf" } }),
    );
    await assert.rejects(
      async () => sendit.getLabelsPdf(["SND-100"], "10x10"),
      (err) => {
        assert.equal(err.kind, "unknown");
        assert.match(err.message, /Lien d'étiquettes Sendit invalide/);
        return true;
      },
    );
  });

  test("Lookup: exact reference match only, skips CANCELED rows, ignores non-integer keys, complete:false after 3 full pages", async () => {
    // Page with canceled, substring reference, and non-integer key
    fakeHttp.route("GET", /\/deliveries\?querystring=0612345678&page=1$/, () =>
      fakeHttp.json({
        data: {
          "0": { reference: "CMD-TARGET", status: "CANCELED", code: "SND-CANCELLED" },
          "1": { reference: "CMD-TARGET-EXTENDED", status: "DELIVERED", code: "SND-SUBSTRING" },
          "packaging_fee": 15, // Non-integer key must be ignored
          "2": { reference: "CMD-TARGET", status: "DELIVERED", code: "SND-EXACT-MATCH" },
        },
        last_page: 1,
      }),
    );

    const { provider: sendit } = setupSendit(fakeHttp);
    const lookup = await sendit.findParcelByReference("CMD-TARGET", "0612345678");
    assert.equal(lookup.complete, true);
    assert.deepEqual(lookup.parcel, {
      trackingNumber: "SND-EXACT-MATCH",
      rawStatus: "DELIVERED",
    });

    // 3 full pages exhausted without finding reference → complete: false
    fakeHttp.clearRoutes();
    fakeHttp.route("GET", /\/deliveries\?querystring=0600000000&page=\d+$/, () =>
      fakeHttp.json({
        data: [{ reference: "OTHER-REF", status: "DELIVERED", code: "SND-OTHER" }],
        last_page: 5,
      }),
    );
    const lookupMissing = await sendit.findParcelByReference("NOT-FOUND-REF", "0600000000");
    assert.equal(lookupMissing.complete, false);
    assert.equal(lookupMissing.parcel, null);
  });

  test("Tracking: status object code parsed and mapped, 429 mid-batch yields rawStatus:null, concurrency capped at 3", async () => {
    // Status object { code: "picked_up" } -> raw PICKED_UP -> normalized in_transit
    fakeHttp.route("GET", /\/deliveries\/SND-OBJ$/, () =>
      fakeHttp.json({ data: { status: { code: "picked_up" } } }),
    );
    const { provider: sendit } = setupSendit(fakeHttp);
    const trackObj = await sendit.track(["SND-OBJ"]);
    assert.equal(trackObj[0].rawStatus, "PICKED_UP");
    assert.equal(normalizeStatus(trackObj[0].rawStatus, "sendit"), "in_transit");

    // Concurrency capped at 3 requests in parallel
    fakeHttp.clearRoutes();
    fakeHttp.route("GET", /\/deliveries\/SND-BATCH-/, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return fakeHttp.json({ data: { status: "DELIVERED" } });
    });
    fakeHttp.reset();
    const batchCodes = ["SND-BATCH-1", "SND-BATCH-2", "SND-BATCH-3", "SND-BATCH-4", "SND-BATCH-5", "SND-BATCH-6"];
    await sendit.track(batchCodes);
    assert.ok(
      fakeHttp.maxInFlight <= 3,
      `Expected max in-flight <= 3, got ${fakeHttp.maxInFlight}`,
    );
    assert.ok(fakeHttp.maxInFlight >= 2, "Expected concurrent in-flight requests");

    // 429 mid-batch yields rawStatus:null for the rest
    fakeHttp.clearRoutes();
    fakeHttp.route("GET", /\/deliveries\/SND-C1$/, () =>
      fakeHttp.json({ data: { status: "DELIVERED" } }),
    );
    fakeHttp.route("GET", /\/deliveries\/SND-C2$/, () =>
      fakeHttp.json({ message: "Rate limit" }, { status: 429 }),
    );
    fakeHttp.route("GET", /\/deliveries\/SND-C3$/, () =>
      fakeHttp.json({ data: { status: "DELIVERED" } }),
    );
    fakeHttp.route("GET", /\/deliveries\/SND-C4$/, () =>
      fakeHttp.json({ data: { status: "DELIVERED" } }),
    );

    const results = await sendit.track(["SND-C1", "SND-C2", "SND-C3", "SND-C4"]);
    assert.equal(results.length, 4);
    assert.equal(results[0].trackingNumber, "SND-C1");
    assert.equal(results[0].rawStatus, "DELIVERED");
    assert.equal(results[0].found, true);

    // C2, C3, C4 all resolve with rawStatus: null and found: true
    assert.equal(results[1].trackingNumber, "SND-C2");
    assert.equal(results[1].rawStatus, null);
    assert.equal(results[1].found, true);
    assert.equal(results[2].trackingNumber, "SND-C3");
    assert.equal(results[2].rawStatus, null);
    assert.equal(results[2].found, true);
    assert.equal(results[3].trackingNumber, "SND-C4");
    assert.equal(results[3].rawStatus, null);
    assert.equal(results[3].found, true);
  });
});

describe("Ozon Courier Adapter Details", () => {
  let fakeHttp;

  beforeEach(() => {
    fakeHttp = createFakeCourierHttp();
  });

  afterEach(() => {
    fakeHttp.restoreGlobal();
  });

  test("add-parcel form fields exactly: parcel-receiver, parcel-phone, parcel-city, parcel-address, parcel-price, parcel-nature, parcel-stock=0", async () => {
    fakeHttp.route("POST", /\/add-parcel$/, () =>
      fakeHttp.json({ result: "SUCCESS", "tracking-number": "OZON-FORM-001" }),
    );
    const ozon = setupOzon(fakeHttp);
    await ozon.createParcel(standardParcelRequest);

    const call = fakeHttp.calls.find((c) => c.pathname.includes("/add-parcel"));
    assert.ok(call, "add-parcel must be called");
    const fields = call.formData;
    const expectedKeys = [
      "parcel-receiver",
      "parcel-phone",
      "parcel-city",
      "parcel-address",
      "parcel-price",
      "parcel-nature",
      "parcel-stock",
    ].sort();
    assert.deepEqual(Object.keys(fields).sort(), expectedKeys);
    assert.equal(fields["parcel-receiver"], "Karim Tazi");
    assert.equal(fields["parcel-phone"], "0612345678");
    assert.equal(fields["parcel-city"], "10");
    assert.equal(fields["parcel-address"], "42 Boulevard d'Anfa");
    assert.equal(fields["parcel-price"], "250");
    assert.equal(fields["parcel-nature"], "T-Shirt x1");
    assert.equal(fields["parcel-stock"], "0");
  });

  test("{result:'ERROR', message} without tracking number → permanent", async () => {
    fakeHttp.route("POST", /\/add-parcel$/, () =>
      fakeHttp.json({ result: "ERROR", message: "Ville introuvable dans le référentiel" }),
    );
    const ozon = setupOzon(fakeHttp);
    await assert.rejects(
      async () => ozon.createParcel(standardParcelRequest),
      (err) => {
        assert.equal(err.kind, "permanent");
        assert.match(err.message, /Ville introuvable dans le référentiel/);
        return true;
      },
    );
  });

  test("429 → retryable (unchanged)", async () => {
    fakeHttp.route("POST", /\/add-parcel$/, () =>
      fakeHttp.text("Too Many Requests", { status: 429 }),
    );
    const ozon = setupOzon(fakeHttp);
    await assert.rejects(
      async () => ozon.createParcel(standardParcelRequest),
      (err) => {
        assert.equal(err.kind, "retryable");
        return true;
      },
    );
  });

  test("Tracking parse of the TRACKING-LIST container shape", async () => {
    fakeHttp.route("POST", /\/tracking$/, () =>
      fakeHttp.json({
        "TRACKING-LIST": {
          "OZ-101": { status: "LIVRE" },
          "OZ-102": { status: "RETOUR_EXPEDITEUR" },
        },
      }),
    );
    const ozon = setupOzon(fakeHttp);
    const results = await ozon.track(["OZ-101", "OZ-102"]);
    assert.equal(results.length, 2);
    assert.equal(results[0].trackingNumber, "OZ-101");
    assert.equal(results[0].rawStatus, "LIVRE");
    assert.equal(results[0].found, true);
    assert.equal(results[1].trackingNumber, "OZ-102");
    assert.equal(results[1].rawStatus, "RETOUR_EXPEDITEUR");
    assert.equal(results[1].found, true);
  });

  test("Error text has /customers/***/*** and no raw key", async () => {
    fakeHttp.route("POST", /\/add-parcel$/, () =>
      fakeHttp.text(
        `Server crash at ${OZON_CREDS.baseUrl}/customers/${OZON_CREDS.clientId}/${OZON_CREDS.apiKey}/add-parcel with raw client ${OZON_CREDS.clientId}`,
        { status: 502 },
      ),
    );
    const ozon = setupOzon(fakeHttp);
    await assert.rejects(
      async () => ozon.createParcel(standardParcelRequest),
      (err) => {
        assert.ok(!err.message.includes(OZON_CREDS.clientId), "clientId must not appear in error");
        assert.ok(!err.message.includes(OZON_CREDS.apiKey), "apiKey must not appear in error");
        assert.match(err.message, /\/customers\/\*\*\*\/\*\*\*/);
        return true;
      },
    );
  });
});

describe("Mock Provider Details", () => {
  test("Both profiles satisfy shared contract and BL behavior adapts", async () => {
    // Sendit profile BL methods reject with permanent
    const mockSendit = createMockProvider({ profile: "sendit" });
    await assert.rejects(
      async () => mockSendit.createDeliveryNote(),
      (err) => {
        assert.equal(err.kind, "permanent");
        assert.match(err.message, /BL non pris en charge/);
        return true;
      },
    );
    await assert.rejects(
      async () => mockSendit.addParcelsToDeliveryNote("BL-1", ["CODE-1"]),
      (err) => {
        assert.equal(err.kind, "permanent");
        assert.match(err.message, /BL non pris en charge/);
        return true;
      },
    );
    await assert.rejects(
      async () => mockSendit.saveDeliveryNote("BL-1"),
      (err) => {
        assert.equal(err.kind, "permanent");
        assert.match(err.message, /BL non pris en charge/);
        return true;
      },
    );
    assert.equal(mockSendit.deliveryNotePdfUrl("BL-1", "standard"), "mock://pdf/unsupported");

    // Ozon profile BL methods succeed
    const mockOzon = createMockProvider({ profile: "ozon" });
    const note = await mockOzon.createDeliveryNote();
    assert.match(note.ref, /^BLMOCK/);
    await mockOzon.addParcelsToDeliveryNote(note.ref, ["OZ-1"]);
    await mockOzon.saveDeliveryNote(note.ref);
    assert.match(mockOzon.deliveryNotePdfUrl(note.ref, "standard"), /^mock:\/\/pdf\/standard\/BLMOCK/);
  });
});
