import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const evalDir = path.join(rootDir, "scripts", "whatsapp-eval");
const casesPath = path.join(evalDir, "cases.json");
const runnerPath = path.join(evalDir, "run.mjs");
const audioGitkeep = path.join(evalDir, "audio", ".gitkeep");
const blockNetwork = path.join(rootDir, "scripts", "block-external-network.mjs");

test("cases.json contains realistic text cases covering all requirements", () => {
  assert.ok(fs.existsSync(casesPath), "cases.json must exist");
  const raw = fs.readFileSync(casesPath, "utf8");
  const cases = JSON.parse(raw);

  assert.ok(Array.isArray(cases), "cases.json must be an array");
  assert.ok(cases.length >= 25 && cases.length <= 40, `Expected ~30 cases, got ${cases.length}`);

  const ids = new Set();
  const languages = new Set();
  const expects = new Set();

  for (const c of cases) {
    assert.ok(c.id && typeof c.id === "string", `Case id is required: ${JSON.stringify(c)}`);
    assert.ok(!ids.has(c.id), `Duplicate case id: ${c.id}`);
    ids.add(c.id);

    assert.ok(c.lang && typeof c.lang === "string", `Case lang is required: ${c.id}`);
    languages.add(c.lang);

    assert.ok(c.text && typeof c.text === "string" && c.text.trim().length > 0, `Case text is required: ${c.id}`);
    assert.ok(Array.isArray(c.expect) && c.expect.length > 0, `Case expect list is required: ${c.id}`);
    for (const exp of c.expect) {
      expects.add(exp);
    }
  }

  // Mandatory language coverage
  assert.ok(languages.has("darija_latin"), "Must cover darija_latin");
  assert.ok(languages.has("darija_arabic"), "Must cover darija_arabic");
  assert.ok(languages.has("fr"), "Must cover fr");
  assert.ok(languages.has("ar"), "Must cover ar");

  // Mandatory scenario coverage (status, stock/price, address, cancel, complaint, bot question, injection, privacy, insult, presales)
  const allTexts = cases.map((c) => c.text.toLowerCase()).join(" ");
  assert.ok(allTexts.includes("colis") || allTexts.includes("commande") || allTexts.includes("الطلبية"), "Must cover status questions");
  assert.ok(allTexts.includes("sbbat") || allTexts.includes("taman") || allTexts.includes("chaussures") || allTexts.includes("الصباط"), "Must cover price/stock questions");
  assert.ok(allTexts.includes("adresse") || allTexts.includes("العنوان"), "Must cover address change");
  assert.ok(allTexts.includes("nlghi") || allTexts.includes("annuler") || allTexts.includes("إلغاء"), "Must cover cancel request");
  assert.ok(allTexts.includes("m9ti3") || allTexts.includes("déchiré") || allTexts.includes("مقطعة"), "Must cover damaged complaint");
  assert.ok(allTexts.includes("robot") || allTexts.includes("روبو"), "Must cover bot question");
  assert.ok(allTexts.includes("ignore") || allTexts.includes("remise") || allTexts.includes("fabour"), "Must cover prompt injection");
  assert.ok(allTexts.includes("cmd99999"), "Must cover unlinked privacy order");
  assert.ok(allTexts.includes("msalyin") || allTexts.includes("nul"), "Must cover mild insult");
  assert.ok(allTexts.includes("ma bghitch ndkhol") || allTexts.includes("pas aller sur le site"), "Must cover pre-sales refusal of link");
});

test("audio gitkeep exists and audio files are git-ignored", () => {
  assert.ok(fs.existsSync(audioGitkeep), "audio/.gitkeep must exist");

  const dummyAudio = path.join(evalDir, "audio", "voice-sample.ogg");
  fs.writeFileSync(dummyAudio, "dummy-audio-bytes");
  try {
    const gitStatus = execFileSync(
      "git",
      ["status", "--porcelain", "--ignored", "scripts/whatsapp-eval/audio/"],
      { cwd: rootDir, encoding: "utf8" },
    );
    assert.match(gitStatus, /!! scripts\/whatsapp-eval\/audio\/voice-sample\.ogg/, "voice-sample.ogg must be ignored by git");
  } finally {
    fs.unlinkSync(dummyAudio);
  }
});

test("runner refuses to run without WHATSAPP_EVAL_LIVE=1, OPENROUTER_API_KEY, or --yes", () => {
  // 1. Without any env or args (with network blocked)
  const res1 = spawnSync(
    "node",
    ["--import", blockNetwork, runnerPath],
    { cwd: rootDir, env: { ...process.env, WHATSAPP_EVAL_LIVE: "", OPENROUTER_API_KEY: "" } },
  );
  assert.equal(res1.status, 1);
  const out1 = (res1.stdout + res1.stderr).toString();
  assert.match(out1, /REFUS D'EXÉCUTION/);
  assert.match(out1, /WHATSAPP_EVAL_LIVE=1/);
  assert.match(out1, /OPENROUTER_API_KEY/);
  assert.match(out1, /--yes/);
  assert.match(out1, /Estimation des appels et du coût/);

  // 2. With WHATSAPP_EVAL_LIVE=1 but no API key
  const res2 = spawnSync(
    "node",
    ["--import", blockNetwork, runnerPath, "--yes"],
    { cwd: rootDir, env: { ...process.env, WHATSAPP_EVAL_LIVE: "1", OPENROUTER_API_KEY: "" } },
  );
  assert.equal(res2.status, 1);
  const out2 = (res2.stdout + res2.stderr).toString();
  assert.match(out2, /OPENROUTER_API_KEY absente ou vide/);

  // 3. With API key and WHATSAPP_EVAL_LIVE=1 but missing --yes
  const res3 = spawnSync(
    "node",
    ["--import", blockNetwork, runnerPath],
    { cwd: rootDir, env: { ...process.env, WHATSAPP_EVAL_LIVE: "1", OPENROUTER_API_KEY: "dummy-key" } },
  );
  assert.equal(res3.status, 1);
  const out3 = (res3.stdout + res3.stderr).toString();
  assert.match(out3, /Option --yes requise/);
});

test("runner --help prints usage and exits cleanly with 0", () => {
  const res = spawnSync("node", [runnerPath, "--help"], { cwd: rootDir });
  assert.equal(res.status, 0);
  const out = res.stdout.toString();
  assert.match(out, /Banc d'évaluation Darija WhatsApp/);
  assert.match(out, /--chat-models=/);
  assert.match(out, /--audio-models=/);
});

test("runner executes against a mock provider and writes a markdown report", async () => {
  const mockFetchScript = `
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes("openrouter.ai")) {
        return new Response(JSON.stringify({
          id: "mock_eval_comp",
          object: "chat.completion",
          created: 0,
          model: "z-ai/glm-5.3-flash",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Salam! Colis dyalek rah f tri9.",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 150,
            completion_tokens: 25,
            total_tokens: 175,
            cost: 0.00002,
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return origFetch(url, init);
    };
  `;
  const mockImport = `data:text/javascript,${encodeURIComponent(mockFetchScript)}`;

  const res = spawnSync(
    "node",
    [
      "--import",
      blockNetwork,
      "--import",
      mockImport,
      runnerPath,
      "--yes",
      "--chat-models=z-ai/glm-5.3-flash",
      "--cases=status-darija-latin",
    ],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        WHATSAPP_EVAL_LIVE: "1",
        OPENROUTER_API_KEY: "mock-openrouter-key",
      },
    },
  );

  const out = (res.stdout + res.stderr).toString();
  assert.equal(res.status, 0, `Runner failed:\n${out}`);
  assert.match(out, /Évaluation terminée avec succès/);
  assert.match(out, /Rapport généré/);

  // Verify report was written
  const reportsDir = path.join(evalDir, "reports");
  assert.ok(fs.existsSync(reportsDir), "reports directory must exist");
  const reports = fs.readdirSync(reportsDir).filter((f) => f.endsWith(".md"));
  assert.ok(reports.length > 0, "At least one report markdown file should be present");

  const latestReport = path.join(reportsDir, reports[reports.length - 1]);
  const reportContent = fs.readFileSync(latestReport, "utf8");
  assert.match(reportContent, /# Évaluation des modèles WhatsApp Darija/);
  assert.match(reportContent, /Résumé global par modèle/);
  assert.match(reportContent, /status-darija-latin/);
  assert.match(reportContent, /Salam! Colis dyalek rah f tri9/);
});

test("runner processes audio files and transcribes them", async () => {
  const dummyAudio = path.join(evalDir, "audio", "sample-darija.ogg");
  fs.writeFileSync(dummyAudio, "fake-ogg-audio-stream");

  const mockFetchScript = `
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes("openrouter.ai")) {
        const bodyStr = init?.body ? String(init.body) : "";
        if (bodyStr.includes("input_audio")) {
          return new Response(JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    transcript: "fin wsal colis dyali 3afak?",
                    language: "darija_latin",
                  }),
                },
              },
            ],
            usage: {
              prompt_tokens: 120,
              completion_tokens: 30,
              cost: 0.00003,
            },
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({
          id: "mock_eval_comp",
          object: "chat.completion",
          created: 0,
          model: "z-ai/glm-5.3-flash",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Salam! Colis dyalek rah f tri9.",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 150,
            completion_tokens: 25,
            total_tokens: 175,
            cost: 0.00002,
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return origFetch(url, init);
    };
  `;
  const mockImport = `data:text/javascript,${encodeURIComponent(mockFetchScript)}`;

  try {
    const res = spawnSync(
      "node",
      [
        "--import",
        blockNetwork,
        "--import",
        mockImport,
        runnerPath,
        "--yes",
        "--chat-models=z-ai/glm-5.3-flash",
        "--audio-models=google/gemini-2.5-flash-lite",
        "--cases=status-darija-latin",
      ],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          WHATSAPP_EVAL_LIVE: "1",
          OPENROUTER_API_KEY: "mock-openrouter-key",
        },
      },
    );

    const out = (res.stdout + res.stderr).toString();
    assert.equal(res.status, 0, `Runner failed:\n${out}`);
    assert.match(out, /Fichiers audio détectés : 1/);
    assert.match(out, /Évaluation terminée avec succès/);

    const reportsDir = path.join(evalDir, "reports");
    const reports = fs.readdirSync(reportsDir).filter((f) => f.endsWith(".md"));
    const latestReport = path.join(reportsDir, reports[reports.length - 1]);
    const reportContent = fs.readFileSync(latestReport, "utf8");
    assert.match(reportContent, /Évaluation des messages vocaux \(Audio\)/);
    assert.match(reportContent, /sample-darija\.ogg/);
    assert.match(reportContent, /fin wsal colis dyali 3afak\?/);
    assert.match(reportContent, /google\/gemini-2\.5-flash-lite/);
  } finally {
    if (fs.existsSync(dummyAudio)) {
      fs.unlinkSync(dummyAudio);
    }
  }
});
