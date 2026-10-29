/**
 * Order-lifecycle -> WhatsApp outbox triggers.
 *
 * Every hook runs inside its own nested transaction: called within the caller's
 * business transaction it becomes a SAVEPOINT, so a WhatsApp failure rolls back
 * only the WhatsApp writes and can never block or roll back a confirmation, a
 * parcel submission or a delivery outcome. Enqueueing follows the Meta outbox
 * pattern (rows join the business transaction, the leased whatsapp worker
 * delivers them later). No hook ever throws.
 */
import { getDb } from "@/lib/db";
import rawStoreConfig from "../../../store.config";
import type { CommerceOrderItem as OrderItem } from "@/lib/commerce-types";
import { log } from "@/lib/log";
import { normalizeMaPhoneCore } from "@/lib/phone-core";
import { casablancaParts } from "@/lib/whatsapp/pacing";
import {
  msgAdminAutoBlocked,
  msgAdminConfirmed,
  msgAdminRefused,
  msgCancelled,
  msgConfirmed,
  msgDelivered,
  msgRelanceNoAnswer,
  msgShipped,
  type Ctx,
} from "@/lib/whatsapp/copy";
import { maskPhone, orderRefFromOrderId } from "@/lib/whatsapp/phone";
import { effectiveAssistantName, getWhatsAppSettings } from "@/lib/services/whatsapp-settings";
import { cancelQueuedForOrder, enqueueOutbox, type EnqueueInput } from "@/lib/services/whatsapp-outbox";
import { addStrike, STRIKE_LABELS } from "@/lib/services/whatsapp-strikes";
import { summarizeItems } from "@/lib/services/orders";

/** Hard upper bound of a WhatsApp text body (1..4096); enqueueOutbox does not enforce it. */
const MAX_BODY_CHARS = 4096;
/** Minimum spread between the first and the latest no_answer contact for a relance. */
const RELANCE_MIN_GAP_MS = 2 * 60 * 60 * 1000;
/** Repeated-cancel strike threshold: >=3 orders cancelled after being confirmed. */
const REPEATED_CANCEL_THRESHOLD = 3;

const CONFIRMABLE_FOR_RELANCE = ["new", "no_answer", "call_back_later"] as const;

/** Same normalized-phone SQL expression as services/orders (migrations/017 index). */
const NORMALIZED_PHONE_SQL =
  "replace(replace(replace(replace(%COL%, ' ', ''), '-', ''), '(', ''), ')', '')";

export interface NotifyActor {
  id: string;
  name?: string | null;
}

interface NotifyOrder {
  id: string;
  customerName: string;
  customerPhone: string;
  items: OrderItem[];
  upsellStatus: string;
  upsellItems: OrderItem[] | null;
  total: number;
  cityName: string | null;
  confirmationStatus: string;
}

function safely(label: string, fn: () => void): void {
  try {
    getDb().transaction(fn)(); // nested => SAVEPOINT; failure rolls back only WhatsApp writes
  } catch (err) {
    log.error("wa.notify_failed", { label, error: err });
  }
}

/** Guard the 1..4096 body bound at the call sites: skip empty bodies, clamp long ones. */
function enqueueGuarded(input: EnqueueInput): boolean {
  const body = (input.body ?? "").trim();
  if (!body) return false;
  return enqueueOutbox({
    ...input,
    body: body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body,
  });
}

function parseItems(json: string | null): OrderItem[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as OrderItem[]) : [];
  } catch {
    return [];
  }
}

function readOrder(orderId: string): NotifyOrder | null {
  const row = getDb()
    .prepare(
      `SELECT id, customer_name, customer_phone, items_json, upsell_items_json, upsell_status,
              total, city_name, confirmation_status
       FROM orders WHERE id = ?`,
    )
    .get(orderId) as
    | {
        id: string;
        customer_name: string;
        customer_phone: string;
        items_json: string;
        upsell_items_json: string | null;
        upsell_status: string;
        total: number;
        city_name: string | null;
        confirmation_status: string;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    items: parseItems(row.items_json),
    upsellStatus: row.upsell_status,
    upsellItems: parseItems(row.upsell_items_json),
    total: row.total,
    cityName: row.city_name,
    confirmationStatus: row.confirmation_status,
  };
}

/** Items summary includes accepted upsell lines, like the confirmation snapshot. */
function combinedItems(order: NotifyOrder): OrderItem[] {
  const items = [...order.items];
  if (order.upsellStatus === "accepted" && order.upsellItems) {
    items.push(...order.upsellItems);
  }
  return items;
}

/** Store locale from the raw config (the zod loader would drag server-only into tests). */
function storeLocale(): "fr" | "ar" {
  // Widen first: store.config.ts infers a literal for the template's locale,
  // and fresh copies legitimately switch it to "ar".
  const locale: string = rawStoreConfig.locale;
  return locale === "ar" ? "ar" : "fr";
}

/** Customer conversation language wins; otherwise the store locale. */
function localeForPhone(phone: string): "fr" | "ar" {
  const normalized = normalizeMaPhoneCore(phone);
  const row = getDb()
    .prepare("SELECT language FROM wa_conversations WHERE phone = ? OR phone = ?")
    .get(...(normalized ? [normalized, phone] : [phone, phone])) as
    | { language: string | null }
    | undefined;
  if (row?.language === "ar" || row?.language === "darija_arabic") return "ar";
  if (row?.language === "fr" || row?.language === "darija_latin") return "fr";
  return storeLocale();
}

/** First word of the customer name, at most 30 characters. */
function firstNameOf(customerName: string | null): string | null {
  const first = customerName?.trim().split(/\s+/)[0] ?? "";
  return first ? first.slice(0, 30) : null;
}

function customerCtx(order: NotifyOrder, purpose: string): Ctx {
  const settings = getWhatsAppSettings();
  return {
    locale: localeForPhone(order.customerPhone),
    storeName: rawStoreConfig.name,
    assistantName: effectiveAssistantName(settings, rawStoreConfig.name),
    firstName: firstNameOf(order.customerName),
    ref: orderRefFromOrderId(order.id),
    seed: `${order.id}:${purpose}`,
  };
}

/** Public store origin for the tracking link (env wins, raw config domain as fallback). */
function publicBaseUrl(): string {
  const fromEnv = process.env.CRM_PUBLIC_URL?.trim();
  return (fromEnv || rawStoreConfig.domain).replace(/\/+$/, "");
}

/** Phone variants for SQL matching: E.164, local 0-prefixed and separator-stripped. */
function phoneVariants(phone: string): string[] {
  const variants = new Set<string>([phone.replace(/[ \-()]/g, "")]);
  const normalized = normalizeMaPhoneCore(phone);
  if (normalized) {
    variants.add(normalized);
    variants.add(`0${normalized.slice(4)}`);
  }
  return [...variants];
}

function phoneEqualitySql(column: string, variants: string[]): string {
  const expr = NORMALIZED_PHONE_SQL.replace("%COL%", column);
  return `(${variants.map(() => `${expr} = ?`).join(" OR ")})`;
}

/** Orders of this phone that were cancelled after a parcel had been created. */
function countCancelledAfterConfirmation(phone: string): number {
  const variants = phoneVariants(phone);
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM orders o
       WHERE ${phoneEqualitySql("o.customer_phone", variants)}
         AND o.confirmation_status = 'cancelled'
         AND EXISTS (SELECT 1 FROM courier_submissions cs WHERE cs.order_id = o.id)`,
    )
    .get(...variants) as { n: number };
  return row.n;
}

/** True when any conversation linked to this order already received an inbound message. */
function customerAlreadyWrote(orderId: string): boolean {
  return (
    getDb()
      .prepare(
        `SELECT 1 FROM wa_messages m
         JOIN wa_conversation_orders co ON co.conversation_id = m.conversation_id
         WHERE co.order_id = ? AND m.direction = 'in'
         LIMIT 1`,
      )
      .get(orderId) !== undefined
  );
}

/**
 * Confirmation hook: one customer message (setting notifyConfirmed) plus one
 * admin alert per admin phone (setting adminAlertsEnabled) with the city only,
 * never the address. Dedupe keys make retries and re-confirmations no-ops.
 */
export function notifyOrderConfirmed(orderId: string, actor?: NotifyActor | null): void {
  safely("confirmed", () => {
    const order = readOrder(orderId);
    if (!order) return;
    const settings = getWhatsAppSettings();
    const itemsSummary = summarizeItems(combinedItems(order));

    if (settings.notifyConfirmed) {
      const ctx = customerCtx(order, "notify_confirmed");
      enqueueGuarded({
        dedupeKey: `order:${order.id}:confirmed`,
        phone: order.customerPhone,
        purpose: "notify_confirmed",
        body: msgConfirmed({ ...ctx, totalMad: order.total, itemsSummary, cityName: order.cityName }),
        orderId: order.id,
      });
    }

    if (settings.adminAlertsEnabled) {
      const body = msgAdminConfirmed({
        ref: orderRefFromOrderId(order.id),
        itemsSummary,
        totalMad: order.total,
        cityName: order.cityName,
        actorName: actor?.name ?? null,
      });
      for (const adminPhone of settings.adminPhones) {
        enqueueGuarded({
          dedupeKey: `admin:${order.id}:confirmed:${adminPhone}`,
          phone: adminPhone,
          purpose: "admin_alert",
          body,
          orderId: order.id,
        });
      }
    }
  });
}

/** Parcel-created hook: only on the submission success path, with a tracking number. */
export function notifyOrderShipped(orderId: string, trackingNumber: string | null | undefined): void {
  safely("shipped", () => {
    const tracking = trackingNumber?.trim();
    if (!tracking) return;
    const settings = getWhatsAppSettings();
    if (!settings.notifyShipped) return;
    const order = readOrder(orderId);
    if (!order) return;
    const ctx = customerCtx(order, "notify_shipped");
    enqueueGuarded({
      dedupeKey: `order:${order.id}:shipped`,
      phone: order.customerPhone,
      purpose: "notify_shipped",
      body: msgShipped({
        ...ctx,
        trackingNumber: tracking,
        trackUrl: `${publicBaseUrl()}/suivi?ref=${ctx.ref}`,
      }),
      orderId: order.id,
    });
  });
}

/** Delivered hook (agent-declared or verified tracking). */
export function notifyOrderDelivered(orderId: string): void {
  safely("delivered", () => {
    const settings = getWhatsAppSettings();
    if (!settings.notifyDelivered) return;
    const order = readOrder(orderId);
    if (!order) return;
    const ctx = customerCtx(order, "notify_delivered");
    enqueueGuarded({
      dedupeKey: `order:${order.id}:delivered`,
      phone: order.customerPhone,
      purpose: "notify_delivered",
      body: msgDelivered(ctx),
      orderId: order.id,
    });
  });
}

/**
 * Refusal hook: admin alerts only (no customer message), then a refused_delivery
 * strike when WhatsApp is enabled; if the strike tips the customer into an
 * automatic block, the admins get one deduplicated alert per day and phone.
 */
export function onOrderRefused(orderId: string): void {
  safely("refused", () => {
    const settings = getWhatsAppSettings();
    const order = readOrder(orderId);
    if (!order) return;

    if (settings.adminAlertsEnabled) {
      const body = msgAdminRefused({
        ref: orderRefFromOrderId(order.id),
        totalMad: order.total,
        cityName: order.cityName,
      });
      for (const adminPhone of settings.adminPhones) {
        enqueueGuarded({
          dedupeKey: `admin:${order.id}:refused:${adminPhone}`,
          phone: adminPhone,
          purpose: "admin_alert",
          body,
          orderId: order.id,
        });
      }
    }

    if (!settings.enabled) return;
    const decision = addStrike({
      phone: order.customerPhone,
      reason: "refused_delivery",
      orderId: order.id,
    });
    if (decision.action === "blocked") {
      const day = casablancaParts(new Date()).date;
      const normalized = normalizeMaPhoneCore(order.customerPhone) ?? order.customerPhone;
      const body = msgAdminAutoBlocked({
        maskedPhone: maskPhone(order.customerPhone),
        reason: STRIKE_LABELS.refused_delivery,
      });
      for (const adminPhone of settings.adminPhones) {
        enqueueGuarded({
          dedupeKey: `admin:autoblock:${normalized}:${day}:${adminPhone}`,
          phone: adminPhone,
          purpose: "admin_alert",
          body,
          orderId: order.id,
        });
      }
    }
  });
}

/**
 * Cancellation hook: always cancels the order's queued notifications first
 * (confirmed/shipped/relance), then optionally informs the customer, then counts
 * cancellations after confirmation for the repeated-cancel strike.
 */
export function notifyOrderCancelled(orderId: string): void {
  safely("cancelled", () => {
    const settings = getWhatsAppSettings();
    cancelQueuedForOrder(orderId, ["notify_confirmed", "notify_shipped", "relance_no_answer"]);
    const order = readOrder(orderId);
    if (!order) return;

    if (settings.notifyCancelled) {
      const ctx = customerCtx(order, "notify_cancelled");
      enqueueGuarded({
        dedupeKey: `order:${order.id}:cancelled`,
        phone: order.customerPhone,
        purpose: "notify_cancelled",
        body: msgCancelled(ctx),
        orderId: order.id,
      });
    }

    if (!settings.enabled) return;
    if (countCancelledAfterConfirmation(order.customerPhone) >= REPEATED_CANCEL_THRESHOLD) {
      addStrike({
        phone: order.customerPhone,
        reason: "repeated_cancel",
        orderId: order.id,
      });
    }
  });
}

/**
 * Relance hook (called after a no_answer contact log): exactly one WhatsApp
 * relance per order, once relanceNoAnswerCount no_answer contacts exist spread
 * over at least 2 h, while the order is still awaiting confirmation and the
 * customer has not written yet. The dedupe key guarantees "once, ever".
 */
export function maybeEnqueueNoAnswerRelance(orderId: string): void {
  safely("relance", () => {
    const settings = getWhatsAppSettings();
    if (!settings.enabled || !settings.relanceAfterNoAnswer) return;
    const order = readOrder(orderId);
    if (!order) return;
    if (!(CONFIRMABLE_FOR_RELANCE as readonly string[]).includes(order.confirmationStatus)) return;

    const rows = getDb()
      .prepare(
        `SELECT created_at FROM order_contacts
         WHERE order_id = ? AND outcome = 'no_answer'
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(orderId) as Array<{ created_at: string }>;
    if (rows.length < settings.relanceNoAnswerCount) return;

    const first = Date.parse(rows[0].created_at);
    const last = Date.parse(rows[rows.length - 1].created_at);
    if (!Number.isFinite(first) || !Number.isFinite(last)) return;
    if (last - first < RELANCE_MIN_GAP_MS) return;
    if (customerAlreadyWrote(orderId)) return;

    const ctx = customerCtx(order, "relance_no_answer");
    enqueueGuarded({
      dedupeKey: `order:${order.id}:relance`,
      phone: order.customerPhone,
      purpose: "relance_no_answer",
      body: msgRelanceNoAnswer(ctx),
      orderId: order.id,
    });
  });
}
