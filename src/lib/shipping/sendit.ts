import { createHash } from "node:crypto";
import {
  DEFAULT_COURIER_SETTINGS,
  type CourierSettings,
} from "@/lib/courier-settings-schema";
import { getCourierSettings } from "@/lib/services/courier-settings";
import { COURIERS } from "./couriers";
import { ProviderError } from "./errors";
import type {
  City,
  CreateParcelResult,
  DeliveryNoteHandles,
  DeliveryProvider,
  LabelsPdf,
  ParcelInfoResult,
  ParcelItem,
  ParcelLookupResult,
  ParcelRequest,
  TrackingResult,
} from "./provider";
import { redactSecrets, redactText } from "./redact";

const DEFAULT_BASE_URL = "https://app.sendit.ma/api/v1";
const DEAD_STATUSES = new Set([
  "CANCELED",
  "CANCELLED",
  "REJECTED",
  "RETURNED",
  "DELETED",
]);

interface CachedToken {
  token: string;
  account: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;
let pendingLogin: { account: string; promise: Promise<string> } | null = null;

export function __resetSenditTokenCache(): void {
  cachedToken = null;
  pendingLogin = null;
}

export interface SenditProviderDeps {
  env?: NodeJS.ProcessEnv;
  getSettings?: () => CourierSettings;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clean(str: string): string {
  return str
    .replace(/\s+/g, " ")
    .replace(/\|/g, "/")
    .replace(/;/g, ",")
    .replace(/:/g, " -")
    .trim();
}

function productsString(
  items: ParcelItem[] | undefined,
  fallbackDescription: string,
): string {
  if (!items || items.length === 0) {
    return clean(fallbackDescription || "");
  }
  return items
    .map((item) => {
      const name = clean(item.name || "");
      const opts =
        item.options && item.options.length > 0
          ? ` (${item.options.map((o) => `${clean(o.name)}: ${clean(o.value)}`).join(", ")})`
          : "";
      return `${name}${opts} x${item.quantity}`;
    })
    .join(" | ");
}

function formatErrorMessage(
  status: number,
  body: unknown,
  text: string,
  secrets: string[],
): string {
  let msg = "";
  let details = "";

  if (isRecord(body)) {
    if (typeof body.message === "string" && body.message.trim()) {
      msg = body.message.trim();
    } else if (typeof body.error === "string" && body.error.trim()) {
      msg = body.error.trim();
    }
    if (isRecord(body.errors)) {
      const flat = Object.values(body.errors)
        .flat()
        .filter(Boolean)
        .map(String)
        .join(", ");
      if (flat) {
        details = ` Détails: ${flat}`;
      }
    }
  }

  let full: string;
  if (msg || details) {
    full = `Échec (HTTP ${status}): ${msg}${details}`;
  } else if (text.trim()) {
    full = `Échec (HTTP ${status}): ${text.replace(/\s+/g, " ").trim()}`;
  } else {
    full = `Échec (HTTP ${status})`;
  }

  full = redactSecrets(redactText(full.replace(/<[^>]*>/g, "")), secrets);
  if (full.length > 500) {
    full = `${full.slice(0, 499)}…`;
  }
  return full;
}

function redactRaw(body: unknown, secrets: string[]): unknown {
  if (body === null || body === undefined) return body;
  try {
    const json = JSON.stringify(body);
    const scrubbed = redactSecrets(redactText(json), secrets);
    return JSON.parse(scrubbed);
  } catch {
    return body;
  }
}

function pickLastPage(body: Record<string, unknown>): number | null {
  if (typeof body.last_page === "number") return body.last_page;
  if (isRecord(body.meta) && typeof body.meta.last_page === "number") return body.meta.last_page;
  if (isRecord(body.data) && typeof body.data.last_page === "number") return body.data.last_page;
  return null;
}

function extractRows(body: Record<string, unknown>): Record<string, unknown>[] {
  let container: unknown = body.data ?? body;
  if (isRecord(body.data)) {
    const nested = body.data.data;
    if (Array.isArray(nested) || isRecord(nested)) {
      container = nested;
    }
  }

  if (Array.isArray(container)) {
    return container.filter(isRecord);
  }
  if (isRecord(container)) {
    return Object.entries(container)
      .filter(([k, v]) => /^\d+$/.test(k) && isRecord(v))
      .map(([, v]) => v as Record<string, unknown>);
  }
  return [];
}

function extractLabelUrl(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const d = isRecord(body.data) ? body.data : null;
  const dataString = typeof body.data === "string" ? body.data : null;

  const candidates = [
    d?.fileUrl,
    d?.file_url,
    d?.url,
    d?.pdf,
    d?.link,
    d?.path,
    dataString,
    body.fileUrl,
    body.file_url,
    body.url,
  ];

  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

export function createSenditProvider(deps: SenditProviderDeps = {}): DeliveryProvider {
  const getEnv = () => deps.env ?? process.env;
  const getFetch = () => deps.fetchImpl ?? globalThis.fetch;
  const getSettingsFn = () => deps.getSettings ?? getCourierSettings;

  function getBaseUrl(): string {
    const env = getEnv();
    return (env.SENDIT_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async function login(forceFresh = false): Promise<{ token: string; wasCached: boolean }> {
    const env = getEnv();
    const publicKey = env.SENDIT_PUBLIC_KEY?.trim();
    const secretKey = env.SENDIT_SECRET_KEY?.trim();
    if (!publicKey || !secretKey) {
      throw new ProviderError("permanent", "Sendit non configuré");
    }

    const account = createHash("sha256").update(publicKey).digest("hex");
    if (
      !forceFresh &&
      cachedToken &&
      cachedToken.account === account &&
      cachedToken.expiresAt > Date.now()
    ) {
      return { token: cachedToken.token, wasCached: true };
    }

    // Concurrent callers (tracking runs 3 at once) share one login request.
    if (pendingLogin && pendingLogin.account === account) {
      return { token: await pendingLogin.promise, wasCached: false };
    }
    const promise = performLogin(publicKey, secretKey, account);
    const entry = { account, promise };
    pendingLogin = entry;
    try {
      return { token: await promise, wasCached: false };
    } finally {
      if (pendingLogin === entry) pendingLogin = null;
    }
  }

  async function performLogin(publicKey: string, secretKey: string, account: string): Promise<string> {
    const baseUrl = getBaseUrl();
    const fetchFn = getFetch();
    const secrets = [publicKey, secretKey];

    let res: Response;
    try {
      res = await fetchFn(`${baseUrl}/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ public_key: publicKey, secret_key: secretKey }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new ProviderError("retryable", "Sendit injoignable lors de la connexion", { cause: err });
    }

    let text = "";
    try {
      text = await res.text();
    } catch (err) {
      throw new ProviderError("retryable", "Sendit: réponse illisible lors de la connexion", {
        cause: err,
      });
    }

    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }

    if (res.status === 401 || res.status === 403) {
      throw new ProviderError("permanent", "Clés Sendit refusées");
    }
    if (res.status === 429) {
      throw new ProviderError("throttled", formatErrorMessage(429, body, text, secrets), {
        retryAfterSec: Number(res.headers.get("Retry-After")) || undefined,
      });
    }
    if (!res.ok) {
      if (res.status >= 500) {
        throw new ProviderError("retryable", formatErrorMessage(res.status, body, text, secrets));
      }
      throw new ProviderError("permanent", formatErrorMessage(res.status, body, text, secrets));
    }

    const token = (
      isRecord(body)
        ? isRecord(body.data)
          ? body.data.token
          : body.token
        : undefined
    ) as string | undefined;

    if (typeof token !== "string" || !token.trim()) {
      throw new ProviderError("unknown", "Jeton manquant dans la réponse Sendit");
    }

    const trimmedToken = token.trim();
    cachedToken = {
      token: trimmedToken,
      account,
      expiresAt: Date.now() + 55 * 60 * 1000,
    };

    return trimmedToken;
  }

  async function requestWithAuth(
    endpoint: string,
    options: {
      method?: "GET" | "POST";
      json?: unknown;
      timeoutMs?: number;
      uncertainOnThrow?: boolean;
      /** Login failures happen before the request leaves: nothing can have been created. */
      requeueOnLoginFailure?: boolean;
    } = {},
  ): Promise<{ res: Response; text: string; body: unknown; secrets: string[] }> {
    const env = getEnv();
    const baseUrl = getBaseUrl();
    const fetchFn = getFetch();
    const publicKey = env.SENDIT_PUBLIC_KEY?.trim() ?? "";
    const secretKey = env.SENDIT_SECRET_KEY?.trim() ?? "";

    const authenticate = async (forceFresh: boolean) => {
      try {
        return await login(forceFresh);
      } catch (err) {
        if (
          options.requeueOnLoginFailure &&
          err instanceof ProviderError &&
          err.kind !== "permanent" &&
          err.kind !== "throttled"
        ) {
          throw new ProviderError("throttled", `${err.message} — rien n'a été envoyé`, {
            cause: err,
          });
        }
        throw err;
      }
    };

    let auth = await authenticate(false);
    let secrets = [publicKey, secretKey, auth.token].filter(Boolean);

    const url = endpoint.startsWith("http") ? endpoint : `${baseUrl}${endpoint}`;
    const method = options.method ?? "GET";
    const timeoutMs = options.timeoutMs ?? 15_000;

    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${auth.token}`,
    };
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const doFetch = async () => {
      return await fetchFn(url, {
        method,
        headers,
        body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    };

    let res: Response;
    try {
      res = await doFetch();
    } catch (err) {
      if (options.uncertainOnThrow) {
        throw new ProviderError(
          "unknown",
          `Pas de réponse de Sendit (${redactText(err instanceof Error ? err.message : String(err))})`,
          { cause: err },
        );
      }
      throw new ProviderError("retryable", `Sendit injoignable (${redactText(url)})`, { cause: err });
    }

    if ((res.status === 401 || res.status === 403) && auth.wasCached) {
      cachedToken = null;
      auth = await authenticate(true);
      secrets = [publicKey, secretKey, auth.token].filter(Boolean);
      headers.Authorization = `Bearer ${auth.token}`;
      try {
        res = await doFetch();
      } catch (err) {
        if (options.uncertainOnThrow) {
          throw new ProviderError(
            "unknown",
            `Pas de réponse de Sendit (${redactText(err instanceof Error ? err.message : String(err))})`,
            { cause: err },
          );
        }
        throw new ProviderError("retryable", `Sendit injoignable (${redactText(url)})`, { cause: err });
      }
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError("permanent", "Clés Sendit refusées");
      }
    } else if (res.status === 401 || res.status === 403) {
      throw new ProviderError("permanent", "Clés Sendit refusées");
    }

    let text = "";
    try {
      text = await res.text();
    } catch (err) {
      if (options.uncertainOnThrow) {
        throw new ProviderError("unknown", "Réponse illisible de Sendit", { cause: err });
      }
      throw new ProviderError("retryable", "Réponse illisible de Sendit", { cause: err });
    }

    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }

    return { res, text, body, secrets };
  }

  function computeConfigurationIssues(): string[] {
    const issues: string[] = [];
    const env = getEnv();
    const publicKey = env.SENDIT_PUBLIC_KEY?.trim();
    const secretKey = env.SENDIT_SECRET_KEY?.trim();
    if (!publicKey || !secretKey) {
      issues.push("Clés Sendit manquantes (SENDIT_PUBLIC_KEY, SENDIT_SECRET_KEY)");
    }
    let settings: CourierSettings;
    try {
      settings = getSettingsFn()();
    } catch {
      settings = { ...DEFAULT_COURIER_SETTINGS };
    }
    if (settings.senditPickupDistrictId === null || settings.senditPickupDistrictId === undefined) {
      issues.push("District de ramassage Sendit non choisi (CRM → Paramètres)");
    }
    return issues;
  }

  return {
    name: "sendit" as const,
    profile: "sendit" as const,
    capabilities: COURIERS.sendit.capabilities,

    isConfigured(): boolean {
      return computeConfigurationIssues().length === 0;
    },

    configurationIssues(): string[] {
      return computeConfigurationIssues();
    },

    async testConnection(): Promise<void> {
      cachedToken = null;
      await login(true);
    },

    async listCities(): Promise<City[]> {
      const cities: City[] = [];
      let page = 1;
      let lastPage = 1;

      while (page <= 50) {
        const { res, body, text, secrets } = await requestWithAuth(`/districts?page=${page}`, {
          method: "GET",
          timeoutMs: 25_000,
        });

        if (!res.ok) {
          if (res.status === 429) {
            throw new ProviderError("throttled", formatErrorMessage(429, body, text, secrets), {
              retryAfterSec: Number(res.headers.get("Retry-After")) || undefined,
            });
          }
          if (res.status >= 500) {
            throw new ProviderError("retryable", formatErrorMessage(res.status, body, text, secrets));
          }
          throw new ProviderError("permanent", formatErrorMessage(res.status, body, text, secrets));
        }

        if (!isRecord(body)) {
          throw new ProviderError("unknown", "Réponse inattendue de Sendit sur les districts");
        }

        let items: unknown[] = [];
        if (Array.isArray(body.data)) {
          items = body.data;
        } else if (isRecord(body.data)) {
          items = Object.values(body.data);
        }

        const reported = pickLastPage(body);
        lastPage = reported !== null && Number.isInteger(reported) && reported >= 1 ? reported : 1;

        for (const row of items) {
          if (!isRecord(row)) continue;
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
          let arabicName: string | null = null;
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

          let priceMad: number | null = null;
          if (row.price !== undefined && row.price !== null) {
            const p = Number(row.price);
            if (Number.isInteger(p) && p >= 0) {
              priceMad = p;
            }
          }

          cities.push({ id, name, arabicName, pickup, priceMad });
        }

        if (page >= lastPage || page >= 50) {
          break;
        }
        page++;
      }

      if (cities.length === 0) {
        throw new ProviderError("unknown", "Aucun district Sendit reçu");
      }

      return cities;
    },

    async createParcel(input: ParcelRequest): Promise<CreateParcelResult> {
      const env = getEnv();
      const publicKey = env.SENDIT_PUBLIC_KEY?.trim();
      const secretKey = env.SENDIT_SECRET_KEY?.trim();
      if (!publicKey || !secretKey) {
        throw new ProviderError("permanent", "Sendit non configuré");
      }

      let settings: CourierSettings;
      try {
        settings = getSettingsFn()();
      } catch {
        settings = { ...DEFAULT_COURIER_SETTINGS };
      }
      if (settings.senditPickupDistrictId === null || settings.senditPickupDistrictId === undefined) {
        throw new ProviderError(
          "permanent",
          "District de ramassage Sendit non configuré — CRM → Paramètres.",
        );
      }

      if (!input.receiver || !input.receiver.trim() || !input.address || !input.address.trim()) {
        throw new ProviderError("permanent", "Destinataire et adresse obligatoires pour Sendit");
      }

      if (!Number.isInteger(input.cityId) || input.cityId <= 0) {
        throw new ProviderError("permanent", "Identifiant de district Sendit invalide");
      }

      const amount = input.codAmountMad;
      if (amount === undefined || !Number.isInteger(amount) || amount < 0) {
        throw new ProviderError("permanent", "Montant COD invalide pour Sendit");
      }

      if (!input.phoneLocal || !/^0[5-7]\d{8}$/.test(input.phoneLocal)) {
        throw new ProviderError(
          "permanent",
          "Numéro de téléphone marocain invalide pour Sendit (0[5-7]XXXXXXXX)",
        );
      }

      const payload = {
        reference: input.reference,
        name: input.receiver.trim(),
        amount,
        phone: input.phoneLocal,
        address: input.cityName?.trim()
          ? `${input.address.trim()}, ${input.cityName.trim()}`
          : input.address.trim(),
        pickup_district_id: settings.senditPickupDistrictId,
        district_id: input.cityId,
        comment: `Commande ${input.reference}`,
        allow_open: settings.senditAllowOpen ? 1 : 0,
        allow_try: settings.senditAllowTry ? 1 : 0,
        products: productsString(input.items, input.description ?? ""),
      };

      const { res, text, body, secrets } = await requestWithAuth("/deliveries", {
        method: "POST",
        json: payload,
        timeoutMs: 15_000,
        uncertainOnThrow: true,
        requeueOnLoginFailure: true,
      });

      if (res.status === 429) {
        throw new ProviderError("throttled", formatErrorMessage(429, body, text, secrets), {
          retryAfterSec: Number(res.headers.get("Retry-After")) || undefined,
        });
      }

      if (res.status === 200) {
        if (isRecord(body)) {
          if (body.success === false) {
            throw new ProviderError("permanent", formatErrorMessage(200, body, text, secrets));
          }
          if (body.success === true) {
            const code =
              isRecord(body.data) && typeof body.data.code === "string"
                ? body.data.code.trim()
                : "";
            if (code) {
              return {
                trackingNumber: code,
                raw: redactRaw(body, secrets),
              };
            }
            throw new ProviderError("unknown", formatErrorMessage(200, body, text, secrets));
          }
        }
        throw new ProviderError("unknown", formatErrorMessage(200, body, text, secrets));
      }

      if (res.status >= 400 && res.status < 500) {
        throw new ProviderError("permanent", formatErrorMessage(res.status, body, text, secrets));
      }

      // 0 or >= 500 or any other unhandled status
      throw new ProviderError("unknown", formatErrorMessage(res.status, body, text, secrets));
    },

    async getParcelInfo(trackingNumber: string): Promise<ParcelInfoResult> {
      if (!trackingNumber || !trackingNumber.trim()) {
        return { raw: null };
      }
      const cleanCode = trackingNumber.trim();
      const { res, body, text, secrets } = await requestWithAuth(
        `/deliveries/${encodeURIComponent(cleanCode)}`,
        { method: "GET", timeoutMs: 15_000 },
      );

      if (res.status === 404) {
        return { raw: null };
      }

      if (!res.ok) {
        if (res.status === 429) {
          throw new ProviderError("throttled", formatErrorMessage(429, body, text, secrets), {
            retryAfterSec: Number(res.headers.get("Retry-After")) || undefined,
          });
        }
        if (res.status >= 500) {
          throw new ProviderError("retryable", formatErrorMessage(res.status, body, text, secrets));
        }
        throw new ProviderError("permanent", formatErrorMessage(res.status, body, text, secrets));
      }

      return {
        raw: redactRaw(body, secrets),
        trackingNumber: cleanCode,
      };
    },

    async track(trackingNumbers: string[]): Promise<TrackingResult[]> {
      if (trackingNumbers.length === 0) return [];

      const results: TrackingResult[] = new Array(trackingNumbers.length);
      const state: {
        answered: number;
        failures: number;
        firstError: ProviderError | null;
        throttle: { retryAfterSec?: number } | null;
        fatal: ProviderError | null;
      } = { answered: 0, failures: 0, firstError: null, throttle: null, fatal: null };

      const skip = (index: number, skipped: "throttled" | "error"): void => {
        results[index] = {
          trackingNumber: trackingNumbers[index],
          rawStatus: null,
          raw: null,
          found: true,
          skipped,
          ...(skipped === "throttled" && state.throttle?.retryAfterSec !== undefined
            ? { retryAfterSec: state.throttle.retryAfterSec }
            : {}),
        };
      };
      const stopped = (): boolean =>
        state.throttle !== null ||
        state.fatal !== null ||
        (state.answered === 0 && state.failures >= 3);
      const onThrottle = (retryAfterSec: number | undefined, error: ProviderError): void => {
        if (state.throttle === null) {
          state.throttle = { retryAfterSec };
          console.warn("[sendit] Suivi limité par débit (HTTP 429), sondage interrompu");
        }
        state.firstError ??= error;
      };

      const trackOne = async (index: number): Promise<void> => {
        if (stopped()) {
          skip(index, state.throttle !== null ? "throttled" : "error");
          return;
        }
        const code = trackingNumbers[index];

        let outcome: Awaited<ReturnType<typeof requestWithAuth>>;
        try {
          outcome = await requestWithAuth(`/deliveries/${encodeURIComponent(code)}`, {
            method: "GET",
            timeoutMs: 15_000,
          });
        } catch (err) {
          const error =
            err instanceof ProviderError
              ? err
              : new ProviderError("retryable", "Suivi Sendit impossible", { cause: err });
          if (error.kind === "permanent") {
            // Keys refused / not configured: every other call would fail the same way.
            state.fatal ??= error;
          } else if (error.kind === "throttled") {
            onThrottle(error.retryAfterSec, error);
          } else {
            state.failures++;
            state.firstError ??= error;
          }
          skip(index, error.kind === "throttled" ? "throttled" : "error");
          return;
        }

        const { res, body, text, secrets } = outcome;
        if (res.status === 429) {
          const retryAfterSec = Number(res.headers.get("Retry-After")) || undefined;
          onThrottle(
            retryAfterSec,
            new ProviderError("throttled", formatErrorMessage(429, body, text, secrets), {
              retryAfterSec,
            }),
          );
          skip(index, "throttled");
          return;
        }

        if (res.status === 404) {
          state.answered++;
          results[index] = { trackingNumber: code, rawStatus: null, raw: null, found: false };
          return;
        }

        if (!res.ok) {
          state.failures++;
          state.firstError ??= new ProviderError(
            res.status >= 500 ? "retryable" : "permanent",
            formatErrorMessage(res.status, body, text, secrets),
          );
          skip(index, "error");
          return;
        }

        state.answered++;
        const d = isRecord(body) && isRecord(body.data) ? body.data : body;
        let rawStatus: string | null = null;
        if (isRecord(d)) {
          if (typeof d.status === "string") {
            rawStatus = d.status.toUpperCase().trim();
          } else if (isRecord(d.status) && typeof d.status.code === "string") {
            rawStatus = d.status.code.toUpperCase().trim();
          } else if (typeof d.status_code === "string") {
            rawStatus = d.status_code.toUpperCase().trim();
          }
        }
        if (!rawStatus) rawStatus = null;

        results[index] = {
          trackingNumber: code,
          rawStatus,
          raw: redactRaw(body, secrets),
          found: true,
        };
      };

      let nextIndex = 0;
      const worker = async (): Promise<void> => {
        while (nextIndex < trackingNumbers.length) {
          const idx = nextIndex++;
          await trackOne(idx);
        }
      };

      const concurrency = Math.min(3, trackingNumbers.length);
      await Promise.all(Array.from({ length: concurrency }, () => worker()));

      if (state.fatal) throw state.fatal;
      if (state.answered === 0) {
        throw state.firstError ?? new ProviderError("retryable", "Suivi Sendit indisponible");
      }
      return results;
    },

    async createDeliveryNote(): Promise<DeliveryNoteHandles> {
      throw new ProviderError("permanent", "BL non pris en charge par ce transporteur");
    },

    async addParcelsToDeliveryNote(): Promise<void> {
      throw new ProviderError("permanent", "BL non pris en charge par ce transporteur");
    },

    async saveDeliveryNote(): Promise<void> {
      throw new ProviderError("permanent", "BL non pris en charge par ce transporteur");
    },

    deliveryNotePdfUrl(): string {
      return "";
    },

    async getLabelsPdf(trackingNumbers: string[]): Promise<LabelsPdf> {
      if (!Array.isArray(trackingNumbers) || trackingNumbers.length === 0) {
        throw new ProviderError("permanent", "Aucun code à imprimer");
      }
      if (trackingNumbers.length > 100) {
        throw new ProviderError("permanent", "Au maximum 100 étiquettes par requête");
      }

      const baseUrl = getBaseUrl();
      const { res, body, text, secrets } = await requestWithAuth("/deliveries/getlabels", {
        method: "POST",
        json: {
          codesToPrint: trackingNumbers.join(","),
          printFormat: 1,
        },
        timeoutMs: 20_000,
      });

      if (!res.ok) {
        if (res.status === 429) {
          throw new ProviderError("throttled", formatErrorMessage(429, body, text, secrets), {
            retryAfterSec: Number(res.headers.get("Retry-After")) || undefined,
          });
        }
        if (res.status >= 500) {
          throw new ProviderError("retryable", formatErrorMessage(res.status, body, text, secrets));
        }
        throw new ProviderError("permanent", formatErrorMessage(res.status, body, text, secrets));
      }

      const urlCandidate = extractLabelUrl(body);
      if (!urlCandidate) {
        throw new ProviderError("unknown", "Lien d'étiquettes Sendit invalide");
      }

      let candidateUrl: URL;
      try {
        candidateUrl = new URL(urlCandidate);
      } catch {
        throw new ProviderError("unknown", "Lien d'étiquettes Sendit invalide");
      }

      const baseParsed = new URL(baseUrl);
      const protocolOk = candidateUrl.protocol === "https:" || baseParsed.protocol === "http:";
      if (!protocolOk || candidateUrl.host !== baseParsed.host) {
        throw new ProviderError("unknown", "Lien d'étiquettes Sendit invalide");
      }

      return { url: urlCandidate };
    },

    async findParcelByReference(
      reference: string,
      phoneLocal: string,
    ): Promise<ParcelLookupResult> {
      const cleanRef = reference.trim();
      const cleanPhone = phoneLocal.trim();
      if (!cleanRef || !cleanPhone) {
        return { complete: false, parcel: null };
      }

      let page = 1;
      while (page <= 3) {
        let outcome: { res: Response; body: unknown };
        try {
          outcome = await requestWithAuth(
            `/deliveries?querystring=${encodeURIComponent(cleanPhone)}&page=${page}`,
            { method: "GET", timeoutMs: 15_000 },
          );
          if (!outcome.res.ok) {
            return { complete: false, parcel: null };
          }
        } catch {
          return { complete: false, parcel: null };
        }

        const { body } = outcome;
        if (!isRecord(body)) {
          return { complete: false, parcel: null };
        }

        const rows = extractRows(body);

        for (const row of rows) {
          const rowRef =
            row.reference !== undefined && row.reference !== null
              ? String(row.reference).trim()
              : "";
          if (rowRef === cleanRef) {
            let rawStatus: string | null = null;
            if (typeof row.status === "string") {
              rawStatus = row.status.toUpperCase().trim();
            } else if (isRecord(row.status) && typeof row.status.code === "string") {
              rawStatus = row.status.code.toUpperCase().trim();
            } else if (typeof row.status_code === "string") {
              rawStatus = row.status_code.toUpperCase().trim();
            }
            if (rawStatus && DEAD_STATUSES.has(rawStatus)) {
              continue;
            }
            const trackingNumber =
              row.code !== undefined && row.code !== null ? String(row.code).trim() : "";
            if (trackingNumber) {
              return {
                complete: true,
                parcel: { trackingNumber, rawStatus },
              };
            }
          }
        }

        // Without last_page the page size is unknown, so a short page proves
        // nothing: only an empty first page is a conclusive "not found".
        const lastPage = pickLastPage(body);
        if (lastPage === null) {
          if (page === 1 && rows.length === 0) return { complete: true, parcel: null };
          return { complete: false, parcel: null };
        }
        if (page >= lastPage) {
          return { complete: true, parcel: null };
        }
        page++;
      }

      return { complete: false, parcel: null };
    },
  };
}
