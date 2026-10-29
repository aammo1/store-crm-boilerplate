import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError } from "ai";
import type { WaLanguage } from "@/lib/services/whatsapp-conversations";
import {
  calculateCostMicroUsd,
  MODEL_PRICES,
  recordAiUsage,
  UNKNOWN_PRICE,
  type AiRole,
} from "@/lib/services/whatsapp-ai-usage";

export { MODEL_PRICES, UNKNOWN_PRICE, calculateCostMicroUsd, recordAiUsage };

export type { WaLanguage };

/** Canonical WhatsApp language values, shared with the classifier and transcriber. */
export const WA_LANGUAGES = ["fr", "ar", "darija_latin", "darija_arabic"] as const satisfies readonly WaLanguage[];

/** Per-attempt timeouts: chat 30 s, audio 45 s, classify 10 s. */
export const AI_TIMEOUT_CHAT_MS = 30_000;
export const AI_TIMEOUT_AUDIO_MS = 45_000;
export const AI_TIMEOUT_CLASSIFY_MS = 10_000;

/** Narrow a model-provided language value to the canonical set. */
export function asWaLanguage(value: unknown): WaLanguage | null {
  return typeof value === "string" && (WA_LANGUAGES as readonly string[]).includes(value)
    ? value as WaLanguage
    : null;
}

export type AiUnavailableReason = "auth" | "credits" | "unconfigured";

export class AiUnavailableError extends Error {
  readonly reason: AiUnavailableReason;
  readonly status: number;

  constructor(reason: AiUnavailableReason, message?: string, status?: number) {
    super(message ?? `AI unavailable: ${reason}`);
    this.name = "AiUnavailableError";
    this.reason = reason;
    this.status = status ?? (reason === "credits" ? 402 : reason === "auth" ? 401 : 503);
  }
}

export class AiBudgetExceededError extends Error {
  readonly status = 429;

  constructor(message = "AI daily budget exceeded") {
    super(message);
    this.name = "AiBudgetExceededError";
  }
}

export interface RecordUsageInput {
  role: AiRole;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number | null;
  costMicroUsd?: number | null;
  conversationId?: string | null;
  createdAt?: string;
}

/**
 * Strips any occurrence of OPENROUTER_API_KEY from error strings to prevent leaking secrets.
 */
export function sanitizeErrorText(text: string): string {
  if (!text) return "";
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (key && key.length > 4 && text.includes(key)) {
    return text.replaceAll(key, "[REDACTED]");
  }
  return text;
}

/**
 * Creates an OpenRouter provider with data_collection denied and usage requested.
 */
export function openRouterProvider(options?: {
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}) {
  const apiKey = (options?.apiKey ?? process.env.OPENROUTER_API_KEY)?.trim();
  if (!apiKey) {
    throw new AiUnavailableError("auth", "Missing OPENROUTER_API_KEY");
  }

  return createOpenAICompatible({
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
    supportsStructuredOutputs: true,
    headers: {
      "HTTP-Referer": process.env.CRM_PUBLIC_URL || "https://store-crm-boilerplate",
      "X-Title": "Store CRM WhatsApp",
    },
    transformRequestBody: (body) => ({
      ...body,
      provider: { data_collection: "deny" },
      reasoning: { effort: "none" },
      usage: { include: true },
    }),
    fetch: options?.fetch,
  });
}

function extractStatusCode(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  if (APICallError.isInstance(err)) {
    return err.statusCode ?? null;
  }
  if ("statusCode" in err && typeof (err as { statusCode: unknown }).statusCode === "number") {
    return (err as { statusCode: number }).statusCode;
  }
  if ("status" in err && typeof (err as { status: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  if ("response" in err && typeof (err as { response: unknown }).response === "object" && (err as { response: unknown }).response !== null) {
    const res = (err as { response: { status?: unknown } }).response;
    if (typeof res.status === "number") return res.status;
  }
  return null;
}

function isAuthError(err: unknown, status: number | null): boolean {
  if (err instanceof AiUnavailableError && err.reason === "auth") return true;
  if (status === 401 || status === 403) return true;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("unauthorized") ||
      msg.includes("invalid api key") ||
      msg.includes("bad api key") ||
      msg.includes("api key not found")
    ) {
      return true;
    }
  }
  return false;
}

function isCreditsError(err: unknown, status: number | null): boolean {
  if (err instanceof AiUnavailableError && err.reason === "credits") return true;
  if (status === 402) return true;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("insufficient credit") ||
      msg.includes("payment required") ||
      msg.includes("out of credits") ||
      msg.includes("no credit")
    ) {
      return true;
    }
  }
  return false;
}

async function executeWithTimeout<T>(
  action: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    const controller = new AbortController();
    return action(controller.signal);
  }

  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`Timeout after ${timeoutMs}ms`));
      const err = new Error(`Request timed out after ${timeoutMs}ms`);
      (err as { name?: string }).name = "TimeoutError";
      reject(err);
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([action(controller.signal), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Only provider-level failures justify spending the fallback attempt:
 * HTTP 5xx, 429, 404 (model gone), network failures and timeouts.
 * Validation or request errors fail fast without a second paid call.
 */
function isRetryableError(err: unknown, status: number | null): boolean {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || /\btimed? ?out\b/i.test(err.message)) return true;
  }
  if ((err as { isRetryable?: boolean } | null)?.isRetryable === true) return true;
  if (status === null) {
    // Network-level failure wrapped by the SDK (no HTTP status at all).
    return APICallError.isInstance(err);
  }
  if (status >= 500) return true;
  return status === 429 || status === 404;
}

/** Strips the API key from an error message before it escapes to callers/logs. */
function sanitizeThrownError(err: unknown): unknown {
  if (err instanceof Error) {
    const clean = sanitizeErrorText(err.message);
    if (clean !== err.message) {
      try {
        err.message = clean;
      } catch {
        // Read-only message: leave as-is; callers sanitize again when logging.
      }
    }
  }
  return err;
}

/**
 * Runs an AI operation on primary model, falling back to fallback model once on retryable errors
 * (HTTP 5xx, 429, timeout, 404). 401 and 402 are never retried and throw AiUnavailableError.
 */
export async function withFallback<T>(
  primary: string,
  fallback: string,
  run: (modelId: string, signal?: AbortSignal) => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<{ result: T; model: string }> {
  const timeoutMs = options?.timeoutMs ?? AI_TIMEOUT_CHAT_MS;

  try {
    const result = await executeWithTimeout((sig) => run(primary, sig), timeoutMs);
    return { result, model: primary };
  } catch (primaryErr) {
    if (primaryErr instanceof AiBudgetExceededError) {
      throw primaryErr;
    }

    const status = extractStatusCode(primaryErr);
    if (isAuthError(primaryErr, status)) {
      throw new AiUnavailableError(
        "auth",
        sanitizeErrorText((primaryErr as Error)?.message || "OpenRouter authentication failed"),
        status ?? 401,
      );
    }
    if (isCreditsError(primaryErr, status)) {
      throw new AiUnavailableError(
        "credits",
        sanitizeErrorText((primaryErr as Error)?.message || "OpenRouter insufficient credits"),
        status ?? 402,
      );
    }

    if (primary === fallback || !isRetryableError(primaryErr, status)) {
      throw sanitizeThrownError(primaryErr);
    }

    try {
      const fallbackResult = await executeWithTimeout((sig) => run(fallback, sig), timeoutMs);
      return { result: fallbackResult, model: fallback };
    } catch (fallbackErr) {
      if (fallbackErr instanceof AiBudgetExceededError) {
        throw fallbackErr;
      }

      const fallbackStatus = extractStatusCode(fallbackErr);
      if (isAuthError(fallbackErr, fallbackStatus)) {
        throw new AiUnavailableError(
          "auth",
          sanitizeErrorText((fallbackErr as Error)?.message || "OpenRouter authentication failed"),
          fallbackStatus ?? 401,
        );
      }
      if (isCreditsError(fallbackErr, fallbackStatus)) {
        throw new AiUnavailableError(
          "credits",
          sanitizeErrorText((fallbackErr as Error)?.message || "OpenRouter insufficient credits"),
          fallbackStatus ?? 402,
        );
      }

      throw sanitizeThrownError(fallbackErr);
    }
  }
}

/**
 * Helper to compute cost and record usage in wa_ai_usage.
 */
export function recordUsage(input: RecordUsageInput): { id: string; costMicroUsd: number } {
  const costMicroUsd =
    typeof input.costMicroUsd === "number"
      ? Math.max(0, Math.round(input.costMicroUsd))
      : calculateCostMicroUsd(
          input.model,
          input.inputTokens,
          input.outputTokens,
          input.costUsd,
        );

  const { id } = recordAiUsage({
    role: input.role,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    costMicroUsd,
    conversationId: input.conversationId,
    createdAt: input.createdAt,
  });

  return { id, costMicroUsd };
}

/**
 * Normalizes an AI SDK LanguageModelUsage into recordUsage input.
 * OpenRouter's `usage.cost` (USD) arrives inside `usage.raw` when `usage.include` was requested.
 */
export function usageFromSdk(usage: {
  inputTokens?: number | null;
  outputTokens?: number | null;
  raw?: unknown;
} | undefined | null): {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
} {
  const raw = (usage?.raw ?? null) as { cost?: unknown } | null;
  const costUsd =
    typeof raw?.cost === "number" && Number.isFinite(raw.cost) && raw.cost >= 0 ? raw.cost : null;
  return {
    inputTokens: Math.max(0, Math.round(usage?.inputTokens ?? 0)),
    outputTokens: Math.max(0, Math.round(usage?.outputTokens ?? 0)),
    costUsd,
  };
}
