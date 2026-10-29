import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { loadSource } from "../test-source.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-ai-"));
process.env.DELIVERY_PROVIDER = "mock";
process.env.DB_PATH = path.join(dir, "crm.db");
process.env.AUTH_SECRET = "x".repeat(40);
process.env.CRM_PUBLIC_URL = "https://crm.example.test";
process.env.SECURITY_ALLOWED_ORIGINS = "https://crm.example.test";
process.env.EVOLUTION_BASE_URL = "http://evolution.internal:8080";
process.env.EVOLUTION_INSTANCE = "test-instance";
process.env.EVOLUTION_API_KEY = "evolution-ephemeral-key";
process.env.WHATSAPP_WEBHOOK_SECRET = "w".repeat(40);
process.env.OPENROUTER_API_KEY = "or-ephemeral-test-key-1234567890";

const originalLoad = Module._load;
Module._load = function (name, ...args) {
  return name === "server-only" ? {} : originalLoad.call(this, name, ...args);
};

const { getDb } = loadSource("@/lib/db");
const settings = loadSource("@/lib/services/whatsapp-settings");
const usage = loadSource("@/lib/services/whatsapp-ai-usage");
const provider = loadSource("@/lib/whatsapp/ai/provider");
const transcribe = loadSource("@/lib/whatsapp/ai/transcribe");
const classify = loadSource("@/lib/whatsapp/ai/classify");
const db = getDb();

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const CHAT_MODEL = "z-ai/glm-5.3-flash";
const CHAT_FALLBACK = "deepseek/deepseek-v4.1-flash";
const AUDIO_MODEL = "google/gemini-2.5-flash-lite";
const AUDIO_FALLBACK = "qwen/qwen3.8-omni-flash";

// ---------------------------------------------------------------------------
// fetch stub: each queued handler answers one call; extra calls fail loudly.
// ---------------------------------------------------------------------------
let fetchCalls = [];
let fetchQueue = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init });
  const handler = fetchQueue.shift();
  if (!handler) throw new Error("Stub fetch: appel OpenRouter inattendu");
  return handler(url, init);
};

const jsonOk = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

const chatCompletion = (model, content, usageExtra = {}) =>
  jsonOk({
    id: "gen_test",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, ...usageExtra },
  });

const httpError = (status, message = "boom") =>
  jsonOk({ error: { message } }, status);

const requestBody = (call) => JSON.parse(call.init.body);

function clearUsage() {
  db.prepare("DELETE FROM wa_ai_usage").run();
}

function lastUsageRow() {
  return db
    .prepare("SELECT * FROM wa_ai_usage ORDER BY created_at DESC, id DESC LIMIT 1")
    .get();
}

function usageRowCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM wa_ai_usage").get().n;
}

function spendBudgetFully() {
  usage.recordAiUsage({
    role: "chat",
    model: CHAT_MODEL,
    inputTokens: 0,
    outputTokens: 0,
    costMicroUsd: 100 * 10_000, // exactly the 100-cent daily cap
  });
}

function enableAi(extra = {}) {
  settings.updateWhatsAppSettings({ enabled: true, aiEnabled: true, aiDailyBudgetCents: 100, ...extra });
}

after(() => {
  globalThis.fetch = originalFetch;
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fetchCalls = [];
  fetchQueue = [];
  clearUsage();
  enableAi();
});

// ---------------------------------------------------------------------------

test("aiBudgetAvailable requires config, toggles, budget and free spend", () => {
  assert.equal(usage.aiBudgetAvailable(), true);

  settings.updateWhatsAppSettings({ enabled: false });
  assert.equal(usage.aiBudgetAvailable(), false);
  settings.updateWhatsAppSettings({ enabled: true, aiEnabled: false });
  assert.equal(usage.aiBudgetAvailable(), false);
  settings.updateWhatsAppSettings({ enabled: true, aiEnabled: true, aiDailyBudgetCents: 0 });
  assert.equal(usage.aiBudgetAvailable(), false);
  settings.updateWhatsAppSettings({ aiDailyBudgetCents: 100 });
  assert.equal(usage.aiBudgetAvailable(), true);

  const originalKey = process.env.OPENROUTER_API_KEY;
  try {
    delete process.env.OPENROUTER_API_KEY;
    assert.equal(usage.aiBudgetAvailable(), false);
  } finally {
    process.env.OPENROUTER_API_KEY = originalKey;
  }
  assert.equal(usage.aiBudgetAvailable(), true);

  // Spend up to (not including) the cap: still available. At the cap: refused.
  usage.recordAiUsage({ role: "chat", model: CHAT_MODEL, inputTokens: 0, outputTokens: 0, costMicroUsd: 999_999 });
  assert.equal(usage.aiBudgetAvailable(), true);
  usage.recordAiUsage({ role: "chat", model: CHAT_MODEL, inputTokens: 0, outputTokens: 0, costMicroUsd: 1 });
  assert.equal(usage.aiBudgetAvailable(), false);
  assert.equal(usage.todayAiSpendMicroUsd(), 1_000_000);
});

test("cost math: per-1M prices give micro-USD, usage.cost wins, unknown price is conservative", () => {
  assert.equal(usage.calculateCostMicroUsd(CHAT_MODEL, 1_000_000, 1_000_000), 120_000);
  assert.equal(usage.calculateCostMicroUsd(CHAT_MODEL, 500, 50), Math.round(500 * 0.046 + 50 * 0.074));
  // OpenRouter usage.cost (USD) is preferred: 0.5 USD -> 500,000 micro-USD.
  assert.equal(usage.calculateCostMicroUsd(CHAT_MODEL, 1_000_000, 1_000_000, 0.5), 500_000);
  assert.equal(usage.calculateCostMicroUsd(CHAT_MODEL, 100, 20, 0.0000123), 12);
  assert.equal(usage.calculateCostMicroUsd("unknown/model", 1_000_000, 1_000_000), 5_000_000);
  // 1 USD cent = 10,000 micro-USD.
  assert.equal(usage.UNKNOWN_PRICE.in, 1);
  assert.equal(usage.MODEL_PRICES[CHAT_MODEL].in, 0.046);
});

test("withFallback: primary 500 then fallback succeeds, fallback model returned", async () => {
  const run = async (modelId) => {
    const res = await fetch(OPENROUTER_URL, { method: "POST", body: JSON.stringify({ model: modelId }) });
    if (!res.ok) throw new transcribe.OpenRouterHttpError(res.status, await res.text());
    return (await res.json()).model;
  };

  fetchQueue.push(
    () => httpError(500, "primary down"),
    () => jsonOk({ model: CHAT_FALLBACK }),
  );

  const { result, model } = await provider.withFallback(CHAT_MODEL, CHAT_FALLBACK, run);
  assert.equal(result, CHAT_FALLBACK);
  assert.equal(model, CHAT_FALLBACK);
  assert.equal(fetchCalls.length, 2);
  assert.equal(requestBody(fetchCalls[0]).model, CHAT_MODEL);
  assert.equal(requestBody(fetchCalls[1]).model, CHAT_FALLBACK);
});

test("withFallback: 401 throws AiUnavailableError(auth) without trying the fallback", async () => {
  const secret = process.env.OPENROUTER_API_KEY;
  const run = async (modelId) => {
    const res = await fetch(OPENROUTER_URL, { method: "POST", body: JSON.stringify({ model: modelId }) });
    if (!res.ok) throw new transcribe.OpenRouterHttpError(res.status, await res.text());
    return res.json();
  };

  fetchQueue.push(
    () => httpError(401, `Invalid key ${secret}`),
    () => httpError(401, `Invalid key ${secret}`),
  );

  const first = await provider.withFallback(CHAT_MODEL, CHAT_FALLBACK, run).then(
    () => null,
    (err) => err,
  );
  assert.ok(first instanceof provider.AiUnavailableError);
  assert.equal(first.reason, "auth");
  assert.equal(fetchCalls.length, 1); // no fallback attempt after a 401

  // The key never leaks into the error.
  const second = await provider.withFallback(CHAT_MODEL, CHAT_FALLBACK, run).then(
    () => null,
    (err) => err,
  );
  assert.ok(second instanceof provider.AiUnavailableError);
  assert.ok(!second.message.includes(secret));
  assert.ok(second.message.includes("[REDACTED]"));
});

test("withFallback: 402 throws AiUnavailableError(credits) without retry", async () => {
  fetchQueue.push(() => httpError(402, "Insufficient credits"));

  const run = async (modelId) => {
    const res = await fetch(OPENROUTER_URL, { method: "POST", body: JSON.stringify({ model: modelId }) });
    if (!res.ok) throw new transcribe.OpenRouterHttpError(res.status, await res.text());
    return res.json();
  };

  await assert.rejects(
    provider.withFallback(CHAT_MODEL, CHAT_FALLBACK, run),
    (err) => err instanceof provider.AiUnavailableError && err.reason === "credits",
  );
  assert.equal(fetchCalls.length, 1);
});

test("withFallback: non-retryable 400 fails fast; 429 retries the fallback", async () => {
  const run = async (modelId) => {
    const res = await fetch(OPENROUTER_URL, { method: "POST", body: JSON.stringify({ model: modelId }) });
    if (!res.ok) throw new transcribe.OpenRouterHttpError(res.status, await res.text());
    return (await res.json()).model;
  };

  fetchQueue.push(() => httpError(400, "bad request"));
  await assert.rejects(provider.withFallback(CHAT_MODEL, CHAT_FALLBACK, run), /HTTP 400/);
  assert.equal(fetchCalls.length, 1);

  fetchCalls = [];
  fetchQueue.push(
    () => httpError(429, "rate limited"),
    () => jsonOk({ model: CHAT_FALLBACK }),
  );
  const { model } = await provider.withFallback(CHAT_MODEL, CHAT_FALLBACK, run);
  assert.equal(model, CHAT_FALLBACK);
  assert.equal(fetchCalls.length, 2);
});

test("sanitizeErrorText redacts the API key", () => {
  const secret = process.env.OPENROUTER_API_KEY;
  assert.equal(provider.sanitizeErrorText(`oops ${secret} leaked`), "oops [REDACTED] leaked");
  assert.equal(provider.sanitizeErrorText("nothing to hide"), "nothing to hide");
});

test("transcribeAudio: cache hit returns without any fetch or budget use", async () => {
  spendBudgetFully();
  usage.putCachedMedia({ sha256: "sha-cache-hit", transcript: "salam khoya", language: "darija_latin" });

  const out = await transcribe.transcribeAudio({
    bytes: Buffer.from("fake-ogg"),
    mimetype: "audio/ogg; codecs=opus",
    sha256: "sha-cache-hit",
    conversationId: "conv-1",
  });

  assert.deepEqual(out, { transcript: "salam khoya", language: "darija_latin", cached: true });
  assert.equal(fetchCalls.length, 0);
});

test("transcribeAudio: unsupported format or empty bytes are rejected without a fetch", async () => {
  await assert.rejects(
    transcribe.transcribeAudio({
      bytes: Buffer.from("x"),
      mimetype: "audio/flac",
      sha256: "sha-flac",
      conversationId: "conv-1",
    }),
    (err) => err instanceof transcribe.AiUnsupportedAudioError,
  );
  await assert.rejects(
    transcribe.transcribeAudio({
      bytes: Buffer.from("x"),
      mimetype: "video/mp4",
      sha256: "sha-video",
      conversationId: "conv-1",
    }),
    (err) => err instanceof transcribe.AiUnsupportedAudioError,
  );
  await assert.rejects(
    transcribe.transcribeAudio({
      bytes: Buffer.alloc(0),
      mimetype: "audio/ogg; codecs=opus",
      sha256: "sha-empty",
      conversationId: "conv-1",
    }),
    (err) => err instanceof transcribe.AiUnsupportedAudioError,
  );
  assert.equal(fetchCalls.length, 0);
});

test("transcribeAudio: budget exhausted throws and makes no fetch", async () => {
  spendBudgetFully();
  await assert.rejects(
    transcribe.transcribeAudio({
      bytes: Buffer.from("fake-ogg"),
      mimetype: "audio/ogg; codecs=opus",
      sha256: "sha-budget",
      conversationId: "conv-1",
    }),
    (err) => err instanceof provider.AiBudgetExceededError,
  );
  assert.equal(fetchCalls.length, 0);
});

test("transcribeAudio: success stores cache, records usage preferring usage.cost", async () => {
  const bytes = Buffer.from("fake-ogg-bytes");
  fetchQueue.push(() =>
    chatCompletion(AUDIO_MODEL, JSON.stringify({
      transcript: "Salam, bghit n3ref fin wsel commande dyali",
      language: "darija_latin",
    }), { prompt_tokens: 500, completion_tokens: 50, cost: 0.000123 }),
  );

  const out = await transcribe.transcribeAudio({
    bytes,
    mimetype: "audio/ogg; codecs=opus",
    sha256: "sha-success",
    conversationId: "conv-1",
  });

  assert.equal(out.cached, false);
  assert.equal(out.transcript, "Salam, bghit n3ref fin wsel commande dyali");
  assert.equal(out.language, "darija_latin");

  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assert.equal(call.url, OPENROUTER_URL);
  const body = requestBody(call);
  assert.equal(body.model, AUDIO_MODEL);
  assert.deepEqual(body.provider, { data_collection: "deny" });
  assert.deepEqual(body.usage, { include: true });
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.max_tokens, 800);
  assert.equal(body.temperature, 0);
  assert.equal(body.messages[0].content[0].type, "text");
  assert.equal(body.messages[0].content[1].type, "input_audio");
  assert.equal(body.messages[0].content[1].input_audio.format, "ogg");
  assert.equal(body.messages[0].content[1].input_audio.data, bytes.toString("base64"));
  assert.equal(call.init.headers.Authorization, `Bearer ${process.env.OPENROUTER_API_KEY}`);

  // usage.cost (0.000123 USD -> 123 micro-USD) wins over token math (500*0.1 + 50*0.4 = 70).
  const row = lastUsageRow();
  assert.equal(row.role, "audio");
  assert.equal(row.model, AUDIO_MODEL);
  assert.equal(row.input_tokens, 500);
  assert.equal(row.output_tokens, 50);
  assert.equal(row.cost_micro_usd, 123);
  assert.equal(row.conversation_id, "conv-1");

  // Second call for the same audio: cache hit, no fetch, no new usage row.
  const callsBefore = fetchCalls.length;
  const rowsBefore = usageRowCount();
  const again = await transcribe.transcribeAudio({
    bytes,
    mimetype: "audio/ogg; codecs=opus",
    sha256: "sha-success",
    conversationId: "conv-1",
  });
  assert.deepEqual(again, { transcript: out.transcript, language: "darija_latin", cached: true });
  assert.equal(fetchCalls.length, callsBefore);
  assert.equal(usageRowCount(), rowsBefore);
});

test("transcribeAudio: primary 500 falls back and the fallback model is recorded", async () => {
  fetchQueue.push(
    () => httpError(500, "audio provider down"),
    () => chatCompletion(AUDIO_FALLBACK, JSON.stringify({
      transcript: "Bonjour, où est ma commande ?",
      language: "fr",
    }), { prompt_tokens: 300, completion_tokens: 30 }),
  );

  const out = await transcribe.transcribeAudio({
    bytes: Buffer.from("fake-ogg"),
    mimetype: "audio/ogg; codecs=opus",
    sha256: "sha-fallback",
    conversationId: "conv-2",
  });

  assert.equal(out.transcript, "Bonjour, où est ma commande ?");
  assert.equal(out.language, "fr");
  assert.equal(fetchCalls.length, 2);
  assert.equal(requestBody(fetchCalls[0]).model, AUDIO_MODEL);
  assert.equal(requestBody(fetchCalls[1]).model, AUDIO_FALLBACK);

  const row = lastUsageRow();
  assert.equal(row.role, "audio");
  assert.equal(row.model, AUDIO_FALLBACK);
  // Without usage.cost: 300 * 0.15 + 30 * 0.47 = 59.1 micro-USD.
  assert.equal(row.cost_micro_usd, 59);
});

test("transcribeAudio: lenient parsing extracts the first JSON object", async () => {
  fetchQueue.push(() =>
    chatCompletion(AUDIO_MODEL, 'Voici la transcription :\n{"transcript": "bonjour", "language": "fr"}'),
  );

  const out = await transcribe.transcribeAudio({
    bytes: Buffer.from("fake-ogg"),
    mimetype: "audio/ogg; codecs=opus",
    sha256: "sha-lenient",
    conversationId: "conv-3",
  });

  assert.equal(out.transcript, "bonjour");
  assert.equal(out.language, "fr");
});

test("transcribeAudio: braces inside the transcript do not break parsing; unknown language is null", async () => {
  fetchQueue.push(() =>
    chatCompletion(AUDIO_MODEL, '{"transcript": "je dis {bonjour} et \\"fin\\"", "language": "klingon"}'),
  );

  const out = await transcribe.transcribeAudio({
    bytes: Buffer.from("fake-ogg"),
    mimetype: "audio/ogg; codecs=opus",
    sha256: "sha-braces",
    conversationId: "conv-3",
  });

  assert.equal(out.transcript, 'je dis {bonjour} et "fin"');
  assert.equal(out.language, null);
});

test("classifyInbound: success records usage with role classify and usage.cost preference", async () => {
  fetchQueue.push(() =>
    chatCompletion(CHAT_MODEL, JSON.stringify({
      category: "insult",
      language: "darija_latin",
      wantsHuman: true,
      isBotQuestion: false,
    }), { prompt_tokens: 100, completion_tokens: 20, cost: 0.00002 }),
  );

  const out = await classify.classifyInbound("nta chi hemaar", "conv-4");

  assert.deepEqual(out, {
    category: "insult",
    language: "darija_latin",
    wantsHuman: true,
    isBotQuestion: false,
  });

  assert.equal(fetchCalls.length, 1);
  const body = requestBody(fetchCalls[0]);
  assert.equal(body.model, CHAT_MODEL);
  assert.deepEqual(body.provider, { data_collection: "deny" });
  assert.deepEqual(body.usage, { include: true });
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 120);
  const userMsg = body.messages.find((m) => m.role === "user");
  assert.equal(userMsg.content, "Message du client :\nnta chi hemaar");

  const row = lastUsageRow();
  assert.equal(row.role, "classify");
  assert.equal(row.model, CHAT_MODEL);
  assert.equal(row.input_tokens, 100);
  assert.equal(row.output_tokens, 20);
  // usage.cost 0.00002 USD -> 20 micro-USD (token math would give 6).
  assert.equal(row.cost_micro_usd, 20);
});

test("classifyInbound: primary 500 then fallback succeeds and records the fallback model", async () => {
  fetchQueue.push(
    () => httpError(500, "chat down"),
    () => chatCompletion(CHAT_FALLBACK, JSON.stringify({
      category: "troll",
      language: "ar",
      wantsHuman: false,
      isBotQuestion: true,
    })),
  );

  const out = await classify.classifyInbound("bla bla", "conv-5");

  assert.deepEqual(out, {
    category: "troll",
    language: "ar",
    wantsHuman: false,
    isBotQuestion: true,
  });
  assert.equal(fetchCalls.length, 2);
  assert.equal(requestBody(fetchCalls[0]).model, CHAT_MODEL);
  assert.equal(requestBody(fetchCalls[1]).model, CHAT_FALLBACK);

  const row = lastUsageRow();
  assert.equal(row.role, "classify");
  assert.equal(row.model, CHAT_FALLBACK);
});

test("classifyInbound: total failure returns the safe ok fallback and never strikes", async () => {
  const rowsBefore = usageRowCount();
  fetchQueue.push(
    () => httpError(500, "down"),
    () => httpError(500, "down too"),
  );

  const out = await classify.classifyInbound("مرحبا كيف حالك", "conv-6");

  assert.deepEqual(out, {
    category: "ok",
    language: "ar",
    wantsHuman: false,
    isBotQuestion: false,
  });
  assert.equal(fetchCalls.length, 2);
  assert.equal(usageRowCount(), rowsBefore); // failed attempts record nothing
});

test("classifyInbound: exhausted budget returns the fallback without any fetch", async () => {
  spendBudgetFully();
  const out = await classify.classifyInbound("wach nta robot?", "conv-7");
  assert.deepEqual(out, {
    category: "ok",
    language: "darija_latin",
    wantsHuman: false,
    isBotQuestion: false,
  });
  assert.equal(fetchCalls.length, 0);
});

test("classifyInbound: empty text returns the fallback without any fetch", async () => {
  const out = await classify.classifyInbound("   ", "conv-8");
  assert.deepEqual(out, {
    category: "ok",
    language: "fr",
    wantsHuman: false,
    isBotQuestion: false,
  });
  assert.equal(fetchCalls.length, 0);
});

test("heuristicLanguage detects darija in both scripts", () => {
  assert.equal(classify.heuristicLanguage("واش بغيت ديال المنتوج"), "darija_arabic");
  assert.equal(classify.heuristicLanguage("بغيت نطلب ديالكم"), "darija_arabic");
  assert.equal(classify.heuristicLanguage("مرحبا، كيف حالك اليوم"), "ar");
  assert.equal(classify.heuristicLanguage("مرحبا بكم في متجرنا"), "ar");
  assert.equal(classify.heuristicLanguage("wach a khoya bghit chhal"), "darija_latin");
  assert.equal(classify.heuristicLanguage("salam, ch7al dyal livraison ?"), "darija_latin");
  assert.equal(classify.heuristicLanguage("3la 9addach dyal colis"), "darija_latin");
  assert.equal(classify.heuristicLanguage("Bonjour, je souhaite suivre ma commande"), "fr");
  assert.equal(classify.heuristicLanguage("j'ai commandé 3 articles"), "fr");
  assert.equal(classify.heuristicLanguage(""), "fr");
  assert.equal(classify.heuristicLanguage("ok merci"), "fr");
});

test("aiUsageSummary aggregates by day, role and model", () => {
  clearUsage();
  usage.recordAiUsage({ role: "chat", model: CHAT_MODEL, inputTokens: 10, outputTokens: 5, costMicroUsd: 100, createdAt: "2026-10-29T10:00:00.000Z" });
  usage.recordAiUsage({ role: "chat", model: CHAT_MODEL, inputTokens: 20, outputTokens: 8, costMicroUsd: 150, createdAt: "2026-10-29T11:00:00.000Z" });
  usage.recordAiUsage({ role: "audio", model: AUDIO_MODEL, inputTokens: 500, outputTokens: 50, costMicroUsd: 123, createdAt: "2026-10-29T12:00:00.000Z" });

  const rows = usage.aiUsageSummary(7);
  const chatRow = rows.find((r) => r.role === "chat");
  assert.ok(chatRow);
  assert.equal(chatRow.day, "2026-10-29"); // Africa/Casablanca day
  assert.equal(chatRow.model, CHAT_MODEL);
  assert.equal(chatRow.calls, 2);
  assert.equal(chatRow.inputTokens, 30);
  assert.equal(chatRow.outputTokens, 13);
  assert.equal(chatRow.costMicroUsd, 250);

  const audioRow = rows.find((r) => r.role === "audio");
  assert.ok(audioRow);
  assert.equal(audioRow.calls, 1);
  assert.equal(audioRow.costMicroUsd, 123);
});

test("media cache upsert keeps existing fields and getCachedMedia reads back", () => {
  usage.putCachedMedia({ sha256: "sha-upsert", transcript: "première", language: "fr", createdAt: "2026-10-29T09:00:00.000Z" });
  usage.putCachedMedia({ sha256: "sha-upsert", transcript: "deuxième" });

  const row = usage.getCachedMedia("sha-upsert");
  assert.equal(row.transcript, "deuxième");
  assert.equal(row.language, "fr"); // COALESCE keeps the earlier language
  assert.equal(row.createdAt, "2026-10-29T09:00:00.000Z");
  assert.equal(usage.getCachedMedia(""), null);
  assert.equal(usage.getCachedMedia("sha-missing"), null);
});
