import { evolutionConfig, type EvolutionConfig } from "@/lib/whatsapp/config";
import { redactSecrets, redactText } from "@/lib/shipping/redact";

export type WaErrorKind = "retryable" | "permanent" | "unknown";

export class WhatsAppError extends Error {
  constructor(
    public kind: WaErrorKind,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "WhatsAppError";
    Object.setPrototypeOf(this, WhatsAppError.prototype);
  }
}

export interface SendResult {
  waMessageId: string | null;
}

export interface NumberCheck {
  phone: string;
  exists: boolean;
  jid: string | null;
}

export type ConnectionState = "open" | "connecting" | "close" | "unknown";

export interface WhatsAppSender {
  sendText(jidOrNumber: string, text: string): Promise<SendResult>;
  sendImage(
    jidOrNumber: string,
    image: { url?: string; base64?: string; mimetype: string; fileName: string },
    caption: string,
  ): Promise<SendResult>;
  sendPresence(jidOrNumber: string, presence: "composing" | "paused", delayMs: number): Promise<void>;
  checkNumbers(numbers: string[]): Promise<NumberCheck[]>;
  getMediaBase64(waMessageId: string, remoteJid: string, fromMe: boolean): Promise<{ base64: string; mimetype: string }>;
  connectionState(): Promise<ConnectionState>;
}

const TIMEOUT_SEND_MS = 15_000;
const TIMEOUT_PRESENCE_STATE_MS = 10_000;
const TIMEOUT_CHECK_NUMBERS_MS = 10_000;
const TIMEOUT_MEDIA_MS = 30_000;

const MAX_JSON_BYTES = 256 * 1024; // 256 KB
const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // 25 MB

/** Minimal structural view of an unknown thrown value (Node/undici errors). */
interface ErrLike {
  code?: unknown;
  name?: unknown;
  message?: unknown;
  cause?: unknown;
}

function asErrLike(err: unknown): ErrLike | null {
  return err !== null && typeof err === "object" ? (err as ErrLike) : null;
}

function errCause(err: ErrLike | null): ErrLike | null {
  return asErrLike(err?.cause);
}

/** String view of an unknown value; finite numbers are coerced, the rest is empty. */
function strVal(val: unknown): string {
  if (typeof val === "string") return val;
  if (typeof val === "number" && Number.isFinite(val)) return String(val);
  return "";
}

/** Narrows an unknown value to a plain object record, or null. */
function asRecord(val: unknown): Record<string, unknown> | null {
  return val !== null && typeof val === "object" && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

interface SendResponseJson {
  key?: unknown;
  id?: unknown;
}

interface MediaResponseJson {
  base64?: unknown;
  mimetype?: unknown;
}

interface ConnectionStateResponseJson {
  instance?: unknown;
  state?: unknown;
}

function extractWaMessageId(json: SendResponseJson): string | null {
  const key = asRecord(json.key);
  if (key && typeof key.id === "string") return key.id;
  if (typeof json.id === "string") return json.id;
  return null;
}

/**
 * Normalizes a recipient phone number or JID to digits-only string ("212...").
 * Strips device suffixes, domain (@s.whatsapp.net / @c.us), plus signs and whitespace.
 * Converts local Moroccan numbers ("06...", "07...") to "2126...", "2127...".
 */
export function cleanRecipientNumber(input: string): string {
  if (!input) return "";
  let s = input.trim();
  const atIdx = s.indexOf("@");
  if (atIdx !== -1) {
    s = s.slice(0, atIdx);
  }
  const colonIdx = s.indexOf(":");
  if (colonIdx !== -1) {
    s = s.slice(0, colonIdx);
  }
  const digits = s.replace(/\D/g, "");
  if (digits.startsWith("00212")) {
    return digits.slice(2);
  }
  if (/^0[567]\d{8}$/.test(digits)) {
    return `212${digits.slice(1)}`;
  }
  return digits;
}

/**
 * Scrubs any secret values, URLs, and phone numbers from error text,
 * truncating to 300 characters.
 */
function sanitizeErrorMessage(rawMessage: string, apiKey: string): string {
  if (!rawMessage) return "error";
  let msg = rawMessage;
  if (apiKey) {
    msg = redactSecrets(msg, [apiKey]);
  }
  msg = redactText(msg);
  // Redact potential phone numbers
  msg = msg.replace(/\+?\b212[5-7]\d{8}\b/g, "[phone]");
  msg = msg.replace(/\b0[5-7]\d{8}\b/g, "[phone]");
  msg = msg.replace(/\b\d{9,15}\b/g, "[digits]");
  return msg.trim().slice(0, 300);
}

function makeWhatsAppError(
  kind: WaErrorKind,
  rawMessage: string,
  apiKey: string,
  status?: number,
): WhatsAppError {
  const sanitized = sanitizeErrorMessage(rawMessage, apiKey);
  return new WhatsAppError(kind, sanitized, status);
}

function isPreConnectionError(err: unknown): { isPre: boolean; reason: string } {
  const anyErr = asErrLike(err);
  if (!anyErr) return { isPre: false, reason: "" };
  const cause = errCause(anyErr);
  const code = strVal(anyErr.code) || strVal(cause?.code);
  const msg = strVal(anyErr.message).toLowerCase();
  const causeMsg = strVal(cause?.message).toLowerCase();

  if (code === "ECONNREFUSED" || msg.includes("econnrefused") || causeMsg.includes("econnrefused")) {
    return { isPre: true, reason: "connection_refused" };
  }
  if (
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    msg.includes("enotfound") ||
    msg.includes("getaddrinfo") ||
    causeMsg.includes("enotfound")
  ) {
    return { isPre: true, reason: "dns_failure" };
  }
  if (
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    msg.includes("ehostunreach") ||
    msg.includes("enetunreach")
  ) {
    return { isPre: true, reason: "network_unreachable" };
  }
  return { isPre: false, reason: "" };
}

function isTimeoutError(err: unknown): boolean {
  const anyErr = asErrLike(err);
  if (!anyErr) return false;
  const cause = errCause(anyErr);
  if (strVal(anyErr.name) === "TimeoutError" || strVal(cause?.name) === "TimeoutError") return true;
  if (strVal(anyErr.name) === "AbortError" || strVal(cause?.name) === "AbortError") return true;
  if (strVal(anyErr.code) === "ETIMEDOUT" || strVal(cause?.code) === "ETIMEDOUT") return true;
  if (strVal(anyErr.code) === "UND_ERR_HEADERS_TIMEOUT" || strVal(cause?.code) === "UND_ERR_HEADERS_TIMEOUT") return true;
  if (strVal(anyErr.code) === "UND_ERR_BODY_TIMEOUT" || strVal(cause?.code) === "UND_ERR_BODY_TIMEOUT") return true;
  const msg = strVal(anyErr.message).toLowerCase();
  const causeMsg = strVal(cause?.message).toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("aborted") ||
    msg.includes("abort") ||
    causeMsg.includes("timeout") ||
    causeMsg.includes("aborted")
  );
}

function isSocketResetError(err: unknown): boolean {
  const anyErr = asErrLike(err);
  if (!anyErr) return false;
  const cause = errCause(anyErr);
  const code = strVal(anyErr.code) || strVal(cause?.code);
  const msg = strVal(anyErr.message).toLowerCase();
  const causeMsg = strVal(cause?.message).toLowerCase();
  return (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    msg.includes("econnreset") ||
    causeMsg.includes("econnreset") ||
    msg.includes("epipe")
  );
}

function containsNotOnWhatsApp(val: string): boolean {
  if (!val) return false;
  const lower = val.toLowerCase();
  return (
    lower.includes("not on whatsapp") ||
    lower.includes("not-on-whatsapp") ||
    lower.includes("is not on whatsapp") ||
    lower.includes("does not exist on whatsapp") ||
    lower.includes("not exists on whatsapp") ||
    /exists["']?\s*:\s*false/i.test(val)
  );
}

function isNotOnWhatsApp(text: string, json: Record<string, unknown> | null): boolean {
  if (json) {
    if (json.exists === false) return true;
    const response = asRecord(json.response);
    if (response && response.exists === false) return true;
    if (typeof json.message === "string" && containsNotOnWhatsApp(json.message)) return true;
    if (
      Array.isArray(json.message) &&
      json.message.some((m: unknown) => typeof m === "string" && containsNotOnWhatsApp(m))
    ) {
      return true;
    }
  }
  return containsNotOnWhatsApp(text);
}

async function readResponseText(
  response: Response,
  maxBytes: number,
  isMedia: boolean,
  isSend: boolean,
  apiKey: string,
): Promise<string> {
  const clHeader = response.headers.get("content-length");
  if (clHeader) {
    const cl = Number(clHeader);
    if (!Number.isNaN(cl) && cl > maxBytes) {
      try {
        await response.body?.cancel?.();
      } catch {}
      if (isMedia) {
        throw makeWhatsAppError("permanent", "media_too_large", apiKey);
      }
      if (isSend && response.ok) {
        throw makeWhatsAppError("unknown", "response_too_large", apiKey, response.status);
      }
      throw makeWhatsAppError("permanent", "response_too_large", apiKey, response.status);
    }
  }

  if (!response.body) {
    return "";
  }

  if (typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    const chunks: string[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            try {
              await reader.cancel?.();
            } catch {}
            if (isMedia) {
              throw makeWhatsAppError("permanent", "media_too_large", apiKey);
            }
            if (isSend && response.ok) {
              throw makeWhatsAppError("unknown", "response_too_large", apiKey, response.status);
            }
            throw makeWhatsAppError("permanent", "response_too_large", apiKey, response.status);
          }
          chunks.push(decoder.decode(value, { stream: true }));
        }
      }
      chunks.push(decoder.decode());
      return chunks.join("");
    } catch (err) {
      if (err instanceof WhatsAppError) throw err;
      throw err;
    }
  }

  const text = await response.text();
  const byteLen = Buffer.byteLength(text, "utf8");
  if (byteLen > maxBytes) {
    if (isMedia) {
      throw makeWhatsAppError("permanent", "media_too_large", apiKey);
    }
    if (isSend && response.ok) {
      throw makeWhatsAppError("unknown", "response_too_large", apiKey, response.status);
    }
    throw makeWhatsAppError("permanent", "response_too_large", apiKey, response.status);
  }
  return text;
}

interface RequestParams {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  timeoutMs: number;
  maxBytes: number;
  isSend: boolean;
  isMedia?: boolean;
}

export class EvolutionSender implements WhatsAppSender {
  private readonly baseUrl: string;
  private readonly instance: string;
  private readonly apiKey: string;

  constructor(config: EvolutionConfig) {
    this.baseUrl = config.baseUrl;
    this.instance = config.instance;
    this.apiKey = config.apiKey;
  }

  private async request<T = unknown>(params: RequestParams): Promise<T> {
    const url = `${this.baseUrl}${params.path}`;
    const headers: Record<string, string> = {
      apikey: this.apiKey,
      "content-type": "application/json",
    };

    let response: Response;
    try {
      response = await globalThis.fetch(url, {
        method: params.method,
        headers,
        body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(params.timeoutMs),
      });
    } catch (err: unknown) {
      if (err instanceof WhatsAppError) {
        throw err;
      }
      const pre = isPreConnectionError(err);
      if (pre.isPre) {
        throw makeWhatsAppError("retryable", pre.reason, this.apiKey);
      }
      if (isTimeoutError(err)) {
        throw makeWhatsAppError(params.isSend ? "unknown" : "retryable", "timeout", this.apiKey);
      }
      if (isSocketResetError(err)) {
        throw makeWhatsAppError(params.isSend ? "unknown" : "retryable", "socket_reset", this.apiKey);
      }
      const rawMsg = err instanceof Error ? err.message : String(err || "network_error");
      throw makeWhatsAppError(params.isSend ? "unknown" : "retryable", rawMsg || "network_error", this.apiKey);
    }

    if (response.ok) {
      const text = await readResponseText(
        response,
        params.maxBytes,
        Boolean(params.isMedia),
        params.isSend,
        this.apiKey,
      );

      if (!text.trim()) {
        return {} as T;
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        if (params.isSend) {
          throw makeWhatsAppError("unknown", "unparseable_response", this.apiKey, response.status);
        }
        throw makeWhatsAppError("retryable", "unparseable_response", this.apiKey, response.status);
      }
    }

    let errorText = "";
    try {
      errorText = await readResponseText(response, MAX_JSON_BYTES, false, false, this.apiKey);
    } catch {
      // Ignore failure reading error text
    }

    let errorJson: Record<string, unknown> | null = null;
    try {
      if (errorText) {
        errorJson = asRecord(JSON.parse(errorText));
      }
    } catch {
      // Non-JSON error body
    }

    if (isNotOnWhatsApp(errorText, errorJson)) {
      throw makeWhatsAppError("permanent", "not_on_whatsapp", this.apiKey, response.status);
    }

    if (response.status === 429) {
      throw makeWhatsAppError("retryable", "rate_limited", this.apiKey, 429);
    }

    let msg = "";
    if (errorJson) {
      if (typeof errorJson.message === "string") {
        msg = errorJson.message;
      } else if (Array.isArray(errorJson.message)) {
        msg = errorJson.message.join("; ");
      } else if (typeof errorJson.error === "string") {
        msg = errorJson.error;
      }
    }
    if (!msg && errorText) {
      msg = errorText;
    }
    if (!msg) {
      msg = `http_${response.status}`;
    }

    if (response.status >= 400 && response.status < 500) {
      throw makeWhatsAppError("permanent", msg, this.apiKey, response.status);
    }

    if (response.status >= 500) {
      if (params.isSend) {
        throw makeWhatsAppError("unknown", msg, this.apiKey, response.status);
      }
      throw makeWhatsAppError("retryable", msg, this.apiKey, response.status);
    }

    if (params.isSend) {
      throw makeWhatsAppError("unknown", msg, this.apiKey, response.status);
    }
    throw makeWhatsAppError("retryable", msg, this.apiKey, response.status);
  }

  async sendText(jidOrNumber: string, text: string): Promise<SendResult> {
    const number = cleanRecipientNumber(jidOrNumber);
    const inst = encodeURIComponent(this.instance);
    const json = await this.request<SendResponseJson>({
      method: "POST",
      path: `/message/sendText/${inst}`,
      body: { number, text },
      timeoutMs: TIMEOUT_SEND_MS,
      maxBytes: MAX_JSON_BYTES,
      isSend: true,
    });

    return { waMessageId: extractWaMessageId(json) };
  }

  async sendImage(
    jidOrNumber: string,
    image: { url?: string; base64?: string; mimetype: string; fileName: string },
    caption: string,
  ): Promise<SendResult> {
    const number = cleanRecipientNumber(jidOrNumber);
    const inst = encodeURIComponent(this.instance);
    const json = await this.request<SendResponseJson>({
      method: "POST",
      path: `/message/sendMedia/${inst}`,
      body: {
        number,
        mediatype: "image",
        mimetype: image.mimetype,
        caption,
        media: image.url || image.base64 || "",
        fileName: image.fileName,
      },
      timeoutMs: TIMEOUT_SEND_MS,
      maxBytes: MAX_JSON_BYTES,
      isSend: true,
    });

    return { waMessageId: extractWaMessageId(json) };
  }

  async sendPresence(
    jidOrNumber: string,
    presence: "composing" | "paused",
    delayMs: number,
  ): Promise<void> {
    const number = cleanRecipientNumber(jidOrNumber);
    const inst = encodeURIComponent(this.instance);
    await this.request<void>({
      method: "POST",
      path: `/chat/sendPresence/${inst}`,
      body: {
        number,
        presence,
        delay: delayMs,
      },
      timeoutMs: TIMEOUT_PRESENCE_STATE_MS,
      maxBytes: MAX_JSON_BYTES,
      isSend: false,
    });
  }

  async checkNumbers(numbers: string[]): Promise<NumberCheck[]> {
    const cleanedNumbers = numbers.map(cleanRecipientNumber);
    const inst = encodeURIComponent(this.instance);
    const json = await this.request<unknown>({
      method: "POST",
      path: `/chat/whatsappNumbers/${inst}`,
      body: { numbers: cleanedNumbers },
      timeoutMs: TIMEOUT_CHECK_NUMBERS_MS,
      maxBytes: MAX_JSON_BYTES,
      isSend: false,
    });

    const rec = asRecord(json);
    let itemsRaw: unknown[] = [];
    if (Array.isArray(json)) {
      itemsRaw = json;
    } else if (rec && Array.isArray(rec.numbers)) {
      itemsRaw = rec.numbers;
    } else if (rec && Array.isArray(rec.result)) {
      itemsRaw = rec.result;
    }

    const items = itemsRaw
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null);

    return items.map((item) => {
      const jid = typeof item.jid === "string" ? item.jid : null;
      const phone = strVal(item.phone) || strVal(item.number) || (jid ? jid.split("@")[0] : "");
      return { phone, exists: Boolean(item.exists), jid };
    });
  }

  async getMediaBase64(
    waMessageId: string,
    remoteJid: string,
    fromMe: boolean,
  ): Promise<{ base64: string; mimetype: string }> {
    const inst = encodeURIComponent(this.instance);
    const json = await this.request<MediaResponseJson>({
      method: "POST",
      path: `/chat/getBase64FromMediaMessage/${inst}`,
      body: {
        message: {
          key: {
            id: waMessageId,
            remoteJid,
            fromMe,
          },
        },
        convertToMp4: false,
      },
      timeoutMs: TIMEOUT_MEDIA_MS,
      maxBytes: MAX_MEDIA_BYTES,
      isSend: false,
      isMedia: true,
    });

    let base64 = typeof json.base64 === "string" ? json.base64 : "";
    let mimetype = typeof json.mimetype === "string" ? json.mimetype : "";

    if (base64.startsWith("data:")) {
      const match = base64.match(/^data:([^;]+);base64,([\s\S]+)$/);
      if (match) {
        if (!mimetype) mimetype = match[1];
        base64 = match[2];
      }
    }

    if (!base64) {
      throw makeWhatsAppError("permanent", "invalid_media_response", this.apiKey);
    }

    if (base64.length > MAX_MEDIA_BYTES) {
      throw makeWhatsAppError("permanent", "media_too_large", this.apiKey);
    }

    return {
      base64,
      mimetype: mimetype || "application/octet-stream",
    };
  }

  async connectionState(): Promise<ConnectionState> {
    const inst = encodeURIComponent(this.instance);
    const json = await this.request<ConnectionStateResponseJson>({
      method: "GET",
      path: `/instance/connectionState/${inst}`,
      timeoutMs: TIMEOUT_PRESENCE_STATE_MS,
      maxBytes: MAX_JSON_BYTES,
      isSend: false,
    });

    const instRec = asRecord(json.instance);
    const raw = instRec?.state ?? json.state;
    const clean = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (clean === "open" || clean === "connecting" || clean === "close") {
      return clean as ConnectionState;
    }
    return "unknown";
  }
}

/**
 * Returns a WhatsAppSender instance when Evolution API is configured,
 * or null when EVOLUTION_* environment variables are missing/incomplete.
 */
export function getWhatsAppSender(env: NodeJS.ProcessEnv = process.env): WhatsAppSender | null {
  const config = evolutionConfig(env);
  if (!config) {
    return null;
  }
  return new EvolutionSender(config);
}
