#!/usr/bin/env node
// New-niche wizard: writes store.config.ts, .env.local, .env.production.example,
// processed brand assets in public/brand and creates the first admin user.
//
//   npm run new-store
//   node scripts/new-store.mjs --answers examples/new-store-answers.json [--force] [--skip-user]
//   Options: --root <dir> (target repo, default: this repo), --no-typecheck,
//            --slug <slug> (overrides the answers-file slug; interactive default)
//   In --answers mode an empty adminPassword is generated and printed once.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import sharp from "sharp";
import { renderConfig } from "./new-store/template.mjs";
import { envText, envValues, PRODUCTION_ENV_HEADER } from "./new-store/env.mjs";
import { copyPresets } from "./new-store/copy-presets.mjs";
import { categorySlugs, normalizeDomain, randomStoreSlug, slugify, slugifyWithArabic } from "./new-store/slug.mjs";

export { slugify };

const MARKER = "// new-store:template";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------- argv ----------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const ROOT = path.resolve(option("--root") ?? path.join(SCRIPT_DIR, ".."));
const FORCE = flag("--force");
const SKIP_USER = flag("--skip-user");
const NO_TYPECHECK = flag("--no-typecheck");
const answersFile = option("--answers");
const SLUG_OVERRIDE = option("--slug");
// Former example password: refuse it so a copied example never becomes a real admin login.
const EXAMPLE_PASSWORDS = new Set(["changez-moi-12-caracteres-minimum"]);

class FieldError extends Error {}
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

// ---------- normalisers / validators (shared by interactive and --answers) ----------
const str = (v) => (v == null ? "" : String(v).trim());

export function normalizeWhatsapp(value) {
  const digits = str(value).replace(/[\s.\-()]/g, "");
  let m;
  if ((m = /^0([67]\d{8})$/.exec(digits))) return `212${m[1]}`;
  if ((m = /^(?:\+|00)?212([67]\d{8})$/.exec(digits))) return `212${m[1]}`;
  throw new FieldError("numéro invalide (attendu : 06…, +2126… ou 2126…, mobile marocain)");
}

export function normalizeHex(value) {
  const v = str(value).replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(v)) return `#${[...v].map((c) => c + c).join("").toLowerCase()}`;
  if (/^[0-9a-fA-F]{6}$/.test(v)) return `#${v.toLowerCase()}`;
  throw new FieldError("couleur hexadécimale invalide (attendu : #RRGGBB)");
}

const FIELDS = [
  { key: "name", prompt: "Nom de la boutique", required: true, group: "Identité",
    parse: (v) => { if (!v || v.length > 60) throw new FieldError("1 à 60 caractères attendus"); return v; } },
  { key: "slug", prompt: "Slug", group: "Identité", default: (a) => {
      if (SLUG_OVERRIDE) return SLUG_OVERRIDE;
      const slug = slugifyWithArabic(a.name).slice(0, 40).replace(/-+$/, "");
      if (slug.length >= 2) return slug;
      const fallback = randomStoreSlug();
      console.log(`  Avis : impossible de dériver un slug du nom « ${a.name} » ; « ${fallback} » proposé. Confirmez-le ou indiquez le vôtre (champ « slug »).`);
      return fallback;
    },
    parse: (v) => { if (!/^[a-z0-9-]{2,40}$/.test(v)) throw new FieldError("2 à 40 caractères : a-z, 0-9, tiret"); return v; } },
  { key: "domain", prompt: "Domaine (https://…)", required: true, group: "Identité",
    parse: (v) => {
      try { return normalizeDomain(v); } catch (error) { throw new FieldError(error.message); }
    } },
  { key: "locale", prompt: "Langue (fr/ar)", default: () => "fr",
    parse: (v) => { if (v !== "fr" && v !== "ar") throw new FieldError("« fr » ou « ar » attendu"); return v; } },
  { key: "niche", prompt: "Niche (texte libre, ex. bijoux, abayas)", optional: true,
    parse: (v) => { if (v.length > 60) throw new FieldError("60 caractères maximum"); return v; } },
  { key: "city", prompt: "Ville", required: true,
    parse: (v) => { if (!v || v.length > 60) throw new FieldError("1 à 60 caractères attendus"); return v; } },
  { key: "whatsapp", prompt: "WhatsApp (06…, +2126… ou 2126…)", required: true, group: "Contact", parse: normalizeWhatsapp },
  { key: "phone", prompt: "Téléphone affiché", default: (a) => a.whatsappRaw ?? "",
    parse: (v) => { if (!v) throw new FieldError("valeur requise"); return v; } },
  { key: "email", prompt: "Email de contact (optionnel)", optional: true,
    parse: (v) => { if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new FieldError("email invalide"); return v; } },
  { key: "logoPath", prompt: "Chemin du logo (PNG/JPG/SVG/WebP, vide = monogramme)", optional: true, group: "Marque",
    parse: (v) => {
      if (!v) return "";
      const p = path.resolve(process.cwd(), v.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new FieldError(`fichier introuvable : ${v}`);
      return p;
    } },
  { key: "primaryColor", prompt: "Couleur principale (hex)", default: () => "#1f2937", parse: normalizeHex },
  { key: "accentColor", prompt: "Couleur d'accent (hex)", default: () => "#d97706", parse: normalizeHex },
  { key: "style", prompt: "Style (1 = élégant, 2 = moderne, 3 = arabe)", default: (a) => (a.locale === "ar" ? "3" : "1"),
    parse: (v) => { if (!["1", "2", "3"].includes(v)) throw new FieldError("1, 2 ou 3 attendu"); return v; } },
  { key: "radius", prompt: "Arrondis (none/sm/md/lg/full)", default: () => "md",
    parse: (v) => { if (!["none", "sm", "md", "lg", "full"].includes(v)) throw new FieldError("none, sm, md, lg ou full attendu"); return v; } },
  { key: "heroImage", prompt: "Image principale (chemin, vide = dégradé)", optional: true,
    parse: (v) => {
      if (!v) return "";
      const p = path.resolve(process.cwd(), v);
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new FieldError(`fichier introuvable : ${v}`);
      return p;
    } },
  { key: "categories", prompt: "Catégories (séparées par des virgules)", group: "Catalogue", default: () => "Nouveautés",
    parse: (v) => {
      const labels = (Array.isArray(v) ? v : str(v).split(",")).map(str).filter(Boolean);
      if (labels.length === 0 || labels.length > 12) throw new FieldError("1 à 12 catégories attendues");
      return categorySlugs(labels);
    } },
  { key: "metaPixelId", prompt: "Meta Pixel ID (optionnel)", optional: true, group: "Suivi (optionnel)",
    parse: (v) => { if (v && !/^\d{5,20}$/.test(v)) throw new FieldError("5 à 20 chiffres attendus"); return v; } },
  { key: "metaAccessToken", prompt: "Meta access token (optionnel)", optional: true, secret: true, parse: str },
  { key: "tiktokPixelId", prompt: "TikTok pixel code (optionnel)", optional: true,
    parse: (v) => { if (v && !/^[A-Z0-9]{10,30}$/.test(v)) throw new FieldError("10 à 30 caractères A-Z/0-9 attendus"); return v; } },
  { key: "tiktokAccessToken", prompt: "TikTok access token (optionnel)", optional: true, secret: true, parse: str },
  { key: "ozonClientId", prompt: "Ozon Client ID (optionnel)", optional: true, group: "Ozon (optionnel, peut être fait plus tard)", parse: str },
  { key: "ozonApiKey", prompt: "Ozon API key (optionnel)", optional: true, secret: true, parse: str },
  { key: "adminEmail", prompt: "Email", required: true, group: "Administrateur", userOnly: true,
    parse: (v) => {
      if (v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new FieldError("email invalide");
      return v.toLowerCase();
    } },
  { key: "adminName", prompt: "Nom", default: () => "Administrateur", userOnly: true,
    parse: (v) => { if (!v || v.length > 120) throw new FieldError("1 à 120 caractères attendus"); return v; } },
  { key: "adminPassword", prompt: "Mot de passe (12 à 128 caractères)", required: true, hidden: true, confirm: true, userOnly: true,
    parse: (v) => {
      if (v.length < 12 || v.length > 128) throw new FieldError("12 à 128 caractères attendus");
      return v;
    } },
];

// ---------- prompting ----------
function createPrompter() {
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
  return {
    async ask(label, { hidden = false } = {}) {
      process.stdout.write(label);
      muted = hidden;
      try {
        return await rl.question("");
      } finally {
        muted = false;
        if (hidden) process.stdout.write("\n");
      }
    },
    close: () => rl.close(),
  };
}

async function collectInteractive(skipUser) {
  const prompter = createPrompter();
  const answers = {};
  let group = "";
  console.log("Assistant de création de boutique. Les valeurs entre crochets sont les défauts.\n");
  try {
    for (const field of FIELDS) {
      if (field.userOnly && skipUser) continue;
      if (field.group && field.group !== group) {
        group = field.group;
        console.log(`\n== ${group} ==`);
      }
      const def = field.default ? str(field.default(answers)) : "";
      for (;;) {
        const hint = field.hidden ? "" : def ? ` [${def}]` : field.optional ? " []" : "";
        const raw = str(await prompter.ask(`${field.prompt}${hint} : `, { hidden: field.hidden }));
        const input = raw || def;
        try {
          if (field.required && !input) throw new FieldError("valeur requise");
          const value = field.parse(input);
          if (field.confirm) {
            const again = str(await prompter.ask(`${field.prompt} (confirmation) : `, { hidden: true }));
            if (again !== raw) throw new FieldError("les deux saisies ne correspondent pas");
          }
          answers[field.key] = value;
          if (field.key === "whatsapp") answers.whatsappRaw = raw;
          break;
        } catch (error) {
          if (!(error instanceof FieldError)) throw error;
          console.log(`  Réponse invalide : ${error.message}`);
        }
      }
    }
  } finally {
    prompter.close();
  }
  return answers;
}

function collectFromFile(file, skipUser) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), "utf8"));
  } catch (error) {
    fail(`Fichier de réponses illisible (${file}) : ${error.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("Le fichier de réponses doit être un objet JSON.");
  const known = new Set(FIELDS.map((f) => f.key));
  const unknown = Object.keys(raw).filter((k) => !known.has(k) && !k.startsWith("_"));
  if (unknown.length) fail(`Champs inconnus dans le fichier de réponses : ${unknown.join(", ")}`);

  const answers = {};
  for (const field of FIELDS) {
    if (field.userOnly && skipUser) continue;
    const provided = raw[field.key];
    const given = Array.isArray(provided) ? provided : str(provided);
    // Relative asset paths resolve from the answers file directory.
    const base = path.dirname(path.resolve(process.cwd(), file));
    const resolved = (field.key === "logoPath" || field.key === "heroImage") && given && !path.isAbsolute(given)
      ? path.resolve(base, given) : given;
    const empty = Array.isArray(given) ? given.length === 0 : given === "";
    const def = field.default ? str(field.default(answers)) : "";
    let input = empty ? def : resolved;
    // --slug wins over the answers file so external launchers keep one store name everywhere.
    if (field.key === "slug" && SLUG_OVERRIDE) input = SLUG_OVERRIDE;
    if (field.key === "adminPassword") {
      if (EXAMPLE_PASSWORDS.has(input)) {
        fail("Champ « adminPassword » : le mot de passe d'exemple est refusé. Laissez-le vide pour en générer un, ou choisissez le vôtre.");
      }
      if (empty) {
        input = crypto.randomBytes(18).toString("base64url");
        answers.generatedAdminPassword = true;
      }
    }
    try {
      if (field.required && (Array.isArray(input) ? input.length === 0 : !input)) throw new FieldError("valeur requise");
      answers[field.key] = field.parse(input);
      if (field.key === "whatsapp") answers.whatsappRaw = str(raw.whatsapp);
    } catch (error) {
      if (!(error instanceof FieldError)) throw error;
      fail(`Champ « ${field.key} » invalide : ${error.message}`);
    }
  }
  return answers;
}

// ---------- colours ----------
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c) => `#${c.map((n) => Math.round(n).toString(16).padStart(2, "0")).join("")}`;
const luminance = (hex) => {
  const [r, g, b] = rgb(hex).map((n) => {
    const s = n / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const mixIntoWhite = (hex, amount) => toHex(rgb(hex).map((n) => 255 * (1 - amount) + n * amount));

export const accentForeground = (accent) =>
  contrast(accent, "#ffffff") >= contrast(accent, "#111827") ? "#ffffff" : "#111827";

export function deriveColors(primary, accent) {
  return {
    primary,
    primaryForeground: contrast(primary, "#ffffff") >= contrast(primary, "#111111") ? "#ffffff" : "#111111",
    accent,
    accentForeground: accentForeground(accent),
    background: "#ffffff",
    foreground: "#111827",
    muted: mixIntoWhite(primary, 0.06),
    border: mixIntoWhite(primary, 0.14),
  };
}

const STYLES = {
  1: { heading: "playfair", body: "inter" },
  2: { heading: "inter", body: "inter" },
  3: { heading: "cairo", body: "cairo" },
};

// ---------- brand assets ----------
const escapeXml = (s) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);

function monogramSvg(name, colors) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]).join("").toUpperCase() || "?";
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">` +
      `<rect width="400" height="400" rx="80" fill="${colors.primary}"/>` +
      `<text x="200" y="262" font-family="sans-serif" font-size="190" font-weight="700" text-anchor="middle" fill="${colors.primaryForeground}">${escapeXml(initials)}</text></svg>`,
  );
}

const hash8 = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 8);

async function buildBrandAssets(answers, colors, brandDir) {
  fs.mkdirSync(brandDir, { recursive: true });
  const existing = new Set(fs.readdirSync(brandDir));
  const input = answers.logoPath ? fs.readFileSync(answers.logoPath) : monogramSvg(answers.name, colors);
  const isSvg = !answers.logoPath || /\.svg$/i.test(answers.logoPath);
  const base = () => sharp(input, isSvg ? { density: 300 } : {}).rotate();

  let trimmed;
  try {
    trimmed = await base().trim().png().toBuffer();
  } catch {
    trimmed = await base().png().toBuffer();
  }
  const logoBuf = await sharp(trimmed).resize({ height: 96 }).webp({ quality: 90 }).toBuffer();
  const logoMeta = await sharp(logoBuf).metadata();
  const logoName = `logo-${hash8(logoBuf)}.webp`;
  fs.writeFileSync(path.join(brandDir, logoName), logoBuf);

  const glyph = await sharp(trimmed).resize(432, 432, { fit: "inside" }).png().toBuffer();
  const iconBuf = await sharp({ create: { width: 512, height: 512, channels: 3, background: colors.background } })
    .composite([{ input: glyph, gravity: "center" }])
    .png()
    .toBuffer();
  const iconName = `icon-${hash8(iconBuf)}.png`;
  fs.writeFileSync(path.join(brandDir, iconName), iconBuf);

  let heroName = "hero-placeholder.webp";
  let heroBuf;
  if (answers.heroImage) {
    heroBuf = await sharp(fs.readFileSync(answers.heroImage)).rotate().resize(1600, 900, { fit: "cover" }).webp({ quality: 82 }).toBuffer();
    heroName = `hero-${hash8(heroBuf)}.webp`;
  } else {
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
        `<stop offset="0" stop-color="${colors.primary}"/><stop offset="1" stop-color="${answers.accentColor}"/></linearGradient></defs>` +
        `<rect width="1600" height="900" fill="url(#g)"/></svg>`,
    );
    heroBuf = await sharp(svg).webp({ quality: 82 }).toBuffer();
  }
  fs.writeFileSync(path.join(brandDir, heroName), heroBuf);

  // Superseded files from earlier wizard runs (only these patterns) are removed by
  // the caller after the TypeScript check passes.
  const keep = new Set([logoName, iconName, heroName]);
  const obsolete = existing.size === 0 ? [] : [...existing].filter((file) => !keep.has(file) &&
    (/^logo-[0-9a-f]{8}\.webp$/.test(file) || /^icon-[0-9a-f]{8}\.png$/.test(file) || /^hero-[0-9a-f]{8}\.webp$/.test(file)));
  const created = [...keep].filter((file) => !existing.has(file));

  const displayHeight = 48;
  return {
    logo: `/brand/${logoName}`,
    logoWidth: Math.max(1, Math.round(((logoMeta.width ?? 96) * displayHeight) / (logoMeta.height ?? 96))),
    logoHeight: displayHeight,
    icon: `/brand/${iconName}`,
    heroImage: `/brand/${heroName}`,
    obsolete,
    created,
  };
}

function ensureGitignore(root) {
  const file = path.join(root, ".gitignore");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(".env*")) return;
  const next = `${current}${current && !current.endsWith("\n") ? "\n" : ""}.env*\n${lines.includes("!.env.example") ? "" : "!.env.example\n"}`;
  fs.writeFileSync(file, next);
}

function readEnvValue(file, key) {
  if (!fs.existsSync(file)) return undefined;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = new RegExp(`^${key}=(.*)$`).exec(line);
    if (m) return m[1].trim().replace(/^"(.*)"$/, "$1");
  }
  return undefined;
}

function writeTemplateVersion(root) {
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown";
  } catch {}
  const info = { template: "store-crm-boilerplate", commit, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(root, ".template-version"), `${JSON.stringify(info, null, 2)}\n`);
}

// ---------- main ----------
async function main() {
  const configPath = path.join(ROOT, "store.config.ts");
  if (!fs.existsSync(configPath)) fail(`store.config.ts introuvable dans ${ROOT}.`);
  if (!FORCE && !fs.readFileSync(configPath, "utf8").includes(MARKER)) {
    fail(
      "store.config.ts a déjà été personnalisé (le marqueur « // new-store:template » est absent).\n" +
        "Relancez avec --force pour l'écraser, ou modifiez le fichier à la main.",
    );
  }

  const answers = answersFile
    ? collectFromFile(answersFile, SKIP_USER)
    : await collectInteractive(SKIP_USER);

  const colors = deriveColors(answers.primaryColor, answers.accentColor);
  const accentRatio = contrast(answers.accentColor, colors.accentForeground);
  if (accentRatio < 4.5) {
    console.log(`Avis : la couleur d'accent ${answers.accentColor} n'atteint pas le contraste WCAG AA (4,5:1) avec le texte des boutons (${accentRatio.toFixed(2).replace(".", ",")}:1). Choisissez une couleur plus claire ou plus foncée.`);
  }
  const brandDir = path.join(ROOT, "public", "brand");
  const assets = await buildBrandAssets(answers, colors, brandDir);
  const copy = copyPresets(answers.locale, { name: answers.name, city: answers.city, niche: answers.niche });

  const source = renderConfig({
    slug: answers.slug,
    name: answers.name,
    domain: answers.domain,
    locale: answers.locale,
    city: answers.city,
    contact: { whatsapp: answers.whatsapp, phone: answers.phone, email: answers.email },
    brand: {
      logo: assets.logo,
      logoWidth: assets.logoWidth,
      logoHeight: assets.logoHeight,
      icon: assets.icon,
      colors,
      fonts: STYLES[answers.style],
      radius: answers.radius,
    },
    categories: answers.categories,
    tracking: { metaPixelId: answers.metaPixelId, tiktokPixelId: answers.tiktokPixelId },
    heroImage: assets.heroImage,
    copy,
  });
  const previousConfig = fs.readFileSync(configPath, "utf8");
  fs.writeFileSync(configPath, source);

  if (!NO_TYPECHECK && fs.existsSync(path.join(ROOT, "tsconfig.json")) && fs.existsSync(path.join(ROOT, "node_modules"))) {
    const tsc = spawnSync("npx", ["tsc", "--noEmit", "-p", "."], { cwd: ROOT, encoding: "utf8" });
    if (tsc.status !== 0) {
      fs.writeFileSync(configPath, previousConfig);
      for (const file of assets.created) fs.rmSync(path.join(brandDir, file), { force: true });
      console.error(`${tsc.stdout}${tsc.stderr}`);
      fail(
        "Le store.config.ts généré ne passe pas la vérification TypeScript ; l'ancien fichier a été restauré.\n" +
          `Fichiers restaurés : store.config.ts. Anciens logos/icônes/images conservés dans public/brand${assets.created.length ? `, nouveaux fichiers supprimés (${assets.created.join(", ")})` : ""}.`,
      );
    }
  } else {
    console.log("Vérification TypeScript ignorée (tsconfig.json ou node_modules absent).");
  }

  // New config verified: now it is safe to drop superseded brand assets.
  for (const file of assets.obsolete) fs.rmSync(path.join(brandDir, file), { force: true });

  writeTemplateVersion(ROOT);

  // .env files (secrets never printed; CATALOG_AGENT_KEY is shared between .env.local and
  // .env.production.example so ~/.config/<store>/catalog-agent.env works seamlessly after deploy)
  const envLocal = path.join(ROOT, ".env.local");
  const wroteEnvLocal = FORCE || !fs.existsSync(envLocal);
  let catalogAgentKey = !wroteEnvLocal ? readEnvValue(envLocal, "CATALOG_AGENT_KEY") : undefined;
  if (wroteEnvLocal) {
    const localValues = envValues(answers, { production: false, catalogAgentKey });
    catalogAgentKey = localValues.CATALOG_AGENT_KEY;
    fs.writeFileSync(envLocal, envText(localValues, "# Généré par npm run new-store. Ne pas committer.\n"), { mode: 0o600 });
  } else {
    console.log(".env.local existe déjà : conservé (utilisez --force pour le régénérer).");
  }
  fs.writeFileSync(
    path.join(ROOT, ".env.production.example"),
    envText(envValues(answers, { production: true, catalogAgentKey }), PRODUCTION_ENV_HEADER),
    { mode: 0o600 },
  );
  ensureGitignore(ROOT);
  console.log("Secrets générés ✓");

  if (!SKIP_USER) {
    const dbPath = readEnvValue(envLocal, "DB_PATH") || "./data/crm.db";
    const child = spawnSync(
      process.execPath,
      [path.join(SCRIPT_DIR, "create-user.mjs"), answers.adminEmail, "-", answers.adminName, "admin"],
      {
        cwd: ROOT,
        env: { ...process.env, DB_PATH: path.resolve(ROOT, dbPath), CREATE_USER_PASSWORD: answers.adminPassword },
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
      },
    );
    if (child.status !== 0) {
      console.error(child.stderr || child.stdout);
      fail("Création de l'administrateur impossible (voir ci-dessus).");
    }
    console.log(`Administrateur créé : ${answers.adminEmail}`);
    if (answers.generatedAdminPassword) {
      console.log(`Mot de passe généré (affiché une seule fois, à conserver) : ${answers.adminPassword}`);
    }
  }

  console.log(`
Boutique « ${answers.name} » générée.

Prochaines étapes :
  1. npm run dev  (http://localhost:3000)
  2. Ajoutez vos produits sur /admin
  3. Activez les packs et la page d'atterrissage (/l/<slug>) depuis la fiche produit
  4. Créez l'application Coolify avec un volume sur /app/data, collez .env.production.example et renseignez SECURITY_TRUSTED_IP_HEADER ou SECURITY_ACCEPT_GLOBAL_BUDGETS="1"
  5. Configurez Cloudflare (voir docs/new-niche.md)
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
