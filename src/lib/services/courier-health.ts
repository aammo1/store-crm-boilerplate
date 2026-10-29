import { getDb } from "@/lib/db";
import { courierProfile, deliveryProviderName } from "@/lib/env";
import { COURIERS, type CourierName } from "@/lib/shipping/couriers";
import { getProvider } from "@/lib/shipping";
import type { DeliveryProvider } from "@/lib/shipping/provider";
import { getAppState } from "@/lib/services/app-state";
import { TRACKING_LAST_SYNC_KEY } from "@/lib/services/tracking";
import { getCourierSettings } from "@/lib/services/courier-settings";

export interface CourierHealth {
  courier: "ozon" | "sendit"; // profile
  label: string;
  mode: "live" | "mock";
  configured: boolean;
  issues: string[]; // French, blocking
  warnings: string[]; // French, non-blocking (pickup district in mock mode, vanished district)
  citiesCount: number; // cities WHERE provider = deliveryProviderName()
  pickupDistrictSet: boolean | null; // null when capability absent
  lastCitiesSyncAt: string | null; // MAX(updated_at) for provider
  lastTrackingSyncAt: string | null;
  queuedBlocked: number; // queued jobs the submission worker will not send (provider not configured)
  needsReview: number;
  deliveryIssues: number; // submitted parcels with normalized_status = 'delivery_issue'
}

let lastTestTimestamp = 0;
const COURIER_TEST_THROTTLE_MS = 10_000;

/** Enforces the 10-second per-process throttle for courier test calls. */
export function checkCourierTestThrottle(now: number = Date.now()): boolean {
  if (now - lastTestTimestamp < COURIER_TEST_THROTTLE_MS) {
    return false;
  }
  lastTestTimestamp = now;
  return true;
}

/** Reset throttle window for testing. */
export function __resetCourierTestThrottle(): void {
  lastTestTimestamp = 0;
}

/**
 * Returns read-only courier configuration and operational health indicators.
 * Never throws: wraps getProvider() and DB lookups safely.
 * Performs no network calls.
 */
export function getCourierHealth(): CourierHealth {
  const providerName = deliveryProviderName();
  const profile: CourierName = courierProfile();
  const courierDef = COURIERS[profile];
  const label = courierDef?.label ?? profile;
  const mode: "live" | "mock" = providerName === "mock" ? "mock" : "live";

  let provider: DeliveryProvider | null = null;
  let providerError: string | null = null;
  try {
    provider = getProvider();
  } catch {
    providerError = "Transporteur indisponible : vérifiez DELIVERY_PROVIDER et les clés.";
  }

  const db = getDb();

  const citiesRow = db
    .prepare("SELECT COUNT(*) AS count, MAX(updated_at) AS last_sync FROM cities WHERE provider = ?")
    .get(providerName) as { count: number; last_sync: string | null } | undefined;

  const citiesCount = citiesRow ? Number(citiesRow.count) : 0;
  const lastCitiesSyncAt = citiesRow?.last_sync ?? null;
  const lastTrackingSyncAt = getAppState(TRACKING_LAST_SYNC_KEY);

  let pickupDistrictSet: boolean | null = null;
  let pickupDistrictId: number | null = null;
  const hasPickupDistrictCap =
    provider?.capabilities.pickupDistrict ?? courierDef?.capabilities.pickupDistrict ?? false;
  if (hasPickupDistrictCap) {
    try {
      const settings = getCourierSettings();
      pickupDistrictId = Number.isInteger(settings.senditPickupDistrictId)
        ? settings.senditPickupDistrictId
        : null;
    } catch {
      pickupDistrictId = null;
    }
    pickupDistrictSet = pickupDistrictId !== null;
  }

  const issues: string[] = [];
  const warnings: string[] = [];
  let providerConfigured = false;

  if (providerError || !provider) {
    providerConfigured = false;
    issues.push(providerError ?? "Transporteur indisponible : vérifiez DELIVERY_PROVIDER et les clés.");
  } else {
    providerConfigured = provider.isConfigured ? provider.isConfigured() : true;
    if (!providerConfigured) {
      if (profile === "ozon") {
        issues.push("Clés Ozon manquantes (OZON_CLIENT_ID, OZON_API_KEY)");
      } else if (provider.configurationIssues) {
        issues.push(...provider.configurationIssues());
      } else {
        issues.push("Transporteur non configuré");
      }
    } else if (provider.configurationIssues) {
      issues.push(...provider.configurationIssues());
    }
  }

  if (citiesCount === 0) {
    issues.push("Aucune ville synchronisée — lancez la synchronisation.");
  }

  if (hasPickupDistrictCap) {
    if (pickupDistrictId === null) {
      if (mode === "mock") {
        warnings.push(
          "District de ramassage non choisi (CRM → Paramètres) — sans effet en mode test, requis avec un vrai transporteur.",
        );
      }
    } else if (citiesCount > 0) {
      const pickupRow = db
        .prepare("SELECT 1 FROM cities WHERE id = ? AND provider = ? AND is_pickup = 1")
        .get(pickupDistrictId, providerName);
      if (!pickupRow) {
        warnings.push(
          "Le district de ramassage enregistré n'est plus un district de ramassage valide — choisissez-en un autre (CRM → Paramètres).",
        );
      }
    }
  }

  const configured = providerConfigured && issues.length === 0;

  // Only the submission worker's gate (provider.isConfigured) leaves jobs queued;
  // an empty city list does not stop jobs whose city id is already frozen.
  let queuedBlocked = 0;
  if (!providerConfigured) {
    const queuedRow = db
      .prepare("SELECT COUNT(*) AS count FROM courier_submissions WHERE status = 'queued'")
      .get() as { count: number } | undefined;
    queuedBlocked = queuedRow ? Number(queuedRow.count) : 0;
  }

  const needsReviewRow = db
    .prepare("SELECT COUNT(*) AS count FROM courier_submissions WHERE status = 'needs_review'")
    .get() as { count: number } | undefined;
  const needsReview = needsReviewRow ? Number(needsReviewRow.count) : 0;

  const deliveryIssuesRow = db
    .prepare(
      "SELECT COUNT(*) AS count FROM courier_submissions WHERE status = 'submitted' AND normalized_status = 'delivery_issue'",
    )
    .get() as { count: number } | undefined;
  const deliveryIssues = deliveryIssuesRow ? Number(deliveryIssuesRow.count) : 0;

  return {
    courier: profile,
    label,
    mode,
    configured,
    issues,
    warnings,
    citiesCount,
    pickupDistrictSet,
    lastCitiesSyncAt,
    lastTrackingSyncAt,
    queuedBlocked,
    needsReview,
    deliveryIssues,
  };
}
