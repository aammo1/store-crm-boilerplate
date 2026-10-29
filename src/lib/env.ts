import { COURIERS, type CourierName } from "./shipping/couriers";
import { whatsappEnvIssues } from "./whatsapp/config";

/**
 * Fail-fast runtime environment validation (server-only; never import from
 * client code). Error messages name variables only, never values.
 */
export type DeliveryProviderName = "mock" | CourierName; // "mock" | "ozon" | "sendit"

const MOCK_WARNING = "⚠️ Transporteur fictif (mock) actif en production : aucun colis réel ne sera créé.";
const GLOBAL_BUDGETS_WARNING =
  "⚠️ SECURITY_ACCEPT_GLOBAL_BUDGETS=1 : sans IP client de confiance, un seul client peut épuiser les budgets globaux (commandes, connexions).";

function enforced(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production" && env.NEXT_PHASE !== "phase-production-build";
}

/** Same strictness as browserMutationAllowed: exact origin, no path/userinfo/wildcard. */
function validOrigin(value: string, allowPlainHttp: boolean): boolean {
  try {
    const origin = value.trim();
    const url = new URL(origin);
    if (origin !== url.origin && origin !== `${url.origin}/`) return false;
    if (url.hostname.includes("*")) return false;
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return url.protocol === "https:" || (url.protocol === "http:" && (local || allowPlainHttp));
  } catch {
    return false;
  }
}

function blank(value: string | undefined): boolean {
  return !value || !value.trim();
}

export function deliveryProviderName(env: NodeJS.ProcessEnv = process.env): DeliveryProviderName {
  if (env.DELIVERY_PROVIDER === "mock") return "mock";
  if (env.DELIVERY_PROVIDER === "sendit") return "sendit";
  return "ozon"; // unset or any other value keeps Ozon (AGENTS.md rule)
}

/** Courier the store behaves like. In mock mode: exact MOCK_COURIER_PROFILE=sendit → sendit, else ozon. */
export function courierProfile(env: NodeJS.ProcessEnv = process.env): CourierName {
  const provider = deliveryProviderName(env);
  if (provider !== "mock") return provider;
  return env.MOCK_COURIER_PROFILE === "sendit" ? "sendit" : "ozon";
}

/** Generic courier worker knob with legacy OZON_* fallback. Returns undefined when neither is set/valid. */
export function courierNumberEnv(
  suffix: "SUBMIT_INTERVAL_SEC" | "POLL_INTERVAL_MIN" | "TRACK_BATCH",
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  for (const key of [`COURIER_${suffix}`, `OZON_${suffix}`]) {
    const raw = env[key];
    if (raw === undefined || raw.trim() === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function validateRuntimeEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (!enforced(env)) return;
  const problems: string[] = [];

  if (blank(env.AUTH_SECRET)) problems.push("AUTH_SECRET manquant");
  else if ((env.AUTH_SECRET as string).length < 32) problems.push("AUTH_SECRET doit contenir au moins 32 caractères");

  if (blank(env.CRM_PUBLIC_URL)) problems.push("CRM_PUBLIC_URL manquant");
  else {
    let ok = false;
    try {
      const url = new URL((env.CRM_PUBLIC_URL as string).trim());
      ok = (url.protocol === "http:" || url.protocol === "https:") && url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
    } catch { /* invalid */ }
    if (!ok) problems.push("CRM_PUBLIC_URL doit être une URL http(s) absolue sans chemin");
  }

  if (blank(env.SECURITY_ALLOWED_ORIGINS)) problems.push("SECURITY_ALLOWED_ORIGINS manquant");
  else {
    const entries = (env.SECURITY_ALLOWED_ORIGINS as string).split(",").map((v) => v.trim()).filter(Boolean);
    if (!entries.length || entries.some((v) => !validOrigin(v, false))) {
      problems.push("SECURITY_ALLOWED_ORIGINS doit lister des origines exactes (https, sans chemin ni joker)");
    }
  }

  const provider = env.DELIVERY_PROVIDER;
  if (provider !== "mock" && provider !== "ozon" && provider !== "sendit") {
    problems.push('DELIVERY_PROVIDER doit valoir "mock", "ozon" ou "sendit"');
  } else if (provider in COURIERS) {
    for (const name of COURIERS[provider as CourierName].requiredEnv) {
      if (blank(env[name])) problems.push(`${name} manquant`);
    }
  }

  const mockProfile = env.MOCK_COURIER_PROFILE?.trim();
  if (mockProfile && mockProfile !== "ozon" && mockProfile !== "sendit") {
    problems.push('MOCK_COURIER_PROFILE doit valoir "ozon" ou "sendit"');
  }

  if (blank(env.SECURITY_TRUSTED_IP_HEADER) && env.SECURITY_ACCEPT_GLOBAL_BUDGETS !== "1") {
    problems.push("SECURITY_TRUSTED_IP_HEADER manquant (ou SECURITY_ACCEPT_GLOBAL_BUDGETS=1 pour accepter des budgets globaux uniquement)");
  }

  problems.push(...whatsappEnvIssues(env).problems);

  if (problems.length) throw new Error(`Configuration invalide : ${problems.join(" ; ")}.`);
}

export function runtimeEnvWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const warnings: string[] = [];
  if (env.NODE_ENV === "production" && env.DELIVERY_PROVIDER === "mock") warnings.push(MOCK_WARNING);
  if (env.SECURITY_ACCEPT_GLOBAL_BUDGETS === "1") warnings.push(GLOBAL_BUDGETS_WARNING);
  warnings.push(...whatsappEnvIssues(env).warnings);
  return warnings;
}
