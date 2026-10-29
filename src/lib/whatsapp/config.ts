/**
 * Server-only WhatsApp configuration and environment validation.
 * Keeps the WhatsApp integration completely inert when unconfigured.
 */

export const WA_DEFAULT_MODELS = {
  chat: "z-ai/glm-5.3-flash",
  chatFallback: "deepseek/deepseek-v4.1-flash",
  audio: "google/gemini-2.5-flash-lite",
  audioFallback: "qwen/qwen3.8-omni-flash",
} as const;

export interface EvolutionConfig {
  baseUrl: string;
  instance: string;
  apiKey: string;
}

const MODEL_NAME_RE = /^[a-z0-9._-]+\/[a-z0-9._:-]+$/i;

function isBlank(value: string | undefined): boolean {
  return !value || !value.trim();
}

/** Parses and normalizes the Evolution base URL. Strips trailing slashes. */
function parseBaseUrl(raw: string | undefined): string | null {
  if (isBlank(raw)) return null;
  const stripped = raw!.trim().replace(/\/+$/, "");
  if (stripped.includes("?") || stripped.includes("#")) return null;
  try {
    const url = new URL(stripped);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (url.search || url.hash) return null;
    return stripped;
  } catch {
    return null;
  }
}

/** Determines if a hostname is a public FQDN (plain HTTP should warn). */
function isPublicFqdn(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host.includes(".")) return false;
  if (host === "localhost") return false;
  if (host.endsWith(".internal") || host.endsWith(".local")) return false;

  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const b0 = Number(ipv4Match[1]);
    const b1 = Number(ipv4Match[2]);
    const b2 = Number(ipv4Match[3]);
    const b3 = Number(ipv4Match[4]);
    if (b0 <= 255 && b1 <= 255 && b2 <= 255 && b3 <= 255) {
      if (b0 === 127) return false;
      if (b0 === 10) return false;
      if (b0 === 172 && b1 >= 16 && b1 <= 31) return false;
      if (b0 === 192 && b1 === 168) return false;
    }
  }

  return true;
}

export function evolutionConfig(env: NodeJS.ProcessEnv = process.env): EvolutionConfig | null {
  const baseUrl = parseBaseUrl(env.EVOLUTION_BASE_URL);
  const instance = env.EVOLUTION_INSTANCE?.trim();
  const apiKey = env.EVOLUTION_API_KEY?.trim();

  if (!baseUrl || !instance || !apiKey) {
    return null;
  }

  return { baseUrl, instance, apiKey };
}

export function webhookSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.WHATSAPP_WEBHOOK_SECRET?.trim();
  if (!raw || raw.length < 32) return null;
  return raw;
}

export function whatsappConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return evolutionConfig(env) !== null && webhookSecret(env) !== null;
}

export function whatsappAiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return whatsappConfigured(env) && !isBlank(env.OPENROUTER_API_KEY);
}

function resolveModel(val: string | undefined, fallback: string): string {
  const trimmed = val?.trim();
  if (trimmed && MODEL_NAME_RE.test(trimmed)) {
    return trimmed;
  }
  return fallback;
}

export function whatsappModels(env: NodeJS.ProcessEnv = process.env): {
  chat: string;
  chatFallback: string;
  audio: string;
  audioFallback: string;
} {
  return {
    chat: resolveModel(env.WHATSAPP_CHAT_MODEL, WA_DEFAULT_MODELS.chat),
    chatFallback: resolveModel(env.WHATSAPP_CHAT_FALLBACK_MODEL, WA_DEFAULT_MODELS.chatFallback),
    audio: resolveModel(env.WHATSAPP_AUDIO_MODEL, WA_DEFAULT_MODELS.audio),
    audioFallback: resolveModel(env.WHATSAPP_AUDIO_FALLBACK_MODEL, WA_DEFAULT_MODELS.audioFallback),
  };
}

export function whatsappEnvIssues(env: NodeJS.ProcessEnv = process.env): {
  problems: string[];
  warnings: string[];
} {
  const problems: string[] = [];
  const warnings: string[] = [];

  const hasBaseUrl = !isBlank(env.EVOLUTION_BASE_URL);
  const hasInstance = !isBlank(env.EVOLUTION_INSTANCE);
  const hasApiKey = !isBlank(env.EVOLUTION_API_KEY);

  const evolutionCount = (hasBaseUrl ? 1 : 0) + (hasInstance ? 1 : 0) + (hasApiKey ? 1 : 0);

  // No EVOLUTION_* var set at all: inert, no problems, no warnings.
  if (evolutionCount === 0) {
    return { problems, warnings };
  }

  // Some but not all of the three EVOLUTION_* vars set:
  if (evolutionCount < 3) {
    warnings.push(
      "WhatsApp désactivé : EVOLUTION_BASE_URL, EVOLUTION_INSTANCE et EVOLUTION_API_KEY doivent être tous définis.",
    );
  }

  // Check EVOLUTION_BASE_URL validity if set
  if (hasBaseUrl) {
    const validUrl = parseBaseUrl(env.EVOLUTION_BASE_URL);
    if (!validUrl) {
      problems.push("EVOLUTION_BASE_URL invalide");
    } else {
      try {
        const url = new URL(validUrl);
        if (url.protocol === "http:" && isPublicFqdn(url.hostname)) {
          warnings.push("EVOLUTION_BASE_URL utilise HTTP vers un hôte public : utilisez HTTPS en dehors d'un réseau privé.");
        }
      } catch {
        // Handled by parseBaseUrl
      }
    }
  }

  // When all 3 are set, Evolution is configured
  if (evolutionCount === 3) {
    if (!webhookSecret(env)) {
      problems.push("WHATSAPP_WEBHOOK_SECRET doit contenir au moins 32 caractères");
    }
    if (isBlank(env.OPENROUTER_API_KEY)) {
      warnings.push(
        "OPENROUTER_API_KEY manquant : l'IA reste désactivée (seules les notifications et la boîte de réception fonctionnent).",
      );
    }
  }

  return { problems, warnings };
}
