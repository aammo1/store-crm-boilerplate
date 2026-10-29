import {
  AI_TIMEOUT_AUDIO_MS,
  asWaLanguage,
  AiBudgetExceededError,
  AiUnavailableError,
  recordUsage,
  sanitizeErrorText,
  withFallback,
  type WaLanguage,
} from "./provider";
import { whatsappModels } from "@/lib/whatsapp/config";
import {
  aiBudgetAvailable,
  getCachedMedia,
  putCachedMedia,
} from "@/lib/services/whatsapp-ai-usage";

export const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

export const TRANSCRIBE_PROMPT =
  'Transcris fidèlement ce message vocal d\'un client marocain (darija, français ou arabe). ' +
  'Réponds en JSON: {"transcript": string, "language": "fr"|"ar"|"darija_latin"|"darija_arabic"}. ' +
  'Écris la darija en lettres latines si le client parle darija. Aucun commentaire.';

export const MAX_TRANSCRIPT_CHARS = 4000;

/** OpenRouter `input_audio` formats we accept; anything else hands off to a human. */
const MIME_SUBTYPE_TO_FORMAT: Record<string, string> = {
  ogg: "ogg",
  opus: "ogg", // mislabelled voice notes still travel in an Ogg container
  mpeg: "mp3",
  mp3: "mp3",
  wav: "wav",
  "x-wav": "wav",
  wave: "wav",
  "vnd.wave": "wav",
  mp4: "m4a",
  m4a: "m4a",
  "x-m4a": "m4a",
  aac: "aac",
  aacp: "aac",
};

/** Unsupported audio (format or empty payload): the caller hands the message to a human. */
export class AiUnsupportedAudioError extends Error {
  readonly status = 415;

  constructor(mimetype: string) {
    super(`Format audio non supporté : ${mimetype}`);
    this.name = "AiUnsupportedAudioError";
  }
}

/** HTTP-level OpenRouter error carrying the status so withFallback can route it. */
export class OpenRouterHttpError extends Error {
  readonly status: number;

  constructor(status: number, detail = "") {
    super(`OpenRouter HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "OpenRouterHttpError";
    this.status = status;
  }
}

/** Transport-level failure (network, abort, timeout): the fallback model is worth trying. */
export class OpenRouterRequestError extends Error {
  readonly isRetryable = true;

  constructor(message: string) {
    super(message);
    this.name = "OpenRouterRequestError";
  }
}

/** Maps a WhatsApp media mimetype to an OpenRouter input_audio format, or null. */
export function audioFormatFromMimetype(mimetype: string): string | null {
  const parts = (mimetype ?? "").split(";")[0]!.trim().toLowerCase().split("/");
  if (parts[0] !== "audio" || !parts[1]) return null;
  return MIME_SUBTYPE_TO_FORMAT[parts[1]] ?? null;
}

/**
 * Extracts the first complete JSON object from a lenient model answer.
 * Tracks string/escape state so braces inside the transcript never break the scan.
 */
export function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const value: unknown = JSON.parse(text.slice(start, i + 1));
          return value && typeof value === "object" && !Array.isArray(value)
            ? value as Record<string, unknown>
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

interface OpenRouterCompletionBody {
  error?: { message?: unknown };
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown };
}

function parseTranscript(content: string): { transcript: string; language: WaLanguage | null } {
  const obj = extractFirstJsonObject(content);
  const rawTranscript = typeof obj?.transcript === "string" ? obj.transcript : "";
  const transcript = rawTranscript.trim().slice(0, MAX_TRANSCRIPT_CHARS);
  if (!transcript) {
    throw new Error("Transcription vide ou illisible");
  }
  return { transcript, language: asWaLanguage(obj?.language) };
}

/**
 * Transcribes a WhatsApp voice note through OpenRouter with the audio model and its fallback.
 * The result is cached by audio SHA-256 so the same audio is never paid for twice; a cache hit
 * uses no budget and performs no request.
 */
export async function transcribeAudio(input: {
  bytes: Buffer;
  mimetype: string;
  sha256: string;
  conversationId: string;
}): Promise<{ transcript: string; language: WaLanguage | null; cached: boolean }> {
  const cached = getCachedMedia(input.sha256);
  if (cached?.transcript) {
    return {
      transcript: cached.transcript,
      language: asWaLanguage(cached.language),
      cached: true,
    };
  }

  const format = audioFormatFromMimetype(input.mimetype);
  if (!format || input.bytes.length === 0) {
    throw new AiUnsupportedAudioError(input.mimetype || "inconnu");
  }

  if (!aiBudgetAvailable()) {
    throw new AiBudgetExceededError();
  }

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new AiUnavailableError("auth", "Missing OPENROUTER_API_KEY");
  }

  const models = whatsappModels();
  const base64 = input.bytes.toString("base64");

  const { result: content } = await withFallback(
    models.audio,
    models.audioFallback,
    async (modelId, signal) => {
      let res: Response;
      try {
        res = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": process.env.CRM_PUBLIC_URL || "https://store-crm-boilerplate",
            "X-Title": "Store CRM WhatsApp",
          },
          body: JSON.stringify({
            model: modelId,
            provider: { data_collection: "deny" },
            usage: { include: true },
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: TRANSCRIBE_PROMPT },
                  { type: "input_audio", input_audio: { data: base64, format } },
                ],
              },
            ],
            response_format: { type: "json_object" },
            max_tokens: 800,
            temperature: 0,
          }),
          signal,
        });
      } catch (err) {
        throw new OpenRouterRequestError(
          sanitizeErrorText(err instanceof Error ? err.message : "Requête OpenRouter échouée"),
        );
      }

      let parsed: OpenRouterCompletionBody | null = null;
      try {
        parsed = JSON.parse(await res.text()) as OpenRouterCompletionBody | null;
      } catch {
        parsed = null;
      }

      if (!res.ok) {
        const detail =
          typeof parsed?.error?.message === "string" ? sanitizeErrorText(parsed.error.message) : "";
        throw new OpenRouterHttpError(res.status, detail.slice(0, 300));
      }
      if (parsed?.error) {
        // OpenRouter can report a provider failure with HTTP 200.
        const detail =
          typeof parsed.error.message === "string"
            ? sanitizeErrorText(parsed.error.message)
            : "OpenRouter error";
        throw new OpenRouterHttpError(502, detail.slice(0, 300));
      }

      const usage = parsed?.usage ?? {};
      recordUsage({
        role: "audio",
        model: modelId,
        inputTokens: Math.max(0, Math.round(Number(usage.prompt_tokens) || 0)),
        outputTokens: Math.max(0, Math.round(Number(usage.completion_tokens) || 0)),
        costUsd: typeof usage.cost === "number" && Number.isFinite(usage.cost) ? usage.cost : null,
        conversationId: input.conversationId,
      });

      const messageContent = parsed?.choices?.[0]?.message?.content;
      if (typeof messageContent !== "string" || !messageContent.trim()) {
        throw new Error("Transcription vide ou illisible");
      }
      return messageContent;
    },
    { timeoutMs: AI_TIMEOUT_AUDIO_MS },
  );

  const { transcript, language } = parseTranscript(content);
  putCachedMedia({ sha256: input.sha256, transcript, language });
  return { transcript, language, cached: false };
}
