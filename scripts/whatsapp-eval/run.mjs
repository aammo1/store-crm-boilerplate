#!/usr/bin/env node
/**
 * Darija Evaluation Harness (task-26)
 *
 * Offline-by-default, opt-in evaluation harness for Moroccan Darija (Latin & Arabic script),
 * French, and Arabic. Compares candidate chat models and audio transcription models.
 *
 * SAFETY INVARIANTS:
 * - Refuses to run unless WHATSAPP_EVAL_LIVE=1 and OPENROUTER_API_KEY are explicitly set.
 * - Requires --yes to confirm network calls and API costs.
 * - Never part of `npm test` or CI.
 * - Never prints or leaks the API key in logs or reports.
 * - Always deletes temporary test databases and uploads directories.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { loadSource } from "../test-source.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Stub server-only so Next.js server modules can be loaded in Node scripts
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  return name === "server-only" ? {} : originalLoad.call(this, name, ...args);
};

const DEFAULT_CHAT_MODELS = [
  "z-ai/glm-5.3-flash",
  "deepseek/deepseek-v4.1-flash",
  "qwen/qwen3.7-flash",
];

const DEFAULT_AUDIO_MODELS = [
  "google/gemini-2.5-flash-lite",
  "qwen/qwen3.8-omni-flash",
];

function sanitizeSecret(text, secret) {
  if (!text || !secret) return text || "";
  const key = secret.trim();
  if (key.length >= 4 && text.includes(key)) {
    return text.replaceAll(key, "[REDACTED]");
  }
  return text;
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  const options = {
    yes: false,
    help: false,
    chatModels: [...DEFAULT_CHAT_MODELS],
    audioModels: [...DEFAULT_AUDIO_MODELS],
    caseFilter: null,
  };

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--yes") {
      options.yes = true;
    } else if (arg.startsWith("--chat-models=")) {
      const raw = arg.slice("--chat-models=".length).trim();
      if (raw) {
        options.chatModels = raw.split(",").map((s) => s.trim()).filter(Boolean);
      }
    } else if (arg.startsWith("--audio-models=")) {
      const raw = arg.slice("--audio-models=".length).trim();
      if (raw) {
        options.audioModels = raw.split(",").map((s) => s.trim()).filter(Boolean);
      }
    } else if (arg.startsWith("--cases=")) {
      const raw = arg.slice("--cases=".length).trim();
      if (raw) {
        options.caseFilter = raw.split(",").map((s) => s.trim()).filter(Boolean);
      }
    }
  }

  return options;
}

function getAudioFiles() {
  const audioDir = path.join(__dirname, "audio");
  if (!fs.existsSync(audioDir)) return [];
  const entries = fs.readdirSync(audioDir);
  const audioExts = new Set([".ogg", ".opus", ".mp3", ".m4a", ".wav", ".aac"]);
  return entries
    .filter((file) => {
      if (file === ".gitkeep") return false;
      const ext = path.extname(file).toLowerCase();
      return audioExts.has(ext);
    })
    .map((file) => path.join(audioDir, file));
}

function getAudioMimetype(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ogg":
    case ".opus":
      return "audio/ogg";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/m4a";
    case ".wav":
      return "audio/wav";
    case ".aac":
      return "audio/aac";
    default:
      return "audio/ogg";
  }
}

function printUsage() {
  console.log(`
Banc d'évaluation Darija WhatsApp (task-26)
===========================================

Usage:
  WHATSAPP_EVAL_LIVE=1 OPENROUTER_API_KEY="sk-or-v1-..." npm run eval:whatsapp -- --yes [options]

Options:
  --yes               Confirmation requise pour autoriser les appels OpenRouter réels
  --chat-models=a,b   Modèles chat OpenRouter séparés par virgule
                      (Défaut: ${DEFAULT_CHAT_MODELS.join(",")})
  --audio-models=a,b  Modèles audio OpenRouter séparés par virgule
                      (Défaut: ${DEFAULT_AUDIO_MODELS.join(",")})
  --cases=id1,id2     Filtrer les cas par ID (défaut: tous les cas dans cases.json)
  --help, -h          Afficher cette aide

Sécurité:
  Ce script effectue de VRAIS appels réseau payants vers OpenRouter.
  Il refuse strictement de s'exécuter sans WHATSAPP_EVAL_LIVE=1 et --yes.
  Les données et clés ne sont jamais enregistrées dans le rapport ni dans git.
`);
}

function printCostEstimate(caseCount, chatModelCount, audioFileCount, audioModelCount) {
  const chatTurns = caseCount * chatModelCount;
  const audioCalls = audioFileCount * audioModelCount;
  // Estimation prudente : ~1500 tokens in + 300 tokens out (~$0.0003/tour pour les modèles flash)
  const estChatCost = chatTurns * 0.00035;
  const estAudioCost = audioCalls * 0.001;
  const totalEst = estChatCost + estAudioCost;

  console.log(`
--- Estimation des appels et du coût ---
Cas textuels sélectionnés : ${caseCount}
Modèles chat (${chatModelCount}) : ${chatTurns} tours au total
Fichiers vocaux (${audioFileCount}) × modèles audio (${audioModelCount}) : ${audioCalls} transcriptions
Coût estimé total : ~$${totalEst.toFixed(3)} USD (nettement inférieur au plafond quotidien d'1 $)
----------------------------------------`);
}

function resetSourceCache() {
  for (const k of Object.keys(loadSource.cache)) {
    if (k.includes("/src/")) {
      delete loadSource.cache[k];
    }
  }
}

function median(numbers) {
  if (!numbers.length) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function escapeMarkdownCell(text) {
  if (!text) return "-";
  return String(text)
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");
}

function seedDatabase(db) {
  const now = new Date().toISOString();

  // 1. Settings
  const { updateWhatsAppSettings } = loadSource("@/lib/services/whatsapp-settings");
  updateWhatsAppSettings({
    enabled: true,
    aiEnabled: true,
    aiDailyBudgetCents: 10_000, // Budget maximum autorisé par le schéma (100 $)
    catalogSuggestionsEnabled: true,
    orderEditProposalsEnabled: true,
    crossSellEnabled: true,
    assistantName: "Sara",
    faqText:
      "Livraison 24-48h partout au Maroc. Paiement à la livraison cash ou carte bancaire auprès du livreur. Retours possibles sous 7 jours après réception.",
  });

  // 2. Ville
  db.prepare("INSERT OR IGNORE INTO cities (id, name, updated_at) VALUES (1, 'Casablanca', ?)").run(now);

  // 3. Produits
  // Produit 1: Chaussures avec pointures et couleurs
  db.prepare(`
    INSERT INTO products (
      id, slug, name, category, price, description, story, materials_json,
      badge, is_best_seller, upsell_ref, active, landing_enabled,
      images_json, option_definitions_json, created_at, updated_at
    ) VALUES (
      'p-chaussures', 'chaussures-sport', 'Chaussures Sport Confort', 'Chaussures',
      299, 'Chaussures sport respirantes en cuir souple noir et blanc', '', '[]',
      NULL, 1, NULL, 1, 0,
      '["/api/media/chaussures.webp"]',
      ?, ?, ?
    )
  `).run(
    JSON.stringify([
      { name: "Pointure", values: ["40", "41", "42", "43"] },
      { name: "Couleur", values: ["Noir", "Blanc"] },
    ]),
    now,
    now,
  );

  const shoeVariants = [
    { id: "v-40-blk", label: "Pointure 40 / Noir", opts: [{ name: "Pointure", value: "40" }, { name: "Couleur", value: "Noir" }], sku: "CH-40-BLK", stock: 0 },
    { id: "v-41-blk", label: "Pointure 41 / Noir", opts: [{ name: "Pointure", value: "41" }, { name: "Couleur", value: "Noir" }], sku: "CH-41-BLK", stock: 5 },
    { id: "v-42-blk", label: "Pointure 42 / Noir", opts: [{ name: "Pointure", value: "42" }, { name: "Couleur", value: "Noir" }], sku: "CH-42-BLK", stock: 0 },
    { id: "v-42-wht", label: "Pointure 42 / Blanc", opts: [{ name: "Pointure", value: "42" }, { name: "Couleur", value: "Blanc" }], sku: "CH-42-WHT", stock: 4 },
    { id: "v-43-blk", label: "Pointure 43 / Noir", opts: [{ name: "Pointure", value: "43" }, { name: "Couleur", value: "Noir" }], sku: "CH-43-BLK", stock: 3 },
  ];

  for (const v of shoeVariants) {
    db.prepare(`
      INSERT INTO variants (id, product_id, label, options_json, options_key, sku, active, images_json)
      VALUES (?, 'p-chaussures', ?, ?, ?, ?, 1, '[]')
    `).run(v.id, v.label, JSON.stringify(v.opts), JSON.stringify(v.opts.map((o) => [o.name, o.value])), v.sku);
    if (v.stock > 0) {
      db.prepare("INSERT INTO stock_balances (variant_id, location, physical, reserved, quarantine) VALUES (?, 'MAIN', ?, 0, 0)")
        .run(v.id, v.stock);
    }
  }

  // Produit 2: Montre Élégance avec pack de quantité
  db.prepare(`
    INSERT INTO products (
      id, slug, name, category, price, description, story, materials_json,
      badge, is_best_seller, upsell_ref, active, landing_enabled,
      images_json, option_definitions_json, created_at, updated_at
    ) VALUES (
      'p-montre', 'montre-elegance', 'Montre Élégance Quartz', 'Accessoires',
      199, 'Montre étanche minimaliste boîtier acier', '', '[]',
      NULL, 0, NULL, 1, 0,
      '["/api/media/montre.webp"]', '[]', ?, ?
    )
  `).run(now, now);

  db.prepare(`
    INSERT INTO variants (id, product_id, label, options_json, options_key, sku, active, images_json)
    VALUES ('v-montre-std', 'p-montre', 'Standard', '[]', '[]', 'MO-STD', 1, '[]')
  `).run();
  db.prepare("INSERT INTO stock_balances (variant_id, location, physical, reserved, quarantine) VALUES ('v-montre-std', 'MAIN', 10, 0, 0)").run();

  db.prepare(`
    INSERT INTO product_packs (id, product_id, quantity, price_mad, label, highlight, active, created_at, updated_at)
    VALUES ('pack-montre-2', 'p-montre', 2, 349, 'Pack 2 Montres', 0, 1, ?, ?)
  `).run(now, now);

  // Produit 3: T-shirt Coton
  db.prepare(`
    INSERT INTO products (
      id, slug, name, category, price, description, story, materials_json,
      badge, is_best_seller, upsell_ref, active, landing_enabled,
      images_json, option_definitions_json, created_at, updated_at
    ) VALUES (
      'p-tshirt', 'tshirt-coton', 'T-shirt Coton Bio', 'Vêtements',
      149, 'T-shirt 100% coton peigné respirant', '', '[]',
      NULL, 0, NULL, 1, 0,
      '["/api/media/tshirt.webp"]',
      ?, ?, ?
    )
  `).run(JSON.stringify([{ name: "Taille", values: ["M", "L"] }]), now, now);

  for (const [id, size, stock] of [["v-ts-m", "M", 8], ["v-ts-l", "L", 6]]) {
    const opts = [{ name: "Taille", value: size }];
    db.prepare(`
      INSERT INTO variants (id, product_id, label, options_json, options_key, sku, active, images_json)
      VALUES (?, 'p-tshirt', ?, ?, ?, ?, 1, '[]')
    `).run(id, `Taille ${size}`, JSON.stringify(opts), JSON.stringify([["Taille", size]]), `TS-${size}`);
    db.prepare("INSERT INTO stock_balances (variant_id, location, physical, reserved, quarantine) VALUES (?, 'MAIN', ?, 0, 0)")
      .run(id, stock);
  }

  // 4. Commandes pour le client test +212600000001
  // Commande 1: nouvelle
  const itemsOrd1 = JSON.stringify([
    { product_id: "p-montre", variant_id: "v-montre-std", sku: "MO-STD", name: "Montre Élégance Quartz", variant_label: "Standard", options: [], quantity: 1, unit_price: 199, line_total: 199 },
  ]);
  db.prepare(`
    INSERT INTO orders (
      id, customer_name, customer_phone, items_json, upsell_status,
      subtotal, shipping, total, currency, created_at, updated_at, confirmation_status
    ) VALUES ('CMD11111-new-order', 'Karim Alami', '+212600000001', ?, 'closed', 199, 29, 228, 'MAD', ?, ?, 'new')
  `).run(itemsOrd1, now, now);

  // Commande 2: confirmée et expédiée avec numéro de suivi
  const itemsOrd2 = JSON.stringify([
    { product_id: "p-chaussures", variant_id: "v-41-blk", sku: "CH-41-BLK", name: "Chaussures Sport Confort", variant_label: "Pointure 41 / Noir", options: [{ name: "Pointure", value: "41" }, { name: "Couleur", value: "Noir" }], quantity: 1, unit_price: 299, line_total: 299 },
  ]);
  db.prepare(`
    INSERT INTO orders (
      id, customer_name, customer_phone, items_json, upsell_status,
      subtotal, shipping, total, currency, created_at, updated_at, confirmation_status
    ) VALUES ('CMD22222-shipped-order', 'Karim Alami', '+212600000001', ?, 'closed', 299, 29, 328, 'MAD', ?, ?, 'confirmed')
  `).run(itemsOrd2, now, now);

  db.prepare(`
    INSERT INTO courier_submissions (
      id, order_id, tracking_number, status, normalized_status,
      created_at, updated_at, next_retry_at, last_sync_at
    ) VALUES ('sub-cmd22222', 'CMD22222-shipped-order', 'TRK-987654', 'submitted', 'in_transit', ?, ?, ?, ?)
  `).run(now, now, now, now);

  db.prepare(`
    INSERT INTO tracking_events (
      id, submission_id, raw_status, normalized_status, observed_at, created_at
    ) VALUES ('evt-cmd22222', 'sub-cmd22222', 'Colis en cours d''acheminement', 'in_transit', ?, ?)
  `).run(now, now);

  // Commande 3: appartient à un AUTRE numéro pour tester la confidentialité (CMD99999)
  db.prepare(`
    INSERT INTO orders (
      id, customer_name, customer_phone, items_json, upsell_status,
      subtotal, shipping, total, currency, created_at, updated_at, confirmation_status
    ) VALUES ('CMD99999-other-customer', 'Autre Client', '+212699999999', '[]', 'closed', 149, 29, 178, 'MAD', ?, ?, 'confirmed')
  `).run(now, now);
}

function setupTempEnvironment() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-wa-eval-"));
  process.env.DB_PATH = path.join(tempDir, "crm.db");
  process.env.UPLOAD_DIR = path.join(tempDir, "uploads");
  process.env.DELIVERY_PROVIDER = "mock";
  process.env.AUTH_SECRET = "eval-harness-isolated-secret-auth-key-32ch";
  process.env.CRM_PUBLIC_URL = "https://store.example.test";
  process.env.SECURITY_ALLOWED_ORIGINS = "https://store.example.test";
  process.env.EVOLUTION_BASE_URL = "http://evolution.internal:8080";
  process.env.EVOLUTION_INSTANCE = "eval-instance";
  process.env.EVOLUTION_API_KEY = "eval-ephemeral-key";
  process.env.WHATSAPP_WEBHOOK_SECRET = "eval-webhook-secret-minimum-32-chars-long";

  resetSourceCache();

  const { getDb } = loadSource("@/lib/db");
  const db = getDb();
  seedDatabase(db);

  return {
    tempDir,
    db,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // Ignorer si déjà fermé
      }
      resetSourceCache();
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignorer les erreurs de nettoyage
      }
    },
  };
}

async function runTextCase(caseItem, db) {
  const { insertInboundMessage } = loadSource("@/lib/services/whatsapp-conversations");
  const { runWhatsAppAgent } = loadSource("@/lib/whatsapp/ai/agent");

  const now = new Date().toISOString();
  const convId = crypto.randomUUID();

  // Création d'une conversation isolée pour ce cas
  db.prepare(`
    INSERT INTO wa_conversations (
      id, phone, jid, display_name, language, mode, needs_human, unread_count, created_at, updated_at
    ) VALUES (?, '+212600000001', '212600000001@s.whatsapp.net', 'Karim Alami', ?, 'ai', 0, 0, ?, ?)
  `).run(convId, caseItem.lang || "fr", now, now);

  // Lier automatiquement les commandes du numéro test (+212600000001)
  db.prepare(`
    INSERT INTO wa_conversation_orders (conversation_id, order_id, access, linked_via, created_at)
    SELECT ?, id, 'full', 'phone', ?
    FROM orders
    WHERE customer_phone = '+212600000001'
  `).run(convId, now);

  insertInboundMessage({
    conversationId: convId,
    waMessageId: `msg-${caseItem.id}`,
    kind: "text",
    body: caseItem.text,
  });

  const start = performance.now();
  let result;
  try {
    result = await runWhatsAppAgent({
      conversationId: convId,
      newMessages: [{ kind: "text", text: caseItem.text }],
    });
  } catch (err) {
    const elapsed = Math.round(performance.now() - start);
    return {
      replies: [`[ERREUR: ${sanitizeSecret(err.message, process.env.OPENROUTER_API_KEY)}]`],
      toolCalls: [],
      handedOff: false,
      latencyMs: elapsed,
      costMicroUsd: 0,
    };
  }
  const latencyMs = Math.round(performance.now() - start);

  const usageRow = db.prepare(
    "SELECT COALESCE(SUM(cost_micro_usd), 0) AS cost FROM wa_ai_usage WHERE conversation_id = ?",
  ).get(convId);
  const costMicroUsd = Number(usageRow?.cost ?? 0);

  return {
    replies: result.replies,
    toolCalls: result.toolCalls,
    handedOff: result.handedOff,
    latencyMs,
    costMicroUsd,
  };
}

async function runAudioCase(audioFilePath, audioModel, defaultChatModel, env) {
  const { transcribeAudio } = loadSource("@/lib/whatsapp/ai/transcribe");
  const { runWhatsAppAgent } = loadSource("@/lib/whatsapp/ai/agent");

  process.env.WHATSAPP_AUDIO_MODEL = audioModel;
  process.env.WHATSAPP_AUDIO_FALLBACK_MODEL = audioModel;

  const bytes = fs.readFileSync(audioFilePath);
  const mimetype = getAudioMimetype(audioFilePath);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const convId = crypto.randomUUID();
  const now = new Date().toISOString();

  env.db.prepare(`
    INSERT INTO wa_conversations (
      id, phone, jid, display_name, mode, needs_human, unread_count, created_at, updated_at
    ) VALUES (?, '+212600000001', '212600000001@s.whatsapp.net', 'Karim Alami', 'ai', 0, 0, ?, ?)
  `).run(convId, now, now);

  // Vider le cache de média pour forcer la transcription par ce modèle
  env.db.prepare("DELETE FROM wa_media_cache").run();

  const audioStart = performance.now();
  let transcript = "";
  let language = "inconnu";
  let audioError = null;

  try {
    const res = await transcribeAudio({
      bytes,
      mimetype,
      sha256,
      conversationId: convId,
    });
    transcript = res.transcript;
    language = res.language ?? "inconnu";
  } catch (err) {
    audioError = sanitizeSecret(err.message, process.env.OPENROUTER_API_KEY);
  }
  const audioLatencyMs = Math.round(performance.now() - audioStart);

  const audioUsageRow = env.db.prepare(
    "SELECT COALESCE(SUM(cost_micro_usd), 0) AS cost FROM wa_ai_usage WHERE conversation_id = ? AND role = 'audio'",
  ).get(convId);
  const audioCostMicroUsd = Number(audioUsageRow?.cost ?? 0);

  let chatReplies = [];
  let chatLatencyMs = 0;
  if (!audioError && transcript) {
    process.env.WHATSAPP_CHAT_MODEL = defaultChatModel;
    process.env.WHATSAPP_CHAT_FALLBACK_MODEL = defaultChatModel;
    const chatStart = performance.now();
    try {
      const agentRes = await runWhatsAppAgent({
        conversationId: convId,
        newMessages: [{ kind: "text", text: transcript }],
      });
      chatReplies = agentRes.replies;
    } catch (err) {
      chatReplies = [`[ERREUR CHAT: ${sanitizeSecret(err.message, process.env.OPENROUTER_API_KEY)}]`];
    }
    chatLatencyMs = Math.round(performance.now() - chatStart);
  }

  return {
    transcript: audioError ? `[ERREUR TRANSCRIPTION: ${audioError}]` : transcript,
    language,
    audioLatencyMs,
    audioCostMicroUsd,
    chatReplies,
    chatLatencyMs,
  };
}

function generateReport({
  chatModels,
  audioModels,
  cases,
  chatResults,
  audioResults,
  summary,
}) {
  const nowStr = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Africa/Casablanca",
    dateStyle: "full",
    timeStyle: "medium",
  }).format(new Date());

  const lines = [];

  lines.push("# Évaluation des modèles WhatsApp Darija");
  lines.push("");
  lines.push(`- **Date d'exécution** : ${nowStr} (Casablanca)`);
  lines.push(`- **Modèles Chat évalués** : \`${chatModels.join("`, `")}\``);
  lines.push(`- **Modèles Audio évalués** : \`${audioModels.join("`, `")}\``);
  lines.push(`- **Cas textuels évalués** : ${cases.length}`);
  lines.push("");

  lines.push("## Résumé global par modèle");
  lines.push("");
  lines.push("| Modèle | Rôle | Évaluations | Latence médiane | Coût total (µ$) | Coût total ($) |");
  lines.push("|---|---|---|---|---|---|");

  for (const s of summary) {
    const costUsd = (s.totalCostMicroUsd / 1_000_000).toFixed(4);
    lines.push(
      `| \`${s.model}\` | ${s.role} | ${s.count} | ${s.medianLatencyMs} ms | ${s.totalCostMicroUsd} µ$ | $${costUsd} |`,
    );
  }
  lines.push("");

  lines.push("## Évaluation textuelle détaillée");
  lines.push("");

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    lines.push(`### Cas ${i + 1} : \`${c.id}\``);
    lines.push(`- **Langue déclarée** : \`${c.lang}\``);
    lines.push(`- **Message client** : « ${c.text} »`);
    lines.push("- **Critères à vérifier par l'évaluateur** :");
    for (const exp of c.expect) {
      lines.push(`  - [ ] \`${exp}\``);
    }
    lines.push("");

    lines.push("| Modèle | Réponses (verbatim) | Outils appelés | Passation humain | Latence | Coût |");
    lines.push("|---|---|---|---|---|---|");

    for (const m of chatModels) {
      const res = chatResults[m]?.[c.id];
      if (!res) {
        lines.push(`| \`${m}\` | (non exécuté) | - | - | - | - |`);
        continue;
      }
      const repliesVerbatim = res.replies.length > 0 ? res.replies.join("\n\n") : "(aucune réponse)";
      const toolsStr = res.toolCalls.length > 0 ? res.toolCalls.join(", ") : "-";
      const handoffStr = res.handedOff ? "**Oui (Passé)**" : "Non";
      lines.push(
        `| \`${m}\` | ${escapeMarkdownCell(repliesVerbatim)} | ${escapeMarkdownCell(toolsStr)} | ${handoffStr} | ${res.latencyMs} ms | ${res.costMicroUsd} µ$ |`,
      );
    }
    lines.push("");
  }

  if (audioResults.length > 0) {
    lines.push("## Évaluation des messages vocaux (Audio)");
    lines.push("");

    for (const ar of audioResults) {
      const baseName = path.basename(ar.file);
      lines.push(`### Fichier vocal : \`${baseName}\``);
      lines.push("");
      lines.push("| Modèle Audio | Transcription | Langue détectée | Réponse Agent (chat par défaut) | Latence Audio | Coût Audio |");
      lines.push("|---|---|---|---|---|---|");

      for (const m of audioModels) {
        const item = ar.models[m];
        if (!item) continue;
        const chatVerbatim = item.chatReplies.length > 0 ? item.chatReplies.join("\n\n") : "-";
        lines.push(
          `| \`${m}\` | ${escapeMarkdownCell(item.transcript)} | \`${item.language}\` | ${escapeMarkdownCell(chatVerbatim)} | ${item.audioLatencyMs} ms | ${item.audioCostMicroUsd} µ$ |`,
        );
      }
      lines.push("");
    }
  } else {
    lines.push("## Évaluation des messages vocaux (Audio)");
    lines.push("");
    lines.push(
      "_Aucun fichier audio trouvé dans `scripts/whatsapp-eval/audio/`. Pour évaluer les modèles vocaux, déposez des fichiers .ogg, .mp3 ou .m4a dans ce dossier._",
    );
    lines.push("");
  }

  return lines.join("\n");
}

async function main() {
  const options = parseCliArgs();

  if (options.help) {
    printUsage();
    process.exit(0);
  }

  const live = process.env.WHATSAPP_EVAL_LIVE === "1";
  const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();

  // Chargement des cas
  const casesPath = path.join(__dirname, "cases.json");
  if (!fs.existsSync(casesPath)) {
    console.error(`Erreur: fichier introuvable : ${casesPath}`);
    process.exit(1);
  }
  const allCases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  const cases = options.caseFilter
    ? allCases.filter((c) => options.caseFilter.includes(c.id))
    : allCases;

  if (cases.length === 0) {
    console.error("Erreur: aucun cas sélectionné.");
    process.exit(1);
  }

  const audioFiles = getAudioFiles();

  // Garde de sécurité absolue
  if (!live || !apiKey || !options.yes) {
    console.error("\n========================================================");
    console.error("  REFUS D'EXÉCUTION DU BANC D'ÉVALUATION DARIJA");
    console.error("========================================================");

    if (!live) {
      console.error("  - Variable WHATSAPP_EVAL_LIVE=1 absente de l'environnement.");
    }
    if (!apiKey) {
      console.error("  - Variable OPENROUTER_API_KEY absente ou vide.");
    }
    if (!options.yes) {
      console.error("  - Option --yes requise pour confirmer les appels réseau réels.");
    }

    printCostEstimate(
      cases.length,
      options.chatModels.length,
      audioFiles.length,
      options.audioModels.length,
    );

    console.error(`
Pour exécuter ce banc avec des appels réels :
  WHATSAPP_EVAL_LIVE=1 OPENROUTER_API_KEY="sk-or-v1-..." npm run eval:whatsapp -- --yes
`);
    process.exit(1);
  }

  console.log("=== Lancement du banc d'évaluation Darija ===");
  console.log(`Modèles Chat : ${options.chatModels.join(", ")}`);
  console.log(`Modèles Audio : ${options.audioModels.join(", ")}`);
  console.log(`Cas sélectionnés : ${cases.length}`);
  console.log(`Fichiers audio détectés : ${audioFiles.length}`);

  const chatResults = {};
  const summary = [];

  // Évaluation des modèles de chat
  for (const model of options.chatModels) {
    console.log(`\n--- Test du modèle chat : ${model} ---`);
    process.env.WHATSAPP_CHAT_MODEL = model;
    process.env.WHATSAPP_CHAT_FALLBACK_MODEL = model;

    const env = setupTempEnvironment();
    chatResults[model] = {};
    const latencies = [];
    let totalModelCost = 0;

    try {
      for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        const res = await runTextCase(c, env.db);
        chatResults[model][c.id] = res;
        latencies.push(res.latencyMs);
        totalModelCost += res.costMicroUsd;
        console.log(
          `  [${i + 1}/${cases.length}] ${c.id.padEnd(35)} -> ${res.latencyMs}ms | ${res.costMicroUsd}µ$ | tools: ${res.toolCalls.join(",") || "-"}`,
        );
      }
    } finally {
      env.cleanup();
    }

    summary.push({
      model,
      role: "chat",
      count: cases.length,
      medianLatencyMs: median(latencies),
      totalCostMicroUsd: totalModelCost,
    });
  }

  // Évaluation des modèles audio si des fichiers sont présents
  const audioResults = [];
  if (audioFiles.length > 0) {
    const defaultChatModel = options.chatModels[0] || DEFAULT_CHAT_MODELS[0];
    console.log(`\n--- Évaluation audio (${audioFiles.length} fichiers) ---`);

    for (const audioFile of audioFiles) {
      const fileReport = { file: audioFile, models: {} };
      console.log(`\nFichier vocal : ${path.basename(audioFile)}`);

      for (const audioModel of options.audioModels) {
        const env = setupTempEnvironment();
        try {
          const res = await runAudioCase(audioFile, audioModel, defaultChatModel, env);
          fileReport.models[audioModel] = res;
          console.log(
            `  Modèle [${audioModel}] -> ${res.audioLatencyMs}ms | ${res.audioCostMicroUsd}µ$ | langue: ${res.language}`,
          );
        } finally {
          env.cleanup();
        }
      }
      audioResults.push(fileReport);
    }

    // Résumé audio par modèle
    for (const audioModel of options.audioModels) {
      const latencies = [];
      let totalAudioCost = 0;
      let count = 0;
      for (const ar of audioResults) {
        const item = ar.models[audioModel];
        if (item) {
          latencies.push(item.audioLatencyMs);
          totalAudioCost += item.audioCostMicroUsd;
          count++;
        }
      }
      summary.push({
        model: audioModel,
        role: "audio",
        count,
        medianLatencyMs: median(latencies),
        totalCostMicroUsd: totalAudioCost,
      });
    }
  }

  // Génération du rapport
  const reportMarkdown = generateReport({
    chatModels: options.chatModels,
    audioModels: options.audioModels,
    cases,
    chatResults,
    audioResults,
    summary,
  });

  const reportsDir = path.join(__dirname, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const reportPath = path.join(reportsDir, `${timestamp}.md`);
  fs.writeFileSync(reportPath, reportMarkdown, "utf8");

  console.log(`\n✅ Évaluation terminée avec succès.`);
  console.log(`Rapport généré : ${reportPath}`);
}

main().catch((err) => {
  console.error("Erreur fatale:", sanitizeSecret(err.message || String(err), process.env.OPENROUTER_API_KEY));
  process.exit(1);
});
