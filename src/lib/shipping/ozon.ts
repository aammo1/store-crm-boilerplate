import { z } from "zod";
import { normalizeMaPhone } from "@/lib/phone";
import { COURIERS } from "./couriers";
import { ProviderError } from "./errors";
import { redactSecrets, redactUrl } from "./redact";
import type {
  City,
  CreateParcelResult,
  DeliveryNoteHandles,
  DeliveryProvider,
  ParcelInfoResult,
  ParcelRequest,
  PdfFormat,
  TrackingResult,
} from "./provider";

const DEFAULT_BASE_URL = "https://api.ozonexpress.ma";
// Inherited PDF host spelling — note "ozoneexpress"; live verification remains required.
// client host vs "ozonexpress" API host discrepancy (§2); not yet verified.
const PDF_BASE_URL = "https://client.ozoneexpress.ma";
const REQUEST_TIMEOUT_MS = 15_000;
const PREVIEW_MAX_CHARS = 300;

const PDF_PATHS: Record<PdfFormat, string> = {
  standard: "/pdf-delivery-note",
  a4: "/pdf-delivery-note-tickets",
  tickets10x10: "/pdf-delivery-note-tickets-4-4",
};

interface OzonCredentials {
  baseUrl: string;
  clientId: string;
  apiKey: string;
}

// Read on every call (not cached) so credential rotation and tests work.
function readCredentials(): OzonCredentials | null {
  const clientId = process.env.OZON_CLIENT_ID;
  const apiKey = process.env.OZON_API_KEY;
  if (!clientId || !apiKey) return null;
  const baseUrl = (process.env.OZON_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return { baseUrl, clientId, apiKey };
}

function requireCredentials(): OzonCredentials {
  const creds = readCredentials();
  if (!creds) throw new ProviderError("permanent", "Ozon non configuré");
  return creds;
}

function operationUrl(creds: OzonCredentials, operation: string): string {
  return `${creds.baseUrl}/customers/${creds.clientId}/${creds.apiKey}/${operation}`;
}

function previewOf(text: string, creds: OzonCredentials): string {
  const safe = redactSecrets(redactUrl(text.replace(/\s+/g, " ").trim()), [
    creds.clientId,
    creds.apiKey,
  ]);
  return safe.length > PREVIEW_MAX_CHARS ? `${safe.slice(0, PREVIEW_MAX_CHARS)}…` : safe;
}

function previewOfValue(value: unknown, creds: OzonCredentials): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = "[corps non sérialisable]";
  }
  return previewOf(text, creds);
}

interface RequestOptions {
  method: "GET" | "POST";
  form?: Record<string, string>;
  json?: unknown;
  /** Accept an empty 2xx body (void operations whose response shape is unverified). */
  allowEmpty?: boolean;
}

const objectBodySchema = z.object({}).passthrough();

async function requestJson(
  creds: OzonCredentials,
  url: string,
  label: string,
  options: RequestOptions,
): Promise<unknown> {
  const init: RequestInit = { method: options.method };
  if (options.form) {
    const form = new FormData();
    for (const [key, value] of Object.entries(options.form)) form.append(key, value);
    init.body = form;
  } else if (options.json !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(options.json);
  }

  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new ProviderError("retryable", `Ozon injoignable (${redactUrl(url)})`, { cause: err });
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new ProviderError("retryable", `Ozon: réponse illisible (${redactUrl(url)})`, {
      cause: err,
    });
  }

  if (!res.ok) {
    const detail = previewOf(text, creds);
    if (res.status === 429 || res.status >= 500) {
      throw new ProviderError("retryable", `Ozon HTTP ${res.status} sur ${label} (${detail})`);
    }
    if (res.status >= 400) {
      throw new ProviderError("permanent", `Ozon HTTP ${res.status} sur ${label} (${detail})`);
    }
    throw new ProviderError("unknown", `Ozon HTTP ${res.status} sur ${label} (${detail})`);
  }

  if (options.allowEmpty && text.trim() === "") return null;

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ProviderError(
      "unknown",
      `Ozon: réponse non JSON sur ${label} (${previewOf(text, creds)})`,
    );
  }
  return body;
}

function parseObjectBody(
  body: unknown,
  creds: OzonCredentials,
  label: string,
): Record<string, unknown> {
  const parsed = objectBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ProviderError(
      "unknown",
      `Ozon: réponse inattendue sur ${label} (${previewOfValue(body, creds)})`,
    );
  }
  return parsed.data as Record<string, unknown>;
}

/** Case/separator-insensitive top-level key search ("TRACKING-NUMBER" ≈ "tracking_number"). */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, "");
}

function pickCaseInsensitive(body: Record<string, unknown>, target: string): unknown {
  const wanted = normalizeKey(target);
  for (const [key, value] of Object.entries(body)) {
    if (normalizeKey(key) === wanted) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickString(record: Record<string, unknown>, keys: Set<string>): string | null {
  for (const [key, value] of Object.entries(record)) {
    if (!keys.has(normalizeKey(key))) continue;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function pickInteger(record: Record<string, unknown>, keys: Set<string>): number | null {
  for (const [key, value] of Object.entries(record)) {
    if (!keys.has(normalizeKey(key))) continue;
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  }
  return null;
}

function pickDeepString(body: unknown, targetKeys: Set<string>, maxDepth = 4): string | null {
  if (!isRecord(body) || maxDepth < 0) return null;
  const wanted = new Set([...targetKeys].map(normalizeKey));
  for (const [key, value] of Object.entries(body)) {
    if (wanted.has(normalizeKey(key))) {
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number") return String(value);
    }
  }
  for (const value of Object.values(body)) {
    if (isRecord(value)) {
      const found = pickDeepString(value, wanted, maxDepth - 1);
      if (found) return found;
    }
  }
  return null;
}

function extractOzonError(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const res = pickCaseInsensitive(body, "result");
  const msg = pickCaseInsensitive(body, "message");
  if (typeof res === "string" && res.toUpperCase() === "ERROR") {
    return typeof msg === "string" && msg.trim() ? msg.trim() : "Erreur Ozon";
  }
  for (const val of Object.values(body)) {
    if (isRecord(val)) {
      const found = extractOzonError(val);
      if (found) return found;
    }
  }
  return null;
}

// Cities response schema is unverified (docs/operations.md) — parse
// defensively: an array of objects with an id-ish and a name-ish field.
const CITY_ID_KEYS = new Set(["id", "cityid", "city_id", "citycode", "city_code", "code"]);
const CITY_NAME_KEYS = new Set(["name", "cityname", "city_name", "city", "ville", "nom", "label"]);

function findArray(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (!isRecord(body)) return null;
  let firstEmpty: unknown[] | null = null;
  for (const value of Object.values(body)) {
    if (!Array.isArray(value)) continue;
    if (value.length > 0) return value;
    if (!firstEmpty) firstEmpty = value;
  }
  return firstEmpty;
}

function parseCity(item: unknown): City | null {
  if (!isRecord(item)) return null;
  const id = pickInteger(item, CITY_ID_KEYS);
  const name = pickString(item, CITY_NAME_KEYS);
  return id !== null && name !== null ? { id, name } : null;
}

function extractCities(body: unknown, creds: OzonCredentials): City[] | null {
  let list: unknown[] | null = findArray(body);
  if (!list && isRecord(body)) {
    for (const val of Object.values(body)) {
      if (isRecord(val) && !Array.isArray(val)) {
        const values = Object.values(val);
        if (values.length > 0 && isRecord(values[0])) {
          list = values;
          break;
        }
      }
    }
    if (!list) {
      const topValues = Object.values(body);
      if (topValues.length > 0 && isRecord(topValues[0])) {
        list = topValues;
      }
    }
  }
  if (!list) return null;
  const cities: City[] = [];
  let warned = false;
  for (const item of list) {
    const city = parseCity(item);
    if (city) {
      cities.push(city);
    } else if (!warned) {
      warned = true;
      console.warn(`[ozon] villes: entrée ignorée, forme inattendue (${previewOfValue(item, creds)})`);
    }
  }
  return cities;
}

// Tracking response schema is unverified (docs/operations.md) — accept the
// common shapes without interpreting any status meaning.
const TRACKING_CODE_KEYS = new Set(["trackingnumber"]);
const TRACKING_STATUS_KEYS = new Set(["status", "statut"]);

interface TrackingEntry {
  rawStatus: string | null;
  raw: unknown;
}

function collectTrackingList(list: unknown[], entries: Map<string, TrackingEntry>): void {
  for (const item of list) {
    if (typeof item === "string" && item.trim()) {
      entries.set(normalizeKey(item), { rawStatus: null, raw: item });
      continue;
    }
    if (!isRecord(item)) continue;
    const code = pickString(item, TRACKING_CODE_KEYS);
    if (!code) continue;
    entries.set(normalizeKey(code), {
      rawStatus: pickString(item, TRACKING_STATUS_KEYS),
      raw: item,
    });
  }
}

function statusFromTrackingValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (isRecord(value)) return pickString(value, TRACKING_STATUS_KEYS);
  return null;
}

function extractTrackingEntries(
  body: unknown,
  requested: string[],
): Map<string, TrackingEntry> | null {
  const wanted = new Set(requested.map((code) => normalizeKey(code.trim())));
  const entries = new Map<string, TrackingEntry>();

  if (Array.isArray(body)) {
    if (body.length === 0) return entries;
    collectTrackingList(body, entries);
    return entries.size > 0 ? entries : null;
  }

  if (isRecord(body)) {
    let emptyList: unknown[] | null = null;
    let unparseable = false;
    for (const value of Object.values(body)) {
      if (!Array.isArray(value)) continue;
      if (value.length === 0) {
        if (!emptyList) emptyList = value;
        continue;
      }
      const probe = new Map<string, TrackingEntry>();
      collectTrackingList(value, probe);
      if (probe.size > 0) return probe;
      unparseable = true;
    }
    if (unparseable) return null;
    if (emptyList) return entries;
    // Shape: object keyed by tracking code, either directly on body or inside
    // a container like TRACKING-LIST (observed live on Ozon API).
    const candidateObjects: Record<string, unknown>[] = [body];
    for (const value of Object.values(body)) {
      if (isRecord(value)) candidateObjects.push(value);
    }
    for (const obj of candidateObjects) {
      for (const [key, value] of Object.entries(obj)) {
        if (wanted.has(normalizeKey(key))) {
          entries.set(normalizeKey(key), {
            rawStatus: statusFromTrackingValue(value),
            raw: value,
          });
        }
      }
    }
    return entries.size > 0 ? entries : null;
  }

  return null;
}

function buildParcelFields(input: ParcelRequest): Record<string, string> {
  const receiver = input.receiver.trim();
  if (!receiver) throw new ProviderError("permanent", "Nom du destinataire requis");
  const address = input.address.trim();
  if (!address) throw new ProviderError("permanent", "Adresse de livraison requise");
  if (!Number.isInteger(input.cityId) || input.cityId <= 0) {
    throw new ProviderError("permanent", "Identifiant de ville invalide");
  }
  const price = input.codAmountMad ?? input.priceMad ?? 0;
  if (!Number.isInteger(price) || price < 0) {
    throw new ProviderError("permanent", "Prix COD invalide (entier MAD attendu)");
  }
  const normalized = normalizeMaPhone(input.phoneLocal);
  if (!normalized) {
    throw new ProviderError("permanent", "Téléphone destinataire invalide");
  }
  // Inherited local 06XXXXXXXX format; accepted formats need owner verification.
  const localPhone = `0${normalized.slice(4)}`;

  const fields: Record<string, string> = {
    "parcel-receiver": receiver,
    "parcel-phone": localPhone,
    "parcel-city": String(input.cityId),
    "parcel-address": address,
    "parcel-price": String(price),
    "parcel-nature": input.description ?? input.nature ?? "",
    "parcel-stock": "0",
  };
  // Custom codes stay OFF by default: semantics unverified (docs/operations.md).
  if (process.env.OZON_USE_CUSTOM_TRACKING === "1") {
    const customCode = input.reference?.trim();
    if (!customCode) {
      throw new ProviderError(
        "permanent",
        "customTrackingCode requis quand OZON_USE_CUSTOM_TRACKING=1",
      );
    }
    fields["tracking-number"] = customCode;
  }
  return fields;
}

function isTrackingNotFound(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const res = pickString(value, new Set(["result"]));
  const msg = pickString(value, new Set(["message"]));
  return res?.toUpperCase() === "ERROR" && /not found/i.test(msg ?? "");
}

export class OzonExpressAdapter implements DeliveryProvider {
  readonly name = "ozon" as const;
  readonly profile = "ozon" as const;
  readonly capabilities = COURIERS.ozon.capabilities;

  isConfigured(): boolean {
    return readCredentials() !== null;
  }

  configurationIssues(): string[] {
    const issues: string[] = [];
    if (!process.env.OZON_CLIENT_ID?.trim()) issues.push("OZON_CLIENT_ID manquant");
    if (!process.env.OZON_API_KEY?.trim()) issues.push("OZON_API_KEY manquant");
    return issues;
  }

  async testConnection(): Promise<void> {
    await this.listCities();
  }

  async listCities(): Promise<City[]> {
    const creds = requireCredentials();
    const body = await requestJson(creds, `${creds.baseUrl}/cities`, "cities", { method: "GET" });
    const cities = extractCities(body, creds);
    if (!cities) {
      throw new ProviderError(
        "unknown",
        `Ozon: liste des villes illisible (${previewOfValue(body, creds)})`,
      );
    }
    return cities;
  }

  async createParcel(input: ParcelRequest): Promise<CreateParcelResult> {
    const creds = requireCredentials();
    const fields = buildParcelFields(input);
    const body = await requestJson(
      creds,
      operationUrl(creds, "add-parcel"),
      "add-parcel",
      { method: "POST", form: fields },
    );
    const record = parseObjectBody(body, creds, "add-parcel");
    const trackingNumber = pickDeepString(record, new Set(["tracking-number", "trackingnumber"]));
    if (!trackingNumber) {
      const errorMsg = extractOzonError(body);
      if (errorMsg) {
        throw new ProviderError(
          "permanent",
          `Ozon: ${errorMsg} (${previewOfValue(body, creds)})`,
        );
      }
      throw new ProviderError(
        "unknown",
        `Ozon: numéro de suivi absent de la réponse add-parcel (${previewOfValue(body, creds)})`,
      );
    }
    return { trackingNumber, raw: body };
  }

  async getParcelInfo(trackingNumber: string): Promise<ParcelInfoResult> {
    const creds = requireCredentials();
    if (!trackingNumber.trim()) {
      throw new ProviderError("permanent", "Numéro de suivi requis");
    }
    const body = await requestJson(
      creds,
      operationUrl(creds, "parcel-info"),
      "parcel-info",
      { method: "POST", form: { "tracking-number": trackingNumber } },
    );
    const record = parseObjectBody(body, creds, "parcel-info");
    const found = pickDeepString(record, new Set(["tracking-number", "trackingnumber"])) ?? undefined;
    return { raw: body, trackingNumber: found };
  }

  async track(trackingNumbers: string[]): Promise<TrackingResult[]> {
    if (trackingNumbers.length === 0) return [];
    const creds = requireCredentials();
    const body = await requestJson(
      creds,
      operationUrl(creds, "tracking"),
      "tracking",
      { method: "POST", json: { "tracking-number": trackingNumbers } },
    );
    const entries = extractTrackingEntries(body, trackingNumbers);
    if (!entries) {
      throw new ProviderError(
        "unknown",
        `Ozon: réponse tracking illisible (${previewOfValue(body, creds)})`,
      );
    }
    return trackingNumbers.map((trackingNumber) => {
      const normalized = normalizeKey(trackingNumber.trim());
      const entry = normalized ? entries.get(normalized) : undefined;
      if (!entry || isTrackingNotFound(entry.raw)) {
        return { trackingNumber, rawStatus: null, raw: entry?.raw ?? null, found: false };
      }
      return { trackingNumber, rawStatus: entry.rawStatus, raw: entry.raw, found: true };
    });
  }

  async createDeliveryNote(): Promise<DeliveryNoteHandles> {
    const creds = requireCredentials();
    const body = await requestJson(
      creds,
      operationUrl(creds, "add-delivery-note"),
      "add-delivery-note",
      { method: "POST", form: {} },
    );
    const record = parseObjectBody(body, creds, "add-delivery-note");
    const ref = pickDeepString(record, new Set(["ref", "blref", "dnref"]));
    if (!ref) {
      const errorMsg = extractOzonError(body);
      if (errorMsg) {
        throw new ProviderError(
          "permanent",
          `Ozon: ${errorMsg} (${previewOfValue(body, creds)})`,
        );
      }
      throw new ProviderError(
        "unknown",
        `Ozon: référence BL absente de la réponse (${previewOfValue(body, creds)})`,
      );
    }
    return { ref };
  }

  async addParcelsToDeliveryNote(ref: string, codes: string[]): Promise<void> {
    if (codes.length === 0) return;
    const creds = requireCredentials();
    const fields: Record<string, string> = { Ref: ref };
    codes.forEach((code, index) => {
      fields[`Codes[${index}]`] = code;
    });
    await requestJson(creds, operationUrl(creds, "add-parcel-to-delivery-note"), "add-parcel-to-delivery-note", {
      method: "POST",
      form: fields,
      allowEmpty: true,
    });
  }

  async saveDeliveryNote(ref: string): Promise<void> {
    const creds = requireCredentials();
    await requestJson(creds, operationUrl(creds, "save-delivery-note"), "save-delivery-note", {
      method: "POST",
      form: { Ref: ref },
      allowEmpty: true,
    });
  }

  deliveryNotePdfUrl(ref: string, format: PdfFormat): string {
    requireCredentials();
    const params = new URLSearchParams({ "dn-ref": ref });
    return `${PDF_BASE_URL}${PDF_PATHS[format]}?${params.toString()}`;
  }
}

export function createOzonProvider(): DeliveryProvider {
  return new OzonExpressAdapter();
}
