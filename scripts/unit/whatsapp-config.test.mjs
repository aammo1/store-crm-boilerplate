import assert from "node:assert/strict";
import test from "node:test";
import { loadSource } from "../test-source.mjs";

const {
  WA_DEFAULT_MODELS,
  evolutionConfig,
  webhookSecret,
  whatsappConfigured,
  whatsappAiConfigured,
  whatsappModels,
  whatsappEnvIssues,
} = loadSource("@/lib/whatsapp/config");

const { validateRuntimeEnv, runtimeEnvWarnings } = loadSource("@/lib/env");

const VALID_SECRET = "012345678901234567890123456789012"; // 33 chars >= 32
const BASE_PROD_ENV = {
  NODE_ENV: "production",
  AUTH_SECRET: "auth-secret-that-is-at-least-32-chars-long",
  CRM_PUBLIC_URL: "https://crm.example.test",
  SECURITY_ALLOWED_ORIGINS: "https://crm.example.test",
  DELIVERY_PROVIDER: "mock",
  SECURITY_ACCEPT_GLOBAL_BUDGETS: "1",
};

test("default models are defined and constant", () => {
  assert.equal(WA_DEFAULT_MODELS.chat, "z-ai/glm-5.3-flash");
  assert.equal(WA_DEFAULT_MODELS.chatFallback, "deepseek/deepseek-v4.1-flash");
  assert.equal(WA_DEFAULT_MODELS.audio, "google/gemini-2.5-flash-lite");
  assert.equal(WA_DEFAULT_MODELS.audioFallback, "qwen/qwen3.8-omni-flash");
});

test("evolutionConfig returns null when unconfigured or partial", () => {
  assert.equal(evolutionConfig({}), null);
  assert.equal(evolutionConfig({ EVOLUTION_BASE_URL: "https://evo.example.test" }), null);
  assert.equal(
    evolutionConfig({
      EVOLUTION_BASE_URL: "https://evo.example.test",
      EVOLUTION_INSTANCE: "inst",
    }),
    null,
  );
  assert.equal(
    evolutionConfig({
      EVOLUTION_INSTANCE: "inst",
      EVOLUTION_API_KEY: "key",
    }),
    null,
  );
  assert.equal(
    evolutionConfig({
      EVOLUTION_BASE_URL: "   ",
      EVOLUTION_INSTANCE: "inst",
      EVOLUTION_API_KEY: "key",
    }),
    null,
  );
});

test("evolutionConfig parses valid URLs, strips trailing slashes, and rejects invalid URLs", () => {
  const valid = evolutionConfig({
    EVOLUTION_BASE_URL: "https://evo.example.test:8443/",
    EVOLUTION_INSTANCE: " main-store ",
    EVOLUTION_API_KEY: " secret-api-key ",
  });
  assert.deepEqual(valid, {
    baseUrl: "https://evo.example.test:8443",
    instance: "main-store",
    apiKey: "secret-api-key",
  });

  const withSubpath = evolutionConfig({
    EVOLUTION_BASE_URL: "http://evolution:8080/api/v2///",
    EVOLUTION_INSTANCE: "inst",
    EVOLUTION_API_KEY: "key",
  });
  assert.equal(withSubpath?.baseUrl, "http://evolution:8080/api/v2");

  // Rejections
  assert.equal(
    evolutionConfig({
      EVOLUTION_BASE_URL: "ftp://evo.example.test",
      EVOLUTION_INSTANCE: "inst",
      EVOLUTION_API_KEY: "key",
    }),
    null,
  );
  assert.equal(
    evolutionConfig({
      EVOLUTION_BASE_URL: "https://user:pass@evo.example.test",
      EVOLUTION_INSTANCE: "inst",
      EVOLUTION_API_KEY: "key",
    }),
    null,
  );
  assert.equal(
    evolutionConfig({
      EVOLUTION_BASE_URL: "https://evo.example.test?token=123",
      EVOLUTION_INSTANCE: "inst",
      EVOLUTION_API_KEY: "key",
    }),
    null,
  );
  assert.equal(
    evolutionConfig({
      EVOLUTION_BASE_URL: "https://evo.example.test#section",
      EVOLUTION_INSTANCE: "inst",
      EVOLUTION_API_KEY: "key",
    }),
    null,
  );
  assert.equal(
    evolutionConfig({
      EVOLUTION_BASE_URL: "not-a-valid-url",
      EVOLUTION_INSTANCE: "inst",
      EVOLUTION_API_KEY: "key",
    }),
    null,
  );
});

test("webhookSecret enforces minimum 32 chars", () => {
  assert.equal(webhookSecret({}), null);
  assert.equal(webhookSecret({ WHATSAPP_WEBHOOK_SECRET: "" }), null);
  assert.equal(webhookSecret({ WHATSAPP_WEBHOOK_SECRET: "short-secret" }), null);
  assert.equal(webhookSecret({ WHATSAPP_WEBHOOK_SECRET: "1234567890123456789012345678901" }), null); // 31 chars
  assert.equal(
    webhookSecret({ WHATSAPP_WEBHOOK_SECRET: "12345678901234567890123456789012" }), // 32 chars
    "12345678901234567890123456789012",
  );
  assert.equal(
    webhookSecret({ WHATSAPP_WEBHOOK_SECRET: "  12345678901234567890123456789012  " }),
    "12345678901234567890123456789012",
  );
});

test("whatsappConfigured and whatsappAiConfigured helper booleans", () => {
  const evoEnv = {
    EVOLUTION_BASE_URL: "https://evo.example.test",
    EVOLUTION_INSTANCE: "inst",
    EVOLUTION_API_KEY: "key",
  };
  assert.equal(whatsappConfigured({}), false);
  assert.equal(whatsappConfigured(evoEnv), false); // missing secret
  assert.equal(whatsappConfigured({ ...evoEnv, WHATSAPP_WEBHOOK_SECRET: VALID_SECRET }), true);

  assert.equal(whatsappAiConfigured({}), false);
  assert.equal(whatsappAiConfigured({ OPENROUTER_API_KEY: "sk-test" }), false); // Evolution not configured
  assert.equal(whatsappAiConfigured({ ...evoEnv, WHATSAPP_WEBHOOK_SECRET: VALID_SECRET }), false); // No OpenRouter
  assert.equal(
    whatsappAiConfigured({
      ...evoEnv,
      WHATSAPP_WEBHOOK_SECRET: VALID_SECRET,
      OPENROUTER_API_KEY: "sk-or-test",
    }),
    true,
  );
});

test("whatsappModels override validation and defaults", () => {
  const defaults = whatsappModels({});
  assert.deepEqual(defaults, WA_DEFAULT_MODELS);

  // Valid overrides
  const overridden = whatsappModels({
    WHATSAPP_CHAT_MODEL: " openai/gpt-4o-mini ",
    WHATSAPP_CHAT_FALLBACK_MODEL: "anthropic/claude-3-haiku",
    WHATSAPP_AUDIO_MODEL: "google/gemini-pro:free",
    WHATSAPP_AUDIO_FALLBACK_MODEL: "meta-llama/llama-3.2-3b",
  });
  assert.equal(overridden.chat, "openai/gpt-4o-mini");
  assert.equal(overridden.chatFallback, "anthropic/claude-3-haiku");
  assert.equal(overridden.audio, "google/gemini-pro:free");
  assert.equal(overridden.audioFallback, "meta-llama/llama-3.2-3b");

  // Invalid formats fall back to defaults
  const invalid = whatsappModels({
    WHATSAPP_CHAT_MODEL: "invalid-no-slash",
    WHATSAPP_CHAT_FALLBACK_MODEL: "/missing-provider",
    WHATSAPP_AUDIO_MODEL: "missing-model/",
    WHATSAPP_AUDIO_FALLBACK_MODEL: "has spaces/model",
  });
  assert.deepEqual(invalid, WA_DEFAULT_MODELS);
});

test("whatsappEnvIssues: inert when no EVOLUTION_* var is set", () => {
  const issues = whatsappEnvIssues({});
  assert.deepEqual(issues.problems, []);
  assert.deepEqual(issues.warnings, []);

  // Even if other unrelated or auxiliary keys are present without Evolution
  const issuesAux = whatsappEnvIssues({
    WHATSAPP_WEBHOOK_SECRET: "short",
    OPENROUTER_API_KEY: "key",
  });
  assert.deepEqual(issuesAux.problems, []);
  assert.deepEqual(issuesAux.warnings, []);
});

test("whatsappEnvIssues: partial config produces warning", () => {
  const p1 = whatsappEnvIssues({ EVOLUTION_BASE_URL: "https://evo.example.test" });
  assert.deepEqual(p1.problems, []);
  assert.equal(p1.warnings.length, 1);
  assert.match(p1.warnings[0], /WhatsApp désactivé : EVOLUTION_BASE_URL, EVOLUTION_INSTANCE et EVOLUTION_API_KEY/);

  const p2 = whatsappEnvIssues({
    EVOLUTION_INSTANCE: "inst",
    EVOLUTION_API_KEY: "key",
  });
  assert.deepEqual(p2.problems, []);
  assert.equal(p2.warnings.length, 1);
  assert.match(p2.warnings[0], /WhatsApp désactivé/);
});

test("whatsappEnvIssues: malformed EVOLUTION_BASE_URL reports problem", () => {
  const malformed = whatsappEnvIssues({
    EVOLUTION_BASE_URL: "not-a-url",
    EVOLUTION_INSTANCE: "inst",
    EVOLUTION_API_KEY: "key",
    WHATSAPP_WEBHOOK_SECRET: VALID_SECRET,
  });
  assert.ok(malformed.problems.includes("EVOLUTION_BASE_URL invalide"));

  const ftpUrl = whatsappEnvIssues({
    EVOLUTION_BASE_URL: "ftp://example.test",
    EVOLUTION_INSTANCE: "inst",
    EVOLUTION_API_KEY: "key",
    WHATSAPP_WEBHOOK_SECRET: VALID_SECRET,
  });
  assert.ok(ftpUrl.problems.includes("EVOLUTION_BASE_URL invalide"));
});

test("whatsappEnvIssues: plain HTTP to public host warns", () => {
  // Public FQDN on plain HTTP -> warning
  const pub = whatsappEnvIssues({
    EVOLUTION_BASE_URL: "http://evo.example.com",
    EVOLUTION_INSTANCE: "inst",
    EVOLUTION_API_KEY: "key",
    WHATSAPP_WEBHOOK_SECRET: VALID_SECRET,
    OPENROUTER_API_KEY: "sk-or-test",
  });
  assert.deepEqual(pub.problems, []);
  assert.equal(pub.warnings.length, 1);
  assert.match(pub.warnings[0], /EVOLUTION_BASE_URL utilise HTTP vers un hôte public/);

  // Public IPv4 on plain HTTP -> warning
  const pubIp = whatsappEnvIssues({
    EVOLUTION_BASE_URL: "http://51.15.20.10:8080",
    EVOLUTION_INSTANCE: "inst",
    EVOLUTION_API_KEY: "key",
    WHATSAPP_WEBHOOK_SECRET: VALID_SECRET,
    OPENROUTER_API_KEY: "sk-or-test",
  });
  assert.equal(pubIp.warnings.length, 1);
  assert.match(pubIp.warnings[0], /EVOLUTION_BASE_URL utilise HTTP vers un hôte public/);

  // Private hosts / IPs on plain HTTP -> no warning
  for (const url of [
    "http://localhost:8080",
    "http://evolution:8080",
    "http://127.0.0.1:8080",
    "http://10.0.1.50:8080",
    "http://172.20.0.5:8080",
    "http://192.168.1.10:8080",
    "http://evo.coolify.internal:8080",
    "http://evo.server.local:8080",
    "https://evo.example.com",
  ]) {
    const res = whatsappEnvIssues({
      EVOLUTION_BASE_URL: url,
      EVOLUTION_INSTANCE: "inst",
      EVOLUTION_API_KEY: "key",
      WHATSAPP_WEBHOOK_SECRET: VALID_SECRET,
      OPENROUTER_API_KEY: "sk-or-test",
    });
    assert.deepEqual(res.problems, [], `failed for ${url}`);
    assert.deepEqual(res.warnings, [], `failed for ${url}`);
  }
});

test("whatsappEnvIssues: missing or short WHATSAPP_WEBHOOK_SECRET when Evolution configured", () => {
  const missingSecret = whatsappEnvIssues({
    EVOLUTION_BASE_URL: "https://evo.example.test",
    EVOLUTION_INSTANCE: "inst",
    EVOLUTION_API_KEY: "key",
  });
  assert.ok(missingSecret.problems.includes("WHATSAPP_WEBHOOK_SECRET doit contenir au moins 32 caractères"));

  const shortSecret = whatsappEnvIssues({
    EVOLUTION_BASE_URL: "https://evo.example.test",
    EVOLUTION_INSTANCE: "inst",
    EVOLUTION_API_KEY: "key",
    WHATSAPP_WEBHOOK_SECRET: "too-short",
  });
  assert.ok(shortSecret.problems.includes("WHATSAPP_WEBHOOK_SECRET doit contenir au moins 32 caractères"));
});

test("whatsappEnvIssues: missing OPENROUTER_API_KEY warns AI disabled", () => {
  const issues = whatsappEnvIssues({
    EVOLUTION_BASE_URL: "https://evo.example.test",
    EVOLUTION_INSTANCE: "inst",
    EVOLUTION_API_KEY: "key",
    WHATSAPP_WEBHOOK_SECRET: VALID_SECRET,
  });
  assert.deepEqual(issues.problems, []);
  assert.equal(issues.warnings.length, 1);
  assert.match(issues.warnings[0], /OPENROUTER_API_KEY manquant/);
});

test("whatsappEnvIssues: secret values are NEVER leaked in error or warning messages", () => {
  const LEAK_API_KEY = "evo_api_key_sensitive_12345";
  const LEAK_SECRET = "tiny-secret-short";
  const LEAK_INSTANCE = "my-secret-instance-name";
  const LEAK_URL_TOKEN = "token_in_url_sensitive";

  const issues = whatsappEnvIssues({
    EVOLUTION_BASE_URL: `ftp://malformed.test/${LEAK_URL_TOKEN}`,
    EVOLUTION_INSTANCE: LEAK_INSTANCE,
    EVOLUTION_API_KEY: LEAK_API_KEY,
    WHATSAPP_WEBHOOK_SECRET: LEAK_SECRET,
  });

  const allMessages = [...issues.problems, ...issues.warnings].join(" ");
  for (const leak of [LEAK_API_KEY, LEAK_SECRET, LEAK_INSTANCE, LEAK_URL_TOKEN]) {
    assert.ok(!allMessages.includes(leak), `leaked sensitive string: ${leak}`);
  }
});

test("validateRuntimeEnv and runtimeEnvWarnings integration with WhatsApp", () => {
  // 1. With no WhatsApp env set, validateRuntimeEnv and runtimeEnvWarnings behave exactly as before
  validateRuntimeEnv(BASE_PROD_ENV);
  const baseWarnings = runtimeEnvWarnings(BASE_PROD_ENV);
  assert.ok(baseWarnings.some((w) => w.includes("Transporteur fictif")));

  // 2. In production, WhatsApp problems cause validateRuntimeEnv to throw
  assert.throws(
    () =>
      validateRuntimeEnv({
        ...BASE_PROD_ENV,
        EVOLUTION_BASE_URL: "not-a-url",
        EVOLUTION_INSTANCE: "inst",
        EVOLUTION_API_KEY: "key",
      }),
    (err) => {
      assert.match(err.message, /Configuration invalide : /);
      assert.ok(err.message.includes("EVOLUTION_BASE_URL invalide"));
      assert.ok(err.message.includes("WHATSAPP_WEBHOOK_SECRET doit contenir au moins 32 caractères"));
      return true;
    },
  );

  // 3. Partial config produces a warning in runtimeEnvWarnings
  const partialWarnings = runtimeEnvWarnings({
    ...BASE_PROD_ENV,
    EVOLUTION_BASE_URL: "https://evo.example.test",
  });
  assert.ok(partialWarnings.some((w) => w.includes("WhatsApp désactivé")));

  // 4. Missing OPENROUTER_API_KEY produces an AI disabled warning
  const missingAiWarnings = runtimeEnvWarnings({
    ...BASE_PROD_ENV,
    EVOLUTION_BASE_URL: "https://evo.example.test",
    EVOLUTION_INSTANCE: "inst",
    EVOLUTION_API_KEY: "key",
    WHATSAPP_WEBHOOK_SECRET: VALID_SECRET,
  });
  assert.ok(missingAiWarnings.some((w) => w.includes("OPENROUTER_API_KEY manquant")));

  // 5. Valid full configuration passes without WhatsApp errors or warnings
  validateRuntimeEnv({
    ...BASE_PROD_ENV,
    EVOLUTION_BASE_URL: "https://evo.example.test",
    EVOLUTION_INSTANCE: "inst",
    EVOLUTION_API_KEY: "key",
    WHATSAPP_WEBHOOK_SECRET: VALID_SECRET,
    OPENROUTER_API_KEY: "sk-or-test",
  });
  const fullWarnings = runtimeEnvWarnings({
    ...BASE_PROD_ENV,
    EVOLUTION_BASE_URL: "https://evo.example.test",
    EVOLUTION_INSTANCE: "inst",
    EVOLUTION_API_KEY: "key",
    WHATSAPP_WEBHOOK_SECRET: VALID_SECRET,
    OPENROUTER_API_KEY: "sk-or-test",
  });
  // No WhatsApp warnings should be present
  assert.ok(!fullWarnings.some((w) => w.includes("WhatsApp") || w.includes("OPENROUTER")));
});
