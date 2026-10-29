import { getDb } from "@/lib/db";
import { normalizeMaPhone } from "@/lib/phone";
import { getAppState, setAppState } from "@/lib/services/app-state";
import {
  DEFAULT_WHATSAPP_SETTINGS,
  whatsappSettingsBaseSchema,
  whatsappSettingsSchema,
  whatsappSettingsUpdateSchema,
  type WhatsAppConnectionState,
  type WhatsAppConnectionStateValue,
  type WhatsAppSettings,
} from "@/lib/whatsapp-settings-schema";
import { whatsappConfigured } from "@/lib/whatsapp/config";

export const WHATSAPP_SETTINGS_KEY = "whatsapp_settings";
export const WHATSAPP_CONNECTION_KEY = "whatsapp_connection";

export class WhatsAppSettingsError extends Error {
  readonly status: number;
  readonly field?: string;

  constructor(message: string, status = 400, field?: string) {
    super(message);
    this.name = "WhatsAppSettingsError";
    this.status = status;
    this.field = field;
  }
}

/**
 * Normalizes an array of Moroccan admin phone numbers.
 * Throws WhatsAppSettingsError with "Numéro admin invalide." on invalid numbers.
 */
export function normalizeAdminPhones(phones: unknown): string[] {
  if (!Array.isArray(phones)) {
    throw new WhatsAppSettingsError("Numéro admin invalide.", 400, "adminPhones");
  }
  const result: string[] = [];
  for (const raw of phones) {
    if (typeof raw !== "string") {
      throw new WhatsAppSettingsError("Numéro admin invalide.", 400, "adminPhones");
    }
    const normalized = normalizeMaPhone(raw);
    if (!normalized) {
      throw new WhatsAppSettingsError("Numéro admin invalide.", 400, "adminPhones");
    }
    result.push(normalized);
  }
  return result;
}

function normalizeAdminPhonesInInput(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return input;
  }
  if (!("adminPhones" in input)) {
    return input;
  }
  const { adminPhones, ...rest } = input as Record<string, unknown>;
  const normalized = normalizeAdminPhones(adminPhones);
  return { ...rest, adminPhones: normalized };
}

/**
 * Returns current WhatsApp settings from app_state, or defaults if missing.
 * If stored JSON is invalid or corrupt, recovers defaults merged with valid fields and never throws.
 */
export function getWhatsAppSettings(): WhatsAppSettings {
  const value = getAppState(WHATSAPP_SETTINGS_KEY);
  if (value === null) {
    return { ...DEFAULT_WHATSAPP_SETTINGS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { ...DEFAULT_WHATSAPP_SETTINGS };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_WHATSAPP_SETTINGS };
  }

  const directParsed = whatsappSettingsSchema.safeParse(parsed);
  if (directParsed.success) {
    return directParsed.data;
  }

  // Merge valid fields with defaults and never throw.
  const raw = parsed as Record<string, unknown>;
  const shape = whatsappSettingsBaseSchema.shape;
  const recovered: Record<string, unknown> = { ...DEFAULT_WHATSAPP_SETTINGS };

  for (const key of Object.keys(shape) as Array<keyof typeof shape>) {
    if (key in raw) {
      const fieldRes = shape[key].safeParse(raw[key]);
      if (fieldRes.success) {
        recovered[key] = fieldRes.data;
      }
    }
  }

  if (
    typeof recovered.minGapSeconds === "number" &&
    typeof recovered.maxGapSeconds === "number" &&
    recovered.minGapSeconds > recovered.maxGapSeconds
  ) {
    recovered.minGapSeconds = DEFAULT_WHATSAPP_SETTINGS.minGapSeconds;
    recovered.maxGapSeconds = DEFAULT_WHATSAPP_SETTINGS.maxGapSeconds;
  }

  if (
    typeof recovered.sendWindowStart === "string" &&
    typeof recovered.sendWindowEnd === "string" &&
    recovered.sendWindowStart >= recovered.sendWindowEnd
  ) {
    recovered.sendWindowStart = DEFAULT_WHATSAPP_SETTINGS.sendWindowStart;
    recovered.sendWindowEnd = DEFAULT_WHATSAPP_SETTINGS.sendWindowEnd;
  }

  const finalParsed = whatsappSettingsSchema.safeParse(recovered);
  if (finalParsed.success) {
    return finalParsed.data;
  }

  return { ...DEFAULT_WHATSAPP_SETTINGS };
}

/**
 * Validated partial update; read/merge/validate/write serialized inside an immediate transaction.
 * Before validating, adminPhones are normalized with normalizeMaPhone.
 */
export function updateWhatsAppSettings(input: unknown): WhatsAppSettings {
  const normalizedInput = normalizeAdminPhonesInInput(input);
  const update = whatsappSettingsUpdateSchema.parse(normalizedInput);
  return getDb()
    .transaction(() => {
      const current = getWhatsAppSettings();
      const merged = whatsappSettingsSchema.parse({ ...current, ...update });
      if (merged.enabled && !current.enabled && !whatsappConfigured()) {
        throw new WhatsAppSettingsError(
          "WhatsApp n’est pas configuré sur le serveur (variables EVOLUTION_* et WHATSAPP_WEBHOOK_SECRET).",
          409,
          "enabled",
        );
      }
      setAppState(WHATSAPP_SETTINGS_KEY, JSON.stringify(merged));
      return merged;
    })
    .immediate();
}

/**
 * Returns connection state from app_state, or { state: "unknown", updatedAt: null } if missing.
 */
export function getWhatsAppConnectionState(): WhatsAppConnectionState {
  const value = getAppState(WHATSAPP_CONNECTION_KEY);
  if (value === null) {
    return { state: "unknown", updatedAt: null };
  }
  try {
    const parsed = JSON.parse(value);
    const validStates: WhatsAppConnectionStateValue[] = ["open", "connecting", "close", "unknown"];
    const state = validStates.includes(parsed?.state) ? (parsed.state as WhatsAppConnectionStateValue) : "unknown";
    const updatedAt = typeof parsed?.updatedAt === "string" ? parsed.updatedAt : null;
    return { state, updatedAt };
  } catch {
    return { state: "unknown", updatedAt: null };
  }
}

/**
 * Writes WhatsApp connection state to app_state.
 */
export function setWhatsAppConnectionState(state: {
  state: WhatsAppConnectionStateValue;
  updatedAt?: string | null;
}): void {
  const payload: WhatsAppConnectionState = {
    state: state.state,
    updatedAt: state.updatedAt !== undefined ? state.updatedAt : new Date().toISOString(),
  };
  setAppState(WHATSAPP_CONNECTION_KEY, JSON.stringify(payload));
}

/**
 * Returns configured assistant name, or fallback to `Service client ${storeName}`.
 */
export function effectiveAssistantName(
  settings: { assistantName?: string | null },
  storeName: string,
): string {
  const trimmed = settings.assistantName?.trim();
  return trimmed || `Service client ${storeName}`;
}
