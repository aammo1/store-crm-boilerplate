import assert from "node:assert/strict";
import test from "node:test";
import { loadSource } from "../test-source.mjs";

const {
  validateRuntimeEnv,
  runtimeEnvWarnings,
  deliveryProviderName,
  courierProfile,
  courierNumberEnv,
} = loadSource("@/lib/env");
const { COURIERS, COURIER_NAMES, courierDefinition } = loadSource("@/lib/shipping/couriers");

const SECRET = "s3cr3t-value-that-is-definitely-long-enough-123";
const good = () => ({
  NODE_ENV: "production", AUTH_SECRET: SECRET, CRM_PUBLIC_URL: "https://crm.example.test",
  SECURITY_ALLOWED_ORIGINS: "https://crm.example.test", DELIVERY_PROVIDER: "mock", SECURITY_ACCEPT_GLOBAL_BUDGETS: "1",
});
const fails = (env, ...names) => {
  assert.throws(() => validateRuntimeEnv(env), (error) => {
    assert.match(error.message, /^Configuration invalide : /);
    for (const name of names) assert.ok(error.message.includes(name), `${name} in ${error.message}`);
    return true;
  });
};

test("courier registry exports", () => {
  assert.deepEqual(COURIER_NAMES, ["ozon", "sendit"]);
  assert.equal(courierDefinition("ozon").name, "ozon");
  assert.equal(courierDefinition("sendit").name, "sendit");
  assert.equal(COURIERS.ozon.capabilities.deliveryNotes, true);
  assert.equal(COURIERS.sendit.capabilities.deliveryNotes, false);
  assert.equal(COURIERS.sendit.capabilities.labels, true);
  assert.equal(COURIERS.sendit.capabilities.pickupDistrict, true);
});

test("development and build phase are no-ops", () => {
  validateRuntimeEnv({ NODE_ENV: "development" });
  validateRuntimeEnv({});
  validateRuntimeEnv({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" });
});

test("valid production configs pass", () => {
  validateRuntimeEnv(good());
  const rest = good(); delete rest.SECURITY_ACCEPT_GLOBAL_BUDGETS;
  validateRuntimeEnv({ ...rest, SECURITY_TRUSTED_IP_HEADER: "x-real-ip" });
  validateRuntimeEnv({ ...good(), DELIVERY_PROVIDER: "ozon", OZON_CLIENT_ID: "id", OZON_API_KEY: "key" });
  validateRuntimeEnv({
    ...good(),
    DELIVERY_PROVIDER: "sendit",
    SENDIT_PUBLIC_KEY: "pub-key",
    SENDIT_SECRET_KEY: "sec-key",
  });
});

test("each missing variable is named", () => {
  for (const name of ["AUTH_SECRET", "CRM_PUBLIC_URL", "SECURITY_ALLOWED_ORIGINS", "DELIVERY_PROVIDER"]) {
    const env = good(); delete env[name]; fails(env, name);
  }
  const env = good(); delete env.SECURITY_ACCEPT_GLOBAL_BUDGETS;
  fails(env, "SECURITY_TRUSTED_IP_HEADER", "SECURITY_ACCEPT_GLOBAL_BUDGETS");
  fails({ ...good(), SECURITY_ACCEPT_GLOBAL_BUDGETS: "0" }, "SECURITY_TRUSTED_IP_HEADER");
});

test("invalid values are rejected", () => {
  fails({ ...good(), AUTH_SECRET: "short" }, "AUTH_SECRET");
  fails({ ...good(), CRM_PUBLIC_URL: "https://crm.example.test/app" }, "CRM_PUBLIC_URL");
  fails({ ...good(), CRM_PUBLIC_URL: "ftp://x.test" }, "CRM_PUBLIC_URL");
  fails({ ...good(), SECURITY_ALLOWED_ORIGINS: "https://a.test/path" }, "SECURITY_ALLOWED_ORIGINS");
  fails({ ...good(), SECURITY_ALLOWED_ORIGINS: "https://*.a.test" }, "SECURITY_ALLOWED_ORIGINS");
  fails({ ...good(), DELIVERY_PROVIDER: "MOCK" }, "DELIVERY_PROVIDER");
  fails({ ...good(), DELIVERY_PROVIDER: "" }, "DELIVERY_PROVIDER");
});

test("ozon requires credentials", () => {
  fails({ ...good(), DELIVERY_PROVIDER: "ozon" }, "OZON_CLIENT_ID", "OZON_API_KEY");
  fails({ ...good(), DELIVERY_PROVIDER: "ozon", OZON_CLIENT_ID: "id" }, "OZON_API_KEY");
});

test("sendit requires credentials and never leaks values", () => {
  fails({ ...good(), DELIVERY_PROVIDER: "sendit" }, "SENDIT_PUBLIC_KEY", "SENDIT_SECRET_KEY");
  fails({ ...good(), DELIVERY_PROVIDER: "sendit", SENDIT_PUBLIC_KEY: "pub" }, "SENDIT_SECRET_KEY");

  const env = {
    ...good(),
    DELIVERY_PROVIDER: "sendit",
    SENDIT_PUBLIC_KEY: "leak-sendit-pubkey",
    SENDIT_SECRET_KEY: "",
  };
  assert.throws(() => validateRuntimeEnv(env), (error) => {
    assert.ok(!error.message.includes("leak-sendit-pubkey"));
    assert.ok(error.message.includes("SENDIT_SECRET_KEY"));
    return true;
  });
});

test("invalid MOCK_COURIER_PROFILE in production is reported", () => {
  fails({ ...good(), MOCK_COURIER_PROFILE: "invalid" }, "MOCK_COURIER_PROFILE");
  fails({ ...good(), MOCK_COURIER_PROFILE: "Sendit" }, "MOCK_COURIER_PROFILE");
  validateRuntimeEnv({ ...good(), MOCK_COURIER_PROFILE: "ozon" });
  validateRuntimeEnv({ ...good(), MOCK_COURIER_PROFILE: "sendit" });
});

test("errors list every problem and never leak values", () => {
  const env = { NODE_ENV: "production", AUTH_SECRET: "tiny-secret", CRM_PUBLIC_URL: "https://leak.example/secret-path",
    DELIVERY_PROVIDER: "ozon", OZON_CLIENT_ID: "", OZON_API_KEY: "" };
  assert.throws(() => validateRuntimeEnv(env), (error) => {
    for (const value of ["tiny-secret", "secret-path", "leak.example"]) assert.ok(!error.message.includes(value));
    for (const name of ["AUTH_SECRET", "CRM_PUBLIC_URL", "SECURITY_ALLOWED_ORIGINS", "OZON_CLIENT_ID", "OZON_API_KEY", "SECURITY_TRUSTED_IP_HEADER"]) {
      assert.ok(error.message.includes(name), name);
    }
    return true;
  });
});

test("warnings and provider helper", () => {
  const warnings = runtimeEnvWarnings(good());
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /Transporteur fictif \(mock\) actif en production/);
  assert.match(warnings[1], /SECURITY_ACCEPT_GLOBAL_BUDGETS/);
  assert.deepEqual(runtimeEnvWarnings({ NODE_ENV: "development", DELIVERY_PROVIDER: "mock" }), []);
  assert.equal(deliveryProviderName({ DELIVERY_PROVIDER: "mock" }), "mock");
  assert.equal(deliveryProviderName({ DELIVERY_PROVIDER: "Mock" }), "ozon");
  assert.equal(deliveryProviderName({ DELIVERY_PROVIDER: "sendit" }), "sendit");
  assert.equal(deliveryProviderName({ DELIVERY_PROVIDER: "Sendit" }), "ozon");
  assert.equal(deliveryProviderName({}), "ozon");
});

test("courierProfile helper", () => {
  assert.equal(courierProfile({ DELIVERY_PROVIDER: "mock", MOCK_COURIER_PROFILE: "sendit" }), "sendit");
  assert.equal(courierProfile({ DELIVERY_PROVIDER: "mock" }), "ozon");
  assert.equal(courierProfile({ DELIVERY_PROVIDER: "sendit" }), "sendit");
  assert.equal(courierProfile({ DELIVERY_PROVIDER: "ozon" }), "ozon");
  assert.equal(courierProfile({ DELIVERY_PROVIDER: "sendit", MOCK_COURIER_PROFILE: "ozon" }), "sendit");
  assert.equal(courierProfile({}), "ozon");
});

test("courierNumberEnv helper with fallback and priority", () => {
  assert.equal(courierNumberEnv("POLL_INTERVAL_MIN", { OZON_POLL_INTERVAL_MIN: "30" }), 30);
  assert.equal(
    courierNumberEnv("POLL_INTERVAL_MIN", {
      COURIER_POLL_INTERVAL_MIN: "15",
      OZON_POLL_INTERVAL_MIN: "30",
    }),
    15,
  );
  assert.equal(courierNumberEnv("POLL_INTERVAL_MIN", {}), undefined);
  assert.equal(courierNumberEnv("SUBMIT_INTERVAL_SEC", { COURIER_SUBMIT_INTERVAL_SEC: "10" }), 10);
  assert.equal(courierNumberEnv("TRACK_BATCH", { OZON_TRACK_BATCH: "50" }), 50);
  assert.equal(
    courierNumberEnv("POLL_INTERVAL_MIN", {
      COURIER_POLL_INTERVAL_MIN: "not-a-number",
      OZON_POLL_INTERVAL_MIN: "25",
    }),
    25,
  );
  assert.equal(
    courierNumberEnv("POLL_INTERVAL_MIN", {
      COURIER_POLL_INTERVAL_MIN: "   ",
      OZON_POLL_INTERVAL_MIN: "20",
    }),
    20,
  );
});
