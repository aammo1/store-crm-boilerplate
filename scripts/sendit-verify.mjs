#!/usr/bin/env node
// Sendit — read-only live verification (task-16).
//
// ⚠️  NE PAS EXÉCUTER sans l'autorisation explicite du propriétaire
// (docs/operations.md, activation Sendit). Ce script effectue de VRAIS
// appels réseau vers l'API Sendit. Il est volontairement gardé derrière les
// drapeaux --live et --yes et la présence des identifiants dans l'environnement.
//
// Opérations effectuées (lecture seule, aucune création de colis ni modification DB) :
//   1. POST /login                  → vérification des clés (affiche OK, jamais le jeton)
//   2. GET  /districts?page=N       → total, districts de ramassage, 3 exemples nom / arabe, prix entiers
//   3. Optionnel (--code CODE)      → GET /deliveries/{code} : statut brut, statut connu, clés observées
//
// Usage:
//   SENDIT_PUBLIC_KEY=... SENDIT_SECRET_KEY=... node scripts/sendit-verify.mjs --live --yes
//   npm run sendit:verify -- --live --yes [--code CODE]
//
// Les identifiants et jetons ne sont JAMAIS affichés.

import fs from "node:fs";

const TIMEOUT_MS = 20_000;
const DEFAULT_BASE_URL = "https://app.sendit.ma/api/v1";

// Statuts Sendit connus du CRM (garder aligné avec src/lib/shipping/status-map.ts).
const KNOWN_SENDIT_STATUSES = new Set([
  "PENDING",
  "TO_PREPARE",
  "TOPICKUP",
  "PICKEDUP",
  "TRANSIT",
  "WAREHOUSE",
  "DISTRIBUTED",
  "DELIVERING",
  "UNREACHABLE",
  "POSTPONED",
  "NEW_DESTINATION",
  "DELIVERED",
  "REJECTED",
  "RETURNED",
  "CANCELED",
  // Alias supportés
  "TO_PICKUP",
  "PICKED_UP",
  "CANCELLED",
  "IN_TRANSIT",
  "RETOUR",
  "RETURN",
]);

// Clés standard observées dans l'objet livraison Sendit.
const KNOWN_DELIVERY_KEYS = new Set([
  "code",
  "reference",
  "status",
  "status_code",
  "id",
  "name",
  "phone",
  "address",
  "amount",
  "comment",
  "allow_open",
  "allow_try",
  "products",
  "district_id",
  "pickup_district_id",
  "created_at",
  "updated_at",
  "tracking_url",
  "label_url",
  "city",
  "ville",
  "district",
]);

const knownSecrets = [];

function addSecret(secret) {
  if (secret && typeof secret === "string" && secret.trim().length >= 3) {
    knownSecrets.push(secret.trim());
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redact(text) {
  if (typeof text !== "string") {
    text =
      text === undefined
        ? "undefined"
        : text === null
        ? "null"
        : typeof text === "object"
        ? JSON.stringify(text)
        : String(text);
  }
  let out = text
    .replace(
      /([?&](?:api[_-]?key|apikey|key|token|secret|password|authorization|public_key|secret_key)=)[^&#\s]+/gi,
      "$1***",
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***")
    .replace(
      /("(?:public_key|secret_key|token|access_token)"\s*:\s*")[^"]*"/gi,
      '$1***"',
    )
    .replace(/\/customers\/[^/?#\s]*\/[^/?#\s]*/gi, "/customers/***/***");

  for (const s of knownSecrets) {
    out = out.replace(new RegExp(escapeRegExp(s), "gi"), "***");
  }
  return out;
}

function printLog(...args) {
  console.log(...args.map((a) => (typeof a === "string" ? redact(a) : redact(JSON.stringify(a, null, 2)))));
}

function printError(...args) {
  console.error(...args.map((a) => (typeof a === "string" ? redact(a) : redact(JSON.stringify(a, null, 2)))));
}

function formatError(err) {
  if (!err) return "erreur inconnue";
  const msg = err.message || String(err);
  const cause = err.cause?.message || (typeof err.cause === "string" ? err.cause : "");
  if (cause && !msg.includes(cause)) {
    return `${msg} (${cause})`;
  }
  return msg;
}

const usage = `
Usage (LECTURE SEULE — autorisation propriétaire requise):
  SENDIT_PUBLIC_KEY=... SENDIT_SECRET_KEY=... node scripts/sendit-verify.mjs --live --yes [--code CODE]
  npm run sendit:verify -- --live --yes [--code CODE]

Options:
  --live       Garde explicite : confirme qu'il s'agit d'appels réseau réels.
  --yes        Confirmation explicite : effectue réellement les appels réseau.
  --code CODE  Code de suivi réel Sendit : affiche le statut brut et la forme des données.
`.trim();

// Charge .env.local (KEY=VALUE) sans jamais afficher les valeurs.
function loadEnvLocal() {
  try {
    const raw = fs.readFileSync(".env.local", "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[m[1]] = val;
      }
    }
  } catch {
    // Pas de .env.local — seules les variables d'environnement comptent.
  }
}

function pickLastPage(body) {
  if (body && typeof body === "object") {
    if (typeof body.last_page === "number") return body.last_page;
    if (body.meta && typeof body.meta.last_page === "number") return body.meta.last_page;
    if (body.data && typeof body.data.last_page === "number") return body.data.last_page;
  }
  return 1;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    return;
  }
  if (!args.includes("--live")) {
    printError("ATTENTION : ce script effectue de VRAIS appels réseau vers l'API Sendit (lecture seule).");
    printError("Refusé : relancez avec --live (et --yes) après autorisation explicite du propriétaire.");
    process.exit(1);
  }
  if (!args.includes("--yes")) {
    printError("Refusé : ce script effectue de vrais appels Sendit. Relancez avec --yes après autorisation du propriétaire.");
    process.exit(1);
  }

  loadEnvLocal();
  const publicKey = process.env.SENDIT_PUBLIC_KEY?.trim();
  const secretKey = process.env.SENDIT_SECRET_KEY?.trim();
  if (!publicKey || !secretKey) {
    printError("Refusé : SENDIT_PUBLIC_KEY / SENDIT_SECRET_KEY absents de l'environnement (ou .env.local).");
    process.exit(1);
  }
  addSecret(publicKey);
  addSecret(secretKey);

  const baseUrl = (process.env.SENDIT_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");

  printLog("=== Vérification Sendit LIVE (lecture seule) ===");
  printLog(`Base URL : ${baseUrl}`);

  // 1. Authentification
  let token;
  try {
    const res = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ public_key: publicKey, secret_key: secretKey }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    let text = "";
    try {
      text = await res.text();
    } catch (err) {
      printError(`Échec lors de la lecture de la réponse de connexion : ${formatError(err)}`);
      process.exit(1);
    }

    if (res.status === 401 || res.status === 403) {
      printError(`Échec de connexion (HTTP ${res.status}) : clés Sendit refusées.`);
      process.exit(1);
    }
    if (!res.ok) {
      printError(`Échec de connexion (HTTP ${res.status}).`);
      process.exit(1);
    }

    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      printError("Réponse de connexion Sendit non-JSON.");
      process.exit(1);
    }

    const rawToken =
      body && typeof body === "object"
        ? body.data && typeof body.data === "object" && typeof body.data.token === "string"
          ? body.data.token.trim()
          : typeof body.token === "string"
          ? body.token.trim()
          : null
        : null;

    if (!rawToken) {
      printError("Jeton manquant dans la réponse Sendit.");
      process.exit(1);
    }

    token = rawToken;
    addSecret(token);
    printLog("Connexion : OK");
  } catch (err) {
    printError(`Échec de connexion vers Sendit : ${formatError(err)}`);
    process.exit(1);
  }

  // 2. Téléchargement des districts (toutes les pages, max 50)
  const districts = [];
  let page = 1;
  let lastPage = 1;

  while (page <= 50) {
    let res;
    let text = "";
    try {
      res = await fetch(`${baseUrl}/districts?page=${page}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      text = await res.text();
    } catch (err) {
      printError(`Échec du téléchargement des districts (page ${page}) : ${formatError(err)}`);
      process.exit(1);
    }

    if (!res.ok) {
      printError(`Échec du téléchargement des districts (page ${page}, HTTP ${res.status}).`);
      process.exit(1);
    }

    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      printError(`Réponse districts page ${page} non-JSON.`);
      process.exit(1);
    }

    let items = [];
    if (body && typeof body === "object") {
      if (Array.isArray(body.data)) {
        items = body.data;
      } else if (Array.isArray(body)) {
        items = body;
      } else if (body.data && typeof body.data === "object") {
        items = Object.values(body.data);
      }
    }

    for (const row of items) {
      if (!row || typeof row !== "object") continue;
      const id = Number(row.id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const name = typeof row.name === "string" ? row.name.trim() : "";
      if (!name) continue;

      const rawAr =
        typeof row.arabic_name === "string"
          ? row.arabic_name
          : typeof row.name_ar === "string"
          ? row.name_ar
          : typeof row.arabicName === "string"
          ? row.arabicName
          : null;
      let arabicName = null;
      if (rawAr) {
        const cleaned = rawAr.replace(/\u0640/g, "").replace(/\s+/g, " ").trim();
        if (/\p{Script=Arabic}/u.test(cleaned)) {
          arabicName = cleaned;
        }
      }

      const pickup = Boolean(
        row.pickup_district == 1 ||
          (typeof row.ville === "string" && row.ville.trim().toLowerCase() === "casablanca") ||
          (typeof row.name === "string" && row.name.trim().toLowerCase() === "casablanca"),
      );

      let hasIntegerPrice = false;
      if (row.price !== undefined && row.price !== null) {
        const p = Number(row.price);
        if (Number.isInteger(p) && p >= 0) {
          hasIntegerPrice = true;
        }
      }

      districts.push({ id, name, arabicName, pickup, hasIntegerPrice });
    }

    lastPage = pickLastPage(body);
    if (!Number.isInteger(lastPage) || lastPage < 1) lastPage = 1;
    if (page >= lastPage || page >= 50) {
      break;
    }
    page++;
  }

  if (districts.length === 0) {
    printError("Erreur : aucun district reçu de Sendit.");
    process.exit(1);
  }

  const pickupCount = districts.filter((d) => d.pickup).length;
  const priceCount = districts.filter((d) => d.hasIntegerPrice).length;
  const withArabic = districts.filter((d) => Boolean(d.arabicName));
  const sampleDistricts = (withArabic.length >= 3 ? withArabic : districts).slice(0, 3);

  printLog("\n--- Districts ---");
  printLog(`Total de districts téléchargés : ${districts.length}`);
  printLog(`Districts de ramassage éligibles : ${pickupCount}`);
  printLog(`Districts avec tarif entier (price) : ${priceCount}`);
  printLog("Échantillon (nom / nom arabe) :");
  for (const s of sampleDistricts) {
    printLog(`  - ${s.name} / ${s.arabicName || "(non renseigné)"}`);
  }

  // 3. Optionnel : inspection d'un colis réel (--code CODE)
  const codeIndex = args.indexOf("--code");
  const parcelCode = codeIndex !== -1 ? args[codeIndex + 1] : undefined;
  if (codeIndex !== -1 && (!parcelCode || parcelCode.startsWith("--"))) {
    printError("Refusé : l'option --code nécessite un identifiant de colis (ex. --code SEN123456).");
    process.exit(1);
  }

  if (parcelCode) {
    const cleanCode = parcelCode.trim();
    let res;
    let text = "";
    try {
      res = await fetch(`${baseUrl}/deliveries/${encodeURIComponent(cleanCode)}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      text = await res.text();
    } catch (err) {
      printError(`Échec lors de la récupération du colis ${cleanCode} : ${formatError(err)}`);
      process.exit(1);
    }

    if (res.status === 404) {
      printError(`Colis ${cleanCode} introuvable chez Sendit (HTTP 404).`);
      process.exit(1);
    }

    if (!res.ok) {
      printError(`Échec lors de la récupération du colis ${cleanCode} (HTTP ${res.status}).`);
      process.exit(1);
    }

    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      printError(`Réponse du colis ${cleanCode} non-JSON.`);
      process.exit(1);
    }

    if (body && typeof body === "object" && body.success === false) {
      printError(
        `Sendit a renvoyé une erreur pour le colis ${cleanCode} : ${body.message || "erreur inconnue"}`,
      );
      process.exit(1);
    }

    const d =
      body && typeof body === "object" && body.data && typeof body.data === "object"
        ? body.data
        : body;

    if (!d || typeof d !== "object") {
      printError(`Format de données inattendu pour le colis ${cleanCode}.`);
      process.exit(1);
    }

    const code = d.code !== undefined && d.code !== null ? String(d.code).trim() : cleanCode;
    const reference =
      d.reference !== undefined && d.reference !== null ? String(d.reference).trim() : "(non renseignée)";

    let rawStatus = null;
    if (typeof d.status === "string") {
      rawStatus = d.status.trim();
    } else if (d.status && typeof d.status === "object" && typeof d.status.code === "string") {
      rawStatus = d.status.code.trim();
    } else if (typeof d.status_code === "string") {
      rawStatus = d.status_code.trim();
    } else if (d.status !== undefined && d.status !== null) {
      rawStatus = typeof d.status === "object" ? JSON.stringify(d.status) : String(d.status);
    }

    const statusKey = rawStatus ? rawStatus.toUpperCase() : "";
    const isKnown = Boolean(statusKey && KNOWN_SENDIT_STATUSES.has(statusKey));

    const dataKeys = Object.keys(d);
    const unknownKeys = dataKeys.filter((k) => !KNOWN_DELIVERY_KEYS.has(k));
    const otherKeys = dataKeys.filter((k) => !["code", "reference", "status", "status_code"].includes(k));

    printLog(`\n--- Détails du colis ${cleanCode} ---`);
    printLog(`Code : ${code}`);
    printLog(`Référence : ${reference}`);
    printLog(`Statut brut : ${rawStatus || "(aucun)"} (${isKnown ? "connu" : "ATTENTION : INCONNU du CRM"})`);
    printLog(`Clés inconnues dans data (noms seuls) : ${unknownKeys.length > 0 ? unknownKeys.join(", ") : "aucune"}`);
    printLog(`Autres champs présents dans data (noms seuls) : ${otherKeys.length > 0 ? otherKeys.join(", ") : "aucun"}`);
  } else {
    printLog("\n(aucun code fourni — étape de vérification d'un colis ignorée)");
  }

  printLog("\n=== Vérification Sendit terminée avec succès ===");
}

main().catch((err) => {
  printError(`Erreur inattendue : ${formatError(err)}`);
  process.exit(1);
});
