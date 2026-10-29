import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadSource } from "../test-source.mjs";
import { envText, envValues, PRODUCTION_ENV_HEADER } from "../new-store/env.mjs";
import { WIZARD_COURIERS } from "../new-store/couriers.mjs";
import { collectFromFile } from "../new-store.mjs";

const { validateRuntimeEnv } = loadSource("@/lib/env");
const { COURIERS } = loadSource("@/lib/shipping/couriers");
const answers = { domain: "https://shop.example.ma", ozonClientId: "id", ozonApiKey: "key", metaPixelId: "", metaAccessToken: "", tiktokPixelId: "", tiktokAccessToken: "" };
const prod = (extra = {}) => ({ NODE_ENV: "production", ...envValues(answers, { production: true }), ...extra });

test("production example lists the trusted-IP choice and documents it", () => {
  const text = envText(envValues(answers, { production: true }), PRODUCTION_ENV_HEADER);
  assert.match(text, /^SECURITY_TRUSTED_IP_HEADER=""$/m);
  assert.match(text, /^SECURITY_ACCEPT_GLOBAL_BUDGETS=""$/m);
  assert.match(text, /OBLIGATOIRE/);
  assert.match(text, /DELIVERY_PROVIDER vaut "mock" au départ : passez-le à "ozon" ou "sendit"/);
  assert.match(text, /Sendit : choisissez ensuite le district de ramassage dans CRM → Paramètres/);
});

test("generated production env boots once the operator makes the choice", () => {
  assert.throws(() => validateRuntimeEnv(prod()), /SECURITY_TRUSTED_IP_HEADER/);
  validateRuntimeEnv(prod({ SECURITY_ACCEPT_GLOBAL_BUDGETS: "1" }));
  validateRuntimeEnv(prod({ SECURITY_TRUSTED_IP_HEADER: "x-forwarded-for" }));
});

test("dev env omits the production-only keys", () => {
  const dev = envValues(answers, { production: false });
  assert.equal(dev.DELIVERY_PROVIDER, "mock");
  assert.equal(dev.MOCK_COURIER_PROFILE, "ozon");
  assert.ok(!("SECURITY_TRUSTED_IP_HEADER" in dev) && !("SECURITY_ACCEPT_GLOBAL_BUDGETS" in dev));
});

test("omitting optional Ozon credentials falls back to mock so production boots once trusted-IP choice is made", () => {
  const noOzon = { ...answers, ozonClientId: "", ozonApiKey: "" };
  const prodNoOzon = envValues(noOzon, { production: true });
  assert.equal(prodNoOzon.DELIVERY_PROVIDER, "mock");
  assert.equal(prodNoOzon.MOCK_COURIER_PROFILE, "ozon");
  validateRuntimeEnv({ NODE_ENV: "production", ...prodNoOzon, SECURITY_ACCEPT_GLOBAL_BUDGETS: "1" });
});

test("catalogAgentKey option shares catalog secret across dev and prod while isolating auth and storefront secrets", () => {
  const dev = envValues(answers, { production: false });
  const prodShared = envValues(answers, { production: true, catalogAgentKey: dev.CATALOG_AGENT_KEY });
  assert.equal(prodShared.CATALOG_AGENT_KEY, dev.CATALOG_AGENT_KEY);
  assert.notEqual(prodShared.AUTH_SECRET, dev.AUTH_SECRET);
  assert.notEqual(prodShared.STOREFRONT_API_KEY, dev.STOREFRONT_API_KEY);
});

test("WIZARD_COURIERS mirrors the courier registry names, labels, and requiredEnv", () => {
  const wizardKeys = Object.keys(WIZARD_COURIERS).sort();
  const registryKeys = Object.keys(COURIERS).sort();
  assert.deepEqual(wizardKeys, registryKeys);
  for (const name of wizardKeys) {
    assert.equal(WIZARD_COURIERS[name].label, COURIERS[name].label);
    assert.deepEqual(WIZARD_COURIERS[name].requiredEnv, COURIERS[name].requiredEnv);
  }
});

test("Ozon with credentials configures ozon for prod and mock for dev with profile ozon", () => {
  const ozonAnswers = {
    ...answers,
    courier: "ozon",
    ozonClientId: "client_id",
    ozonApiKey: "api_key",
  };
  const dev = envValues(ozonAnswers, { production: false });
  assert.equal(dev.DELIVERY_PROVIDER, "mock");
  assert.equal(dev.MOCK_COURIER_PROFILE, "ozon");
  assert.equal(dev.OZON_CLIENT_ID, "client_id");
  assert.equal(dev.OZON_API_KEY, "api_key");
  assert.equal(dev.OZON_BASE_URL, "https://api.ozonexpress.ma");
  assert.ok(!("SENDIT_PUBLIC_KEY" in dev));
  assert.ok(!("SENDIT_SECRET_KEY" in dev));

  const p = envValues(ozonAnswers, { production: true });
  assert.equal(p.DELIVERY_PROVIDER, "ozon");
  assert.equal(p.MOCK_COURIER_PROFILE, "ozon");
  assert.equal(p.OZON_CLIENT_ID, "client_id");
  assert.equal(p.OZON_API_KEY, "api_key");
  assert.equal(p.OZON_BASE_URL, "https://api.ozonexpress.ma");
  assert.ok(!("SENDIT_PUBLIC_KEY" in p));
  assert.ok(!("SENDIT_SECRET_KEY" in p));
  validateRuntimeEnv({ NODE_ENV: "production", ...p, SECURITY_ACCEPT_GLOBAL_BUDGETS: "1" });
});

test("Sendit courier without keys falls back to mock in prod; with keys configures sendit; omits OZON_*", () => {
  const senditNoKeys = {
    ...answers,
    courier: "sendit",
    senditPublicKey: "",
    senditSecretKey: "",
  };
  const prodNoKeys = envValues(senditNoKeys, { production: true });
  assert.equal(prodNoKeys.DELIVERY_PROVIDER, "mock");
  assert.equal(prodNoKeys.MOCK_COURIER_PROFILE, "sendit");
  assert.equal(prodNoKeys.SENDIT_PUBLIC_KEY, "");
  assert.equal(prodNoKeys.SENDIT_SECRET_KEY, "");
  assert.ok(!("OZON_CLIENT_ID" in prodNoKeys));
  assert.ok(!("OZON_API_KEY" in prodNoKeys));
  assert.ok(!("OZON_BASE_URL" in prodNoKeys));
  validateRuntimeEnv({ NODE_ENV: "production", ...prodNoKeys, SECURITY_ACCEPT_GLOBAL_BUDGETS: "1" });

  const senditWithKeys = {
    ...answers,
    courier: "sendit",
    senditPublicKey: "sendit_pub",
    senditSecretKey: "sendit_sec",
  };
  const devWithKeys = envValues(senditWithKeys, { production: false });
  assert.equal(devWithKeys.DELIVERY_PROVIDER, "mock");
  assert.equal(devWithKeys.MOCK_COURIER_PROFILE, "sendit");
  assert.equal(devWithKeys.SENDIT_PUBLIC_KEY, "sendit_pub");
  assert.equal(devWithKeys.SENDIT_SECRET_KEY, "sendit_sec");
  assert.ok(!("OZON_CLIENT_ID" in devWithKeys));
  assert.ok(!("OZON_API_KEY" in devWithKeys));
  assert.ok(!("OZON_BASE_URL" in devWithKeys));

  const prodWithKeys = envValues(senditWithKeys, { production: true });
  assert.equal(prodWithKeys.DELIVERY_PROVIDER, "sendit");
  assert.equal(prodWithKeys.MOCK_COURIER_PROFILE, "sendit");
  assert.equal(prodWithKeys.SENDIT_PUBLIC_KEY, "sendit_pub");
  assert.equal(prodWithKeys.SENDIT_SECRET_KEY, "sendit_sec");
  assert.ok(!("OZON_CLIENT_ID" in prodWithKeys));
  assert.ok(!("OZON_API_KEY" in prodWithKeys));
  assert.ok(!("OZON_BASE_URL" in prodWithKeys));
  validateRuntimeEnv({ NODE_ENV: "production", ...prodWithKeys, SECURITY_ACCEPT_GLOBAL_BUDGETS: "1" });
});

test("missing courier field defaults to ozon behavior", () => {
  const missingCourier = {
    domain: "https://shop.example.ma",
    ozonClientId: "id",
    ozonApiKey: "key",
    metaPixelId: "",
    metaAccessToken: "",
    tiktokPixelId: "",
    tiktokAccessToken: "",
  };
  const dev = envValues(missingCourier, { production: false });
  assert.equal(dev.DELIVERY_PROVIDER, "mock");
  assert.equal(dev.MOCK_COURIER_PROFILE, "ozon");
  assert.equal(dev.OZON_CLIENT_ID, "id");
  assert.ok(!("SENDIT_PUBLIC_KEY" in dev));

  const p = envValues(missingCourier, { production: true });
  assert.equal(p.DELIVERY_PROVIDER, "ozon");
  assert.equal(p.MOCK_COURIER_PROFILE, "ozon");
  assert.equal(p.OZON_CLIENT_ID, "id");
  assert.ok(!("SENDIT_PUBLIC_KEY" in p));
});

test("collectFromFile handles examples/new-store-answers.json and backward compatibility", () => {
  const answersPath = path.resolve("examples/new-store-answers.json");
  const collected = collectFromFile(answersPath, true);
  assert.equal(collected.courier, "ozon");
  assert.equal(collected.ozonClientId, "");
  assert.equal(collected.senditPublicKey, "");

  // Backward compatibility: old answer file without courier key
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "new-store-test-"));
  try {
    const rawAnswers = JSON.parse(fs.readFileSync(answersPath, "utf8"));
    delete rawAnswers.courier;
    delete rawAnswers.senditPublicKey;
    delete rawAnswers.senditSecretKey;
    rawAnswers.ozonClientId = "legacy_id";
    const oldFilePath = path.join(tempDir, "old-answers.json");
    fs.writeFileSync(oldFilePath, JSON.stringify(rawAnswers));

    const oldCollected = collectFromFile(oldFilePath, true);
    assert.equal(oldCollected.courier, "ozon");
    assert.equal(oldCollected.ozonClientId, "legacy_id");
    assert.equal(oldCollected.senditPublicKey, "");

    // Answer file specifying sendit ignores provided ozon keys
    rawAnswers.courier = "sendit";
    rawAnswers.ozonClientId = "should_be_ignored";
    rawAnswers.senditPublicKey = "sendit_key";
    const senditFilePath = path.join(tempDir, "sendit-answers.json");
    fs.writeFileSync(senditFilePath, JSON.stringify(rawAnswers));

    const senditCollected = collectFromFile(senditFilePath, true);
    assert.equal(senditCollected.courier, "sendit");
    assert.equal(senditCollected.ozonClientId, "");
    assert.equal(senditCollected.senditPublicKey, "sendit_key");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
