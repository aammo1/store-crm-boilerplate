import rawStoreConfig from "../../../store.config";
import { getDb } from "@/lib/db";
import { deliveryProviderName } from "@/lib/env";
import { log } from "@/lib/log";
import { msgDeliveryIssue, msgOutForDelivery, type Ctx } from "@/lib/whatsapp/copy";
import { casablancaParts } from "@/lib/whatsapp/pacing";
import { orderRefFromOrderId } from "@/lib/whatsapp/phone";
import { getStoreSettings } from "@/lib/services/store-settings";
import { enqueueOutbox, type OutboxPurpose } from "@/lib/services/whatsapp-outbox";
import {
  effectiveAssistantName,
  getWhatsAppSettings,
} from "@/lib/services/whatsapp-settings";

/**
 * Owner-maintained courier raw-status mapping (task-19).
 *
 * The tracking poller records every raw status it observes, per provider, in
 * `carrier_status_mappings`; the owner assigns each one a notification
 * category. A mapped `out_for_delivery` / `delivery_issue` status enqueues
 * WhatsApp notifications 3/4, at most once per order per Casablanca day per
 * category.
 *
 * HARD INVARIANT: these mappings feed WhatsApp notifications ONLY. They never
 * change stock, delivery outcomes, returns or `normalized_status` — those come
 * solely from the code `STATUS_MAP` (src/lib/shipping/status-map.ts) and agent
 * actions. No guessed value may ever be copied from here into STATUS_MAP.
 */

export const NOTIFY_CATEGORIES = [
  "in_transit",
  "out_for_delivery",
  "delivery_issue",
  "ignore",
] as const;

export type NotifyCategory = (typeof NOTIFY_CATEGORIES)[number];

const MAX_RAW_LENGTH = 200;
const MAX_PROVIDER_LENGTH = 40;

export class CarrierStatusMapError extends Error {
  readonly status: number;

  constructor(message: string, status: 400 | 404 = 400) {
    super(message);
    this.name = "CarrierStatusMapError";
    this.status = status;
  }
}

function isNotifyCategory(value: string): value is NotifyCategory {
  return (NOTIFY_CATEGORIES as readonly string[]).includes(value);
}

/** Trim, collapse inner whitespace and cap the stored raw status. */
function normalizeRawStatus(rawStatus: string): string {
  return rawStatus.trim().replace(/\s+/g, " ").slice(0, MAX_RAW_LENGTH);
}

/** The submission's provider wins; empty falls back to the configured provider. */
function normalizeProvider(provider: string): string {
  return provider.trim().slice(0, MAX_PROVIDER_LENGTH) || deliveryProviderName();
}

/**
 * Records one observation of a raw status for a provider. Empty raw statuses
 * are ignored. UPSERT bumps `sample_count` and `last_seen_at`; the existing
 * `notify_category` mapping is always preserved, `first_seen_at` is set only
 * on first sight.
 */
export function recordRawStatus(
  provider: string,
  rawStatus: string,
  now: Date = new Date(),
): boolean {
  const raw = normalizeRawStatus(rawStatus);
  if (!raw) return false;
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) return false;
  const at = now.toISOString();
  getDb()
    .prepare(
      `INSERT INTO carrier_status_mappings
         (provider, raw_status, notify_category, sample_count, first_seen_at, last_seen_at)
       VALUES (?, ?, NULL, 1, ?, ?)
       ON CONFLICT (provider, raw_status) DO UPDATE SET
         sample_count = sample_count + 1,
         last_seen_at = excluded.last_seen_at`,
    )
    .run(normalizedProvider, raw, at, at);
  return true;
}

/** The notification category mapped by the owner, or null when unmapped. */
export function notifyCategoryFor(
  provider: string,
  rawStatus: string,
): NotifyCategory | null {
  const raw = normalizeRawStatus(rawStatus);
  if (!raw) return null;
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) return null;
  const row = getDb()
    .prepare(
      "SELECT notify_category FROM carrier_status_mappings WHERE provider = ? AND raw_status = ?",
    )
    .get(normalizedProvider, raw) as { notify_category: string | null } | undefined;
  const category = row?.notify_category;
  return category && isNotifyCategory(category) ? category : null;
}

export interface CarrierStatusRow {
  provider: string;
  rawStatus: string;
  category: NotifyCategory | null;
  sampleCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  mappedBy: string | null;
  mappedByName: string | null;
  mappedAt: string | null;
}

/**
 * Observed raw statuses for the mapping screen: unmapped first, then by last
 * sighting (most recent first).
 */
export function listRawStatuses(provider?: string): CarrierStatusRow[] {
  const wanted = provider === undefined ? null : normalizeProvider(provider);
  const rows = getDb()
    .prepare(
      `SELECT m.provider, m.raw_status, m.notify_category, m.sample_count,
              m.first_seen_at, m.last_seen_at, m.mapped_by, m.mapped_at,
              u.name AS mapped_by_name
       FROM carrier_status_mappings m
       LEFT JOIN users u ON u.id = m.mapped_by
       WHERE (? IS NULL OR m.provider = ?)
       ORDER BY (m.notify_category IS NULL) DESC, m.last_seen_at DESC,
                m.provider ASC, m.raw_status ASC`,
    )
    .all(wanted, wanted) as Array<{
    provider: string;
    raw_status: string;
    notify_category: string | null;
    sample_count: number;
    first_seen_at: string;
    last_seen_at: string;
    mapped_by: string | null;
    mapped_at: string | null;
    mapped_by_name: string | null;
  }>;
  return rows.map((row) => ({
    provider: row.provider,
    rawStatus: row.raw_status,
    category:
      row.notify_category && isNotifyCategory(row.notify_category)
        ? row.notify_category
        : null,
    sampleCount: row.sample_count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    mappedBy: row.mapped_by,
    mappedByName: row.mapped_by_name,
    mappedAt: row.mapped_at,
  }));
}

/**
 * Owner decision for one raw status. UPSERTs so a status may also be mapped
 * before the poller first observes it. Clearing the category (null) also
 * clears the mapper audit fields.
 */
export function setNotifyCategory(
  provider: string,
  rawStatus: string,
  category: NotifyCategory | null,
  userId: string,
): void {
  if (category !== null && !isNotifyCategory(category)) {
    throw new CarrierStatusMapError("Catégorie de notification invalide.");
  }
  const raw = normalizeRawStatus(rawStatus);
  if (!raw) throw new CarrierStatusMapError("Statut brut invalide.");
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) throw new CarrierStatusMapError("Transporteur invalide.");
  const actor = userId.trim();
  if (!actor) throw new CarrierStatusMapError("Utilisateur requis.");
  const at = new Date().toISOString();
  getDb()
    .transaction(() => {
      getDb()
        .prepare(
          `INSERT INTO carrier_status_mappings
             (provider, raw_status, notify_category, sample_count, first_seen_at, last_seen_at, mapped_by, mapped_at)
           VALUES (?, ?, ?, 0, ?, ?, ?, ?)
           ON CONFLICT (provider, raw_status) DO UPDATE SET
             notify_category = excluded.notify_category,
             mapped_by = excluded.mapped_by,
             mapped_at = excluded.mapped_at`,
        )
        .run(
          normalizedProvider,
          raw,
          category,
          at,
          at,
          category === null ? null : actor,
          category === null ? null : at,
        );
    })
    .immediate();
}

// --- Notifications 3/4 driven by mapped raw statuses.

const NOTIFY_PURPOSE: Record<"out_for_delivery" | "delivery_issue", OutboxPurpose> = {
  out_for_delivery: "notify_out_for_delivery",
  delivery_issue: "notify_delivery_issue",
};

const DEDUPE_SEGMENT: Record<"out_for_delivery" | "delivery_issue", string> = {
  out_for_delivery: "ofd",
  delivery_issue: "issue",
};

function firstNameOf(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : null;
}

/** Conversation language, mapped to a message locale; null when unknown. */
function conversationLocale(
  db: ReturnType<typeof getDb>,
  phone: string,
): "fr" | "ar" | null {
  const row = db
    .prepare("SELECT language FROM wa_conversations WHERE phone = ?")
    .get(phone) as { language: string | null } | undefined;
  switch (row?.language) {
    case "ar":
    case "darija_arabic":
      return "ar";
    case "fr":
    case "darija_latin":
      return "fr";
    default:
      return null;
  }
}

function storeLocale(): "fr" | "ar" {
  // Widen first: store.config.ts infers a literal for the template's locale,
  // and fresh copies legitimately switch it to "ar".
  const locale: string = rawStoreConfig.locale;
  return locale === "ar" ? "ar" : "fr";
}

/**
 * Enqueues notification 3 (out for delivery) or 4 (delivery issue) when the
 * owner mapped this raw status accordingly. Never throws: any failure is
 * logged as `wa.notify_failed` and swallowed — a mapping must never break the
 * tracking poller. Guarded skips: matching setting off, order already
 * delivered/refused (`delivery_outcome` set) or cancelled. At most one
 * message per order per Casablanca day per category, via the outbox dedupe
 * key.
 *
 * Runs stock-free by design: nothing here touches inventory, delivery
 * outcomes, returns or normalized statuses.
 */
export function maybeNotifyFromRawStatus(
  orderId: string,
  submissionId: string,
  rawStatus: string,
  provider: string,
  now: Date = new Date(),
): boolean {
  const category = notifyCategoryFor(provider, rawStatus);
  if (category !== "out_for_delivery" && category !== "delivery_issue") {
    return false;
  }
  const purpose = NOTIFY_PURPOSE[category];
  try {
    const db = getDb();
    return db.transaction(() => {
      const order = db
        .prepare(
          `SELECT customer_name, customer_phone, total,
                  confirmation_status, delivery_outcome
           FROM orders WHERE id = ?`,
        )
        .get(orderId) as
        | {
            customer_name: string;
            customer_phone: string;
            total: number;
            confirmation_status: string;
            delivery_outcome: string | null;
          }
        | undefined;
      if (!order) return false;
      if (order.delivery_outcome !== null) return false;
      if (order.confirmation_status === "cancelled") return false;

      const settings = getWhatsAppSettings();
      if (!settings.enabled) return false;
      const toggleOn =
        category === "out_for_delivery"
          ? settings.notifyOutForDelivery
          : settings.notifyDeliveryIssue;
      if (!toggleOn) return false;

      const storeName = getStoreSettings().storeName;
      const ctx: Ctx = {
        locale: conversationLocale(db, order.customer_phone) ?? storeLocale(),
        storeName,
        assistantName: effectiveAssistantName(settings, storeName),
        firstName: firstNameOf(order.customer_name),
        ref: orderRefFromOrderId(orderId),
        seed: `${orderId}:${category}`,
      };
      const body =
        category === "out_for_delivery"
          ? msgOutForDelivery({ ...ctx, totalMad: order.total })
          : msgDeliveryIssue(ctx);
      return enqueueOutbox({
        dedupeKey: `order:${orderId}:${DEDUPE_SEGMENT[category]}:${casablancaParts(now).date}`,
        phone: order.customer_phone,
        purpose,
        body,
        orderId,
      });
    })();
  } catch (error) {
    log.warn("wa.notify_failed", { orderId, submissionId, purpose, error });
    return false;
  }
}
