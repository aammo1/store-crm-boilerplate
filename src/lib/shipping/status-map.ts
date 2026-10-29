import type { CourierName } from "./couriers";

/**
 * Normalized tracking status vocabulary (task-14).
 *
 * The raw → key mappings are INTENTIONALLY EMPTY for Ozon: Ozon's tracking response
 * schema and status strings are unverified (docs/operations.md, activation Ozon)
 * and live verification is PENDING owner authorization. No status meaning may
 * be invented — every raw value normalizes to "unknown" until the exact raw
 * strings are observed live and recorded here.
 *
 * Sendit statuses are vendor-published (official Sendit WooCommerce plugin,
 * sendit-ma-integration v2.2.x, GET /all-status-deliveries).
 */
export const TRACKING_STATUSES = [
  "delivered",
  "refused",
  "cancelled",
  "return_in_transit",
  "in_transit",
  "at_facility",
  "out_for_delivery",
  "awaiting_pickup",
  "delivery_issue",
  "unknown",
] as const;

export type NormalizedTrackingStatus = (typeof TRACKING_STATUSES)[number];

/** Ozon: empty until live verification (unchanged policy). Mutable for tests. */
export const OZON_STATUS_MAP: Record<string, NormalizedTrackingStatus> = {};
/** Backward-compatible alias used by existing tests. */
export const STATUS_MAP = OZON_STATUS_MAP;

/** Source: Sendit official WooCommerce plugin (sendit-ma-integration v2.2.x), GET /all-status-deliveries. */
export const SENDIT_STATUS_MAP: Record<string, NormalizedTrackingStatus> = {
  PENDING: "awaiting_pickup",
  TO_PREPARE: "awaiting_pickup",
  TOPICKUP: "awaiting_pickup",
  PICKEDUP: "in_transit",
  TRANSIT: "in_transit",
  WAREHOUSE: "at_facility",
  DISTRIBUTED: "at_facility",
  DELIVERING: "out_for_delivery",
  UNREACHABLE: "delivery_issue",
  POSTPONED: "delivery_issue",
  NEW_DESTINATION: "delivery_issue",
  DELIVERED: "delivered",
  REJECTED: "refused",
  RETURNED: "return_in_transit",
  CANCELED: "cancelled",
};

const SENDIT_ALIASES: Record<string, string> = {
  TO_PICKUP: "TOPICKUP",
  PICKED_UP: "PICKEDUP",
  CANCELLED: "CANCELED",
  IN_TRANSIT: "TRANSIT",
  RETOUR: "RETURNED",
  RETURN: "RETURNED",
};

export const STATUS_MAPS: Record<CourierName, Record<string, NormalizedTrackingStatus>> = {
  ozon: OZON_STATUS_MAP,
  sendit: SENDIT_STATUS_MAP,
};

export const SENDIT_STATUS_LABELS: Record<string, string> = {
  PENDING: "En attente",
  TO_PREPARE: "À préparer",
  NEW_DESTINATION: "À changer",
  TOPICKUP: "Ramassage en cours",
  PICKEDUP: "Ramassé",
  WAREHOUSE: "Entrepôt",
  TRANSIT: "En transit",
  DISTRIBUTED: "Distribué",
  UNREACHABLE: "Injoignable",
  POSTPONED: "Reporté",
  DELIVERING: "En cours de livraison",
  DELIVERED: "Livré",
  CANCELED: "Annulé",
  REJECTED: "Refusé",
  RETURNED: "Retourné",
};

// "TRACKING-NUMBER" ≈ "tracking_number" — mirrors the key matching used by the
// adapter (src/lib/shipping/ozon.ts) so STATUS_MAP entries tolerate casing and
// separator variants of the same raw string.
function keyOf(value: string): string {
  return value.toLowerCase().replace(/[\s_-]/g, "");
}

/**
 * Maps a raw provider status onto the normalized vocabulary.
 * For sendit: uppercase+trim, apply alias, exact lookup, else unknown.
 * For ozon: case/separator-tolerant lookup against OZON_STATUS_MAP.
 * Unmapped / empty / null / undefined values normalize to "unknown" — never guess a meaning.
 */
export function normalizeStatus(
  raw: string | null | undefined,
  courier: CourierName = "ozon",
): NormalizedTrackingStatus {
  const trimmed = raw?.trim();
  if (!trimmed) return "unknown";

  if (courier === "sendit") {
    const upper = trimmed.toUpperCase();
    const canonical = SENDIT_ALIASES[upper] ?? upper;
    return SENDIT_STATUS_MAP[canonical] ?? "unknown";
  }

  const direct = OZON_STATUS_MAP[trimmed];
  if (direct) return direct;
  const wanted = keyOf(trimmed);
  for (const [rawKey, target] of Object.entries(OZON_STATUS_MAP)) {
    if (keyOf(rawKey) === wanted) return target;
  }
  return "unknown";
}
