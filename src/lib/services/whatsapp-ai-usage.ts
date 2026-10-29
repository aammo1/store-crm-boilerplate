import { nanoid } from "nanoid";
import { getDb } from "@/lib/db";
import { getWhatsAppSettings } from "@/lib/services/whatsapp-settings";
import { whatsappAiConfigured } from "@/lib/whatsapp/config";

export const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  "z-ai/glm-5.3-flash": { in: 0.046, out: 0.074 },
  "deepseek/deepseek-v4.1-flash": { in: 0.045, out: 0.5 },
  "google/gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  "qwen/qwen3.8-omni-flash": { in: 0.15, out: 0.47 },
  "qwen/qwen3.7-flash": { in: 0.03, out: 0.13 },
};

export const UNKNOWN_PRICE = { in: 1, out: 4 }; // conservative for env-overridden models

export type AiRole = "chat" | "audio" | "vision" | "classify";

export interface RecordAiUsageInput {
  role: AiRole;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd?: number;
  conversationId?: string | null;
  createdAt?: string;
}

export interface AiUsageSummaryRow {
  day: string;
  role: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
}

export interface CachedMedia {
  transcript: string | null;
  language: string | null;
  description: string | null;
  createdAt: string;
}

export interface PutCachedMediaInput {
  sha256: string;
  transcript?: string | null;
  language?: string | null;
  description?: string | null;
  createdAt?: string;
}

/**
 * Returns date as YYYY-MM-DD in Africa/Casablanca timezone.
 */
export function toCasablancaDay(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Casablanca",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Calculates cost in micro-USD (1 USD = 1,000,000 micro-USD; 1 USD cent = 10,000 micro-USD).
 * Prefers OpenRouter usage.cost * 1e6 if provided.
 */
export function calculateCostMicroUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  openRouterCostUsd?: number | null,
): number {
  if (
    typeof openRouterCostUsd === "number" &&
    !Number.isNaN(openRouterCostUsd) &&
    openRouterCostUsd >= 0
  ) {
    return Math.round(openRouterCostUsd * 1e6);
  }
  const price = MODEL_PRICES[model] ?? UNKNOWN_PRICE;
  const inTok = Math.max(0, inputTokens);
  const outTok = Math.max(0, outputTokens);
  return Math.round(inTok * price.in + outTok * price.out);
}

/**
 * Returns sum of cost_micro_usd recorded for today in Africa/Casablanca.
 */
export function todayAiSpendMicroUsd(now: Date = new Date()): number {
  const day = toCasablancaDay(now);
  const row = getDb()
    .prepare("SELECT COALESCE(SUM(cost_micro_usd), 0) AS total FROM wa_ai_usage WHERE day = ?")
    .get(day) as { total: number } | undefined;
  return Number(row?.total ?? 0);
}

/**
 * Checks whether AI budget is available for new calls.
 * True only when all of:
 * - whatsappAiConfigured()
 * - settings.enabled && settings.aiEnabled
 * - settings.aiDailyBudgetCents > 0
 * - today's sum of cost_micro_usd < aiDailyBudgetCents * 10,000
 * Casablanca day bounds.
 */
export function aiBudgetAvailable(now: Date = new Date()): boolean {
  if (!whatsappAiConfigured()) {
    return false;
  }
  const settings = getWhatsAppSettings();
  if (!settings.enabled || !settings.aiEnabled) {
    return false;
  }
  if (settings.aiDailyBudgetCents <= 0) {
    return false;
  }
  const spend = todayAiSpendMicroUsd(now);
  const budgetMicroUsd = settings.aiDailyBudgetCents * 10_000;
  return spend < budgetMicroUsd;
}

/**
 * Persists an AI usage record in wa_ai_usage.
 */
export function recordAiUsage(input: RecordAiUsageInput): { id: string } {
  const id = `use_${nanoid(16)}`;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const day = toCasablancaDay(new Date(createdAt));
  const inTok = Math.max(0, Math.round(input.inputTokens || 0));
  const outTok = Math.max(0, Math.round(input.outputTokens || 0));
  const cost =
    typeof input.costMicroUsd === "number"
      ? Math.max(0, Math.round(input.costMicroUsd))
      : calculateCostMicroUsd(input.model, inTok, outTok);

  getDb()
    .prepare(
      `INSERT INTO wa_ai_usage (
        id, day, role, model, input_tokens, output_tokens, cost_micro_usd, conversation_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      day,
      input.role,
      input.model,
      inTok,
      outTok,
      cost,
      input.conversationId ?? null,
      createdAt,
    );

  return { id };
}

/**
 * Aggregates AI usage across the past N days grouped by day, role, and model.
 */
export function aiUsageSummary(days = 7, now: Date = new Date()): AiUsageSummaryRow[] {
  const safeDays = Math.max(1, Math.min(days, 365));
  const since = new Date(now.getTime() - (safeDays - 1) * 24 * 60 * 60 * 1000);
  const sinceDay = toCasablancaDay(since);

  const rows = getDb()
    .prepare(
      `SELECT day, role, model,
              COUNT(*) AS calls,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cost_micro_usd), 0) AS cost_micro_usd
       FROM wa_ai_usage
       WHERE day >= ?
       GROUP BY day, role, model
       ORDER BY day DESC, role ASC, model ASC`,
    )
    .all(sinceDay) as Array<{
      day: string;
      role: string;
      model: string;
      calls: number;
      input_tokens: number;
      output_tokens: number;
      cost_micro_usd: number;
    }>;

  return rows.map((r) => ({
    day: r.day,
    role: r.role,
    model: r.model,
    calls: Number(r.calls),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    costMicroUsd: Number(r.cost_micro_usd),
  }));
}

/**
 * Retrieves a media cache entry by SHA-256.
 */
export function getCachedMedia(sha256: string): CachedMedia | null {
  if (!sha256) return null;
  const row = getDb()
    .prepare(
      "SELECT transcript, language, description, created_at FROM wa_media_cache WHERE sha256 = ?",
    )
    .get(sha256) as
    | {
        transcript: string | null;
        language: string | null;
        description: string | null;
        created_at: string;
      }
    | undefined;

  if (!row) return null;
  return {
    transcript: row.transcript,
    language: row.language,
    description: row.description,
    createdAt: row.created_at,
  };
}

/**
 * Upserts a media cache entry in wa_media_cache.
 */
export function putCachedMedia(input: PutCachedMediaInput): void {
  if (!input.sha256) return;
  const createdAt = input.createdAt ?? new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO wa_media_cache (sha256, transcript, language, description, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(sha256) DO UPDATE SET
         transcript = COALESCE(excluded.transcript, wa_media_cache.transcript),
         language = COALESCE(excluded.language, wa_media_cache.language),
         description = COALESCE(excluded.description, wa_media_cache.description)`,
    )
    .run(
      input.sha256,
      input.transcript ?? null,
      input.language ?? null,
      input.description ?? null,
      createdAt,
    );
}
