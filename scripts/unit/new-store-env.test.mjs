import assert from "node:assert/strict";
import test from "node:test";
import { loadSource } from "../test-source.mjs";
import { envText, envValues, PRODUCTION_ENV_HEADER } from "../new-store/env.mjs";

const { validateRuntimeEnv } = loadSource("@/lib/env");
const answers = { domain: "https://shop.example.ma", ozonClientId: "id", ozonApiKey: "key", metaPixelId: "", metaAccessToken: "", tiktokPixelId: "", tiktokAccessToken: "" };
const prod = (extra = {}) => ({ NODE_ENV: "production", ...envValues(answers, { production: true }), ...extra });

test("production example lists the trusted-IP choice and documents it", () => {
  const text = envText(envValues(answers, { production: true }), PRODUCTION_ENV_HEADER);
  assert.match(text, /^SECURITY_TRUSTED_IP_HEADER=""$/m);
  assert.match(text, /^SECURITY_ACCEPT_GLOBAL_BUDGETS=""$/m);
  assert.match(text, /OBLIGATOIRE/);
});

test("generated production env boots once the operator makes the choice", () => {
  assert.throws(() => validateRuntimeEnv(prod()), /SECURITY_TRUSTED_IP_HEADER/);
  validateRuntimeEnv(prod({ SECURITY_ACCEPT_GLOBAL_BUDGETS: "1" }));
  validateRuntimeEnv(prod({ SECURITY_TRUSTED_IP_HEADER: "x-forwarded-for" }));
});

test("dev env omits the production-only keys", () => {
  const dev = envValues(answers, { production: false });
  assert.equal(dev.DELIVERY_PROVIDER, "mock");
  assert.ok(!("SECURITY_TRUSTED_IP_HEADER" in dev) && !("SECURITY_ACCEPT_GLOBAL_BUDGETS" in dev));
});

test("omitting optional Ozon credentials falls back to mock so production boots once trusted-IP choice is made", () => {
  const noOzon = { ...answers, ozonClientId: "", ozonApiKey: "" };
  const prodNoOzon = envValues(noOzon, { production: true });
  assert.equal(prodNoOzon.DELIVERY_PROVIDER, "mock");
  validateRuntimeEnv({ NODE_ENV: "production", ...prodNoOzon, SECURITY_ACCEPT_GLOBAL_BUDGETS: "1" });
});

test("catalogAgentKey option shares catalog secret across dev and prod while isolating auth and storefront secrets", () => {
  const dev = envValues(answers, { production: false });
  const prodShared = envValues(answers, { production: true, catalogAgentKey: dev.CATALOG_AGENT_KEY });
  assert.equal(prodShared.CATALOG_AGENT_KEY, dev.CATALOG_AGENT_KEY);
  assert.notEqual(prodShared.AUTH_SECRET, dev.AUTH_SECRET);
  assert.notEqual(prodShared.STOREFRONT_API_KEY, dev.STOREFRONT_API_KEY);
});
