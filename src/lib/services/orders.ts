import { TRACKING_STATUSES } from "@/lib/shipping/status-map";
import { nanoid } from "nanoid";
import { getDb } from "@/lib/db";
import { getBlockedPhone } from "@/lib/services/customers";
import { deliveryProviderName } from "@/lib/env";
import { maybeEnqueueNoAnswerRelance } from "@/lib/whatsapp/notify";
import type { CommerceOrderItem as OrderItem, CommerceUpsellOffer as UpsellOfferJson, CommerceUpsellStatus as UpsellStatus } from "@/lib/commerce-types";

export const CRM_TIMEZONE = "Africa/Casablanca";

export type ConfirmationStatus =
  | "new"
  | "no_answer"
  | "call_back_later"
  | "confirmed"
  | "cancelled";

export type ContactChannel = "whatsapp" | "phone" | "note";

export type ContactOutcome = "no_answer" | "call_back_later" | "note" | "confirmed_info";

export const CONFIRMATION_STATUSES: ConfirmationStatus[] = [
  "new",
  "no_answer",
  "call_back_later",
  "confirmed",
  "cancelled",
];

// Outcomes that move the order's confirmation status; note/confirmed_info
// leave the current status untouched.
const STATUS_TRANSITIONS: Partial<Record<ContactOutcome, ConfirmationStatus>> = {
  no_answer: "no_answer",
  call_back_later: "call_back_later",
};

export class ContactValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ContactValidationError";
  }
}

// --- Africa/Casablanca timezone helpers (stored timestamps are ISO-8601 UTC).

const dtfOffset = new Intl.DateTimeFormat("en-US", {
  timeZone: CRM_TIMEZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function tzOffsetMs(date: Date, timeZone: string = CRM_TIMEZONE): number {
  const dtf =
    timeZone === CRM_TIMEZONE
      ? dtfOffset
      : new Intl.DateTimeFormat("en-US", {
          timeZone,
          hourCycle: "h23",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
  const parts: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

const dtfCasablancaParts = new Intl.DateTimeFormat("en-US", {
  timeZone: CRM_TIMEZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function getCasablancaParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const parts: Record<string, string> = {};
  for (const part of dtfCasablancaParts.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

export type CasablancaConversionResult =
  | { ok: true; iso: string }
  | { ok: false; error: string; code: "invalid" | "nonexistent" | "ambiguous" };

/**
 * Validates and converts a datetime-local string ("YYYY-MM-DDTHH:mm") in Africa/Casablanca
 * wall time to UTC ISO string, strictly handling calendar validity, DST gaps, and ambiguous folds.
 */
export function parseCasablancaLocal(local: string): CasablancaConversionResult {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) {
    return { ok: false, error: "Date de rappel invalide", code: "invalid" };
  }
  const [, yStr, moStr, dStr, hStr, miStr] = m;
  const y = Number(yStr);
  const mo = Number(moStr);
  const d = Number(dStr);
  const h = Number(hStr);
  const mi = Number(miStr);

  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h < 0 || h > 23 || mi < 0 || mi > 59) {
    return { ok: false, error: "Date de rappel invalide", code: "invalid" };
  }

  // Calendar overflow check (e.g., Feb 30 or April 31)
  const utcTest = new Date(Date.UTC(y, mo - 1, d, h, mi, 0, 0));
  if (
    utcTest.getUTCFullYear() !== y ||
    utcTest.getUTCMonth() !== mo - 1 ||
    utcTest.getUTCDate() !== d ||
    utcTest.getUTCHours() !== h ||
    utcTest.getUTCMinutes() !== mi
  ) {
    return { ok: false, error: "Date de rappel invalide", code: "invalid" };
  }

  const targetLocalUtcMs = Date.UTC(y, mo - 1, d, h, mi, 0, 0);

  // Discover possible offsets in a window around target date (-36h to +36h)
  const candidateOffsets = new Set<number>();
  for (let deltaHours = -36; deltaHours <= 36; deltaHours += 2) {
    candidateOffsets.add(tzOffsetMs(new Date(targetLocalUtcMs + deltaHours * 3600000)));
  }

  const matchingTimestamps: number[] = [];

  for (const offset of candidateOffsets) {
    const candidateUtcMs = targetLocalUtcMs - offset;
    const candidateDate = new Date(candidateUtcMs);
    const actualOffset = tzOffsetMs(candidateDate);
    if (actualOffset === offset) {
      const parts = getCasablancaParts(candidateDate);
      if (
        parts.year === y &&
        parts.month === mo &&
        parts.day === d &&
        parts.hour === h &&
        parts.minute === mi
      ) {
        matchingTimestamps.push(candidateUtcMs);
      }
    }
  }

  const uniqueTimestamps = [...new Set(matchingTimestamps)];

  if (uniqueTimestamps.length === 0) {
    return {
      ok: false,
      error: "Heure inexistante en raison du changement d'heure — veuillez choisir une autre heure.",
      code: "nonexistent",
    };
  }

  if (uniqueTimestamps.length > 1) {
    return {
      ok: false,
      error: "Heure ambiguë en raison du changement d'heure — veuillez choisir une autre heure.",
      code: "ambiguous",
    };
  }

  return { ok: true, iso: new Date(uniqueTimestamps[0]).toISOString() };
}

/** Interprets a datetime-local string ("YYYY-MM-DDTHH:mm") as Africa/Casablanca wall time → UTC ISO. */
export function casablancaLocalToUtcIso(local: string): string | null {
  const result = parseCasablancaLocal(local);
  return result.ok ? result.iso : null;
}

/** End of "today" in Africa/Casablanca as a UTC ISO string. */
export function endOfTodayCasablancaIso(now: Date = new Date()): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: CRM_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, mo, d] = dtf.format(now).split("-").map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, 23, 59, 59);
  const offset1 = tzOffsetMs(new Date(asUtc));
  const offset2 = tzOffsetMs(new Date(asUtc - offset1));
  return new Date(asUtc - offset2).toISOString();
}

/**
 * Global unfiltered count of all orders with a callback due on or before
 * the end of "today" in Africa/Casablanca.
 */
export function countDueCallbacks(now: Date = new Date()): number {
  const db = getDb();
  const cutoff = endOfTodayCasablancaIso(now);
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM orders o WHERE o.archived_at IS NULL AND ${NEXT_CALLBACK_SQL} <= ?`)
    .get(cutoff) as { n: number };
  return row.n;
}

const displayFormat = new Intl.DateTimeFormat("fr-FR", {
  timeZone: CRM_TIMEZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatCasablanca(iso: string): string {
  return displayFormat.format(new Date(iso));
}

// --- Rows / views.

interface JoinedOrderRow {
  archived_at: string | null;
  id: string;
  customer_name: string;
  customer_phone: string;
  items_json: string;
  upsell_offer_json: string | null;
  upsell_status: string;
  upsell_items_json: string | null;
  subtotal: number;
  shipping: number;
  total: number;
  currency: string;
  created_at: string;
  updated_at: string;
  confirmation_status: string;
  address: string | null;
  city_id: number | null;
  city_name: string | null;
  cod_status: string;
  source: string;
  assigned_to: string | null;
  assigned_to_name: string | null;
  next_callback_at: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
  referrer_host?: string | null;
  landing_path?: string | null;
  click_id_type?: string | null;
}

/** First-touch campaign data persisted at checkout; null on pre-attribution and manual orders. */
export interface OrderAttribution {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  referrerHost: string | null;
  landingPath: string | null;
  clickIdType: string | null;
}

export function attributionFromRow(row: JoinedOrderRow): OrderAttribution | null {
  const value: OrderAttribution = {
    utmSource: row.utm_source ?? null, utmMedium: row.utm_medium ?? null,
    utmCampaign: row.utm_campaign ?? null, utmContent: row.utm_content ?? null,
    utmTerm: row.utm_term ?? null, referrerHost: row.referrer_host ?? null,
    landingPath: row.landing_path ?? null, clickIdType: row.click_id_type ?? null,
  };
  return Object.values(value).some((v) => v !== null) ? value : null;
}

export interface OrderListItem {
  id: string;
  createdAt: string;
  customerName: string;
  customerPhone: string;
  itemsSummary: string;
  itemCount: number;
  total: number;
  currency: string;
  confirmationStatus: ConfirmationStatus;
  assignedTo: string | null;
  assignedToName: string | null;
  nextCallbackAt: string | null;
  duplicateOf: string | null;
  /** Logged "pas de réponse" call attempts. */
  noAnswerCount: number;
  /** Phone is on the blocklist (orders are still accepted, only flagged). */
  phoneBlocked: boolean;
  /** Other orders with this phone that were refused or returned. */
  priorRefusals: number;
}

export interface OrderListResult {
  orders: OrderListItem[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export interface ContactEntry {
  id: string;
  orderId: string;
  agentId: string | null;
  agentName: string | null;
  channel: ContactChannel;
  outcome: ContactOutcome;
  note: string | null;
  nextCallbackAt: string | null;
  createdAt: string;
}

export interface CourierSubmissionView {
  id: string;
  status: string;
  trackingNumber: string | null;
  normalizedStatus: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CrmOrder {
  archivedAt: string | null;
  id: string;
  customerName: string;
  customerPhone: string;
  items: OrderItem[];
  upsellOffer: UpsellOfferJson | null;
  upsellStatus: UpsellStatus;
  upsellItems: OrderItem[] | null;
  subtotal: number;
  shipping: number;
  total: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
  confirmationStatus: ConfirmationStatus;
  address: string | null;
  cityId: number | null;
  cityName: string | null;
  codStatus: string;
  source: string;
  assignedTo: string | null;
  assignedToName: string | null;
  nextCallbackAt: string | null;
  contacts: ContactEntry[];
  submission: CourierSubmissionView | null;
  duplicateOf: string | null;
  attribution: OrderAttribution | null;
}

export interface CrmAgent {
  id: string;
  name: string;
  email: string;
  role: string;
}

// --- Queries.

/** Current callback only: notes preserve it; later contact outcomes replace it. */
export const NEXT_CALLBACK_SQL =
  `(CASE WHEN o.confirmation_status = 'call_back_later' THEN
      (SELECT CASE WHEN c.outcome = 'call_back_later' THEN c.next_callback_at END
       FROM order_contacts c
       WHERE c.order_id = o.id AND c.outcome != 'note'
       ORDER BY c.created_at DESC, c.rowid DESC LIMIT 1)
    END)`;

// Submission statuses usable as a list filter (dashboard cards link here).
const SUBMISSION_FILTER_VALUES = [
  "queued",
  "submitting",
  "submitted",
  "failed",
  "needs_review",
] as const;

export type SubmissionFilterStatus = (typeof SUBMISSION_FILTER_VALUES)[number];

export interface ListOrdersOptions {
  archived?: boolean;
  status?: ConfirmationStatus | "all";
  q?: string;
  assignedTo?: string;
  /** Exact first-touch campaign filters. */
  utmSource?: string;
  utmCampaign?: string;
  callbackDue?: boolean;
  /** Courier submission statuses to match; unknown values are dropped. */
  submission?: string[];
  /**
   * Normalized tracking statuses of a SUBMITTED parcel (dashboard in-transit
   * card links here); unknown values are dropped.
   */
  tracking?: string[];
  page?: number;
  pageSize?: number;
}

export function listOrders(options: ListOrdersOptions = {}): OrderListResult {
  const db = getDb();
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));

  const where: string[] = [options.archived ? "o.archived_at IS NOT NULL" : "o.archived_at IS NULL"];
  const params: Array<string | number> = [];

  if (options.status && options.status !== "all") {
    where.push("o.confirmation_status = ?");
    params.push(options.status);
  }
  if (options.assignedTo) {
    where.push("o.assigned_to = ?");
    params.push(options.assignedTo);
  }
  if (options.utmSource) {
    where.push("o.utm_source = ?");
    params.push(options.utmSource);
  }
  if (options.utmCampaign) {
    where.push("o.utm_campaign = ?");
    params.push(options.utmCampaign);
  }
  const submissionStatuses = options.submission?.filter((value): value is SubmissionFilterStatus =>
    (SUBMISSION_FILTER_VALUES as readonly string[]).includes(value),
  );
  if (submissionStatuses && submissionStatuses.length > 0) {
    const placeholders = submissionStatuses.map(() => "?").join(", ");
    where.push(
      `EXISTS (SELECT 1 FROM courier_submissions cs
               WHERE cs.order_id = o.id AND cs.status IN (${placeholders}))`,
    );
    params.push(...submissionStatuses);
  }
  const trackingStatuses = options.tracking?.filter((value) =>
    (TRACKING_STATUSES as readonly string[]).includes(value),
  );
  if (trackingStatuses && trackingStatuses.length > 0) {
    const placeholders = trackingStatuses.map(() => "?").join(", ");
    where.push(
      `EXISTS (SELECT 1 FROM courier_submissions cs
               WHERE cs.order_id = o.id AND cs.status = 'submitted'
                 AND cs.normalized_status IN (${placeholders}))`,
    );
    params.push(...trackingStatuses);
  }
  if (options.callbackDue) {
    // NULL for resolved orders or contacts without a current callback.
    where.push(`${NEXT_CALLBACK_SQL} <= ?`);
    params.push(endOfTodayCasablancaIso());
  }
  const q = options.q?.trim();
  if (q) {
    const like = `%${q}%`;
    const clauses = [
      `${normalizedPhoneExpr("o.customer_phone")} LIKE ?`,
      "o.customer_name LIKE ?",
      "o.id LIKE ?",
      "EXISTS (SELECT 1 FROM courier_submissions cs WHERE cs.order_id = o.id AND cs.tracking_number LIKE ?)",
    ];
    const qParams: Array<string> = [like, like, like, like];
    // Also match the 9-digit Moroccan subscriber number so "0612345678"
    // finds "+212612345678" and vice versa.
    const qDigits = q.replace(/\D/g, "");
    if (qDigits.length >= 9) {
      const core = (
        qDigits.startsWith("212") ? qDigits.slice(3) : qDigits.replace(/^0+/, "")
      ).slice(-9);
      clauses.push(`substr(${normalizedPhoneExpr("o.customer_phone")}, -9) LIKE ?`);
      qParams.push(`%${core}%`);
    }
    where.push(`(${clauses.join(" OR ")})`);
    params.push(...qParams);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const total = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM orders o ${whereSql}`)
      .get(...params) as { n: number }
  ).n;

  const rows = db
    .prepare(
      `SELECT o.*, u.name AS assigned_to_name, ${NEXT_CALLBACK_SQL} AS next_callback_at,
              (SELECT COUNT(*) FROM order_contacts c WHERE c.order_id = o.id AND c.outcome = 'no_answer') AS no_answer_count,
              (bp.phone IS NOT NULL) AS phone_blocked,
              (SELECT COUNT(*) FROM orders po
               WHERE ${normalizedPhoneExpr("po.customer_phone")} = ${normalizedPhoneExpr("o.customer_phone")} AND po.id <> o.id
                 AND (po.delivery_outcome = 'refused'
                      OR EXISTS (SELECT 1 FROM returns r JOIN courier_submissions cs ON cs.id = r.submission_id
                                 WHERE cs.order_id = po.id))) AS prior_refusals
       FROM orders o
       LEFT JOIN users u ON u.id = o.assigned_to
       LEFT JOIN blocked_phones bp ON bp.phone = o.customer_phone
       ${whereSql}
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize) as Array<JoinedOrderRow & { no_answer_count: number; phone_blocked: number; prior_refusals: number }>;

  const duplicates = findDuplicatePhones(
    rows.map((row) => ({
      id: row.id,
      phone: row.customer_phone,
      status: row.confirmation_status,
    })),
  );

  const orders: OrderListItem[] = rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    itemsSummary: summarizeItems(parseItems(row.items_json)),
    itemCount: parseItems(row.items_json).reduce((sum, it) => sum + it.quantity, 0),
    total: row.total,
    currency: row.currency,
    confirmationStatus: row.confirmation_status as ConfirmationStatus,
    assignedTo: row.assigned_to,
    assignedToName: row.assigned_to_name,
    nextCallbackAt: row.next_callback_at,
    duplicateOf: duplicates.get(row.id) ?? null,
    noAnswerCount: Number(row.no_answer_count),
    phoneBlocked: !!row.phone_blocked,
    priorRefusals: Number(row.prior_refusals),
  }));

  return {
    orders,
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function parseItems(json: string): OrderItem[] {
  try {
    return JSON.parse(json) as OrderItem[];
  } catch {
    return [];
  }
}

export function summarizeItems(items: Array<Pick<OrderItem, "name" | "quantity"> & { variant_label?: string }>): string {
  return items
    .map((it) => `${it.name} ×${it.quantity}${it.variant_label ? ` (${it.variant_label})` : ""}`)
    .join(" · ");
}

/**
 * SQLite expression normalizing a phone column/param (strips separators).
 * Indexed by migrations/017 (idx_orders_phone_normalized): keep both identical.
 */
function normalizedPhoneExpr(operand: string): string {
  return `replace(replace(replace(replace(${operand}, ' ', ''), '-', ''), '(', ''), ')', '')`;
}

/** JS twin of normalizedPhoneExpr: strips exactly the same characters (space, -, (, )). */
function normalizePhoneKey(phone: string): string {
  return phone.replace(/[ \-()]/g, "");
}

/** For each order id, another non-cancelled order sharing the same normalized phone (if any). */
function findDuplicatePhones(
  orders: Array<{ id: string; phone: string; status: string }>,
): Map<string, string> {
  const map = new Map<string, string>();
  if (orders.length === 0) return map;

  // Mirrors the SQL normalization below (separators are stripped; phones are
  // stored +212… normalized at creation).
  const normalize = normalizePhoneKey;

  const phones = [...new Set(orders.map((o) => normalize(o.phone)))];
  const placeholders = phones.map(() => normalizedPhoneExpr("?")).join(",");
  const rows = getDb()
    .prepare(
      `SELECT id, customer_phone FROM orders
       WHERE ${normalizedPhoneExpr("customer_phone")} IN (${placeholders}) AND confirmation_status <> 'cancelled' AND archived_at IS NULL`,
    )
    .all(...phones) as Array<{ id: string; customer_phone: string }>;

  const byPhone = new Map<string, string[]>();
  for (const row of rows) {
    const key = normalize(row.customer_phone);
    const list = byPhone.get(key) ?? [];
    list.push(row.id);
    byPhone.set(key, list);
  }
  for (const { id, phone, status } of orders) {
    if (status === "cancelled") continue;
    const others = (byPhone.get(normalize(phone)) ?? []).filter(
      (otherId) => otherId !== id,
    );
    if (others.length > 0) map.set(id, others[0]);
  }
  return map;
}

export function getCrmOrder(id: string): CrmOrder | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT o.*, u.name AS assigned_to_name, ${NEXT_CALLBACK_SQL} AS next_callback_at
       FROM orders o
       LEFT JOIN users u ON u.id = o.assigned_to
       WHERE o.id = ?`,
    )
    .get(id) as JoinedOrderRow | undefined;
  if (!row) return null;

  const contacts = (
    db
      .prepare(
        `SELECT c.*, u.name AS agent_name
         FROM order_contacts c
         LEFT JOIN users u ON u.id = c.agent_id
         WHERE c.order_id = ?
         ORDER BY c.created_at ASC, c.rowid ASC`,
      )
      .all(id) as Array<{
      id: string;
      order_id: string;
      agent_id: string | null;
      agent_name: string | null;
      channel: string;
      outcome: string;
      note: string | null;
      next_callback_at: string | null;
      created_at: string;
    }>
  ).map((row) => ({
    id: row.id,
    orderId: row.order_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    channel: row.channel as ContactChannel,
    outcome: row.outcome as ContactOutcome,
    note: row.note,
    nextCallbackAt: row.next_callback_at,
    createdAt: row.created_at,
  }));

  const submissionRow = db
    .prepare(
      "SELECT * FROM courier_submissions WHERE order_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(id) as
    | {
        id: string;
        status: string;
        tracking_number: string | null;
        normalized_status: string | null;
        last_error: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;

  const duplicates = findDuplicatePhones([
    {
      id: row.id,
      phone: row.customer_phone,
      status: row.confirmation_status,
    },
  ]);

  return {
    id: row.id,
    customerName: row.customer_name,
    archivedAt: row.archived_at,
    customerPhone: row.customer_phone,
    items: parseItems(row.items_json),
    upsellOffer: row.upsell_offer_json
      ? (JSON.parse(row.upsell_offer_json) as UpsellOfferJson)
      : null,
    upsellStatus: row.upsell_status as UpsellStatus,
    upsellItems: row.upsell_items_json
      ? (JSON.parse(row.upsell_items_json) as OrderItem[])
      : null,
    subtotal: row.subtotal,
    shipping: row.shipping,
    total: row.total,
    currency: row.currency,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmationStatus: row.confirmation_status as ConfirmationStatus,
    address: row.address,
    cityId: row.city_id,
    cityName: row.city_name,
    codStatus: row.cod_status,
    source: row.source,
    assignedTo: row.assigned_to,
    assignedToName: row.assigned_to_name,
    nextCallbackAt: row.next_callback_at,
    contacts,
    submission: submissionRow
      ? {
          id: submissionRow.id,
          status: submissionRow.status,
          trackingNumber: submissionRow.tracking_number,
          normalizedStatus: submissionRow.normalized_status,
          lastError: submissionRow.last_error,
          createdAt: submissionRow.created_at,
          updatedAt: submissionRow.updated_at,
        }
      : null,
    duplicateOf: duplicates.get(row.id) ?? null,
    attribution: attributionFromRow(row),
  };
}

// --- Mutations.

export interface InsertContactInput {
  orderId: string;
  agentId: string;
  channel: ContactChannel;
  outcome: ContactOutcome;
  note?: string | null;
  nextCallbackAt?: string | null;
  allowPastCallback?: boolean;
}

export function insertContact(input: InsertContactInput): ContactEntry | null {
  if (input.outcome === "call_back_later") {
    if (!input.nextCallbackAt || !input.nextCallbackAt.trim()) {
      throw new ContactValidationError("Date de rappel requise");
    }
    const timestamp = Date.parse(input.nextCallbackAt);
    if (Number.isNaN(timestamp)) {
      throw new ContactValidationError("Date de rappel invalide");
    }
    if (!input.allowPastCallback && timestamp <= Date.now()) {
      throw new ContactValidationError("La date de rappel doit être dans le futur");
    }
  }

  const db = getDb();
  const now = new Date().toISOString();
  const id = `occ_${nanoid(12)}`;

  const created = db.transaction((): ContactEntry | null => {
    const order = db
      .prepare("SELECT id FROM orders WHERE id = ?")
      .get(input.orderId);
    if (!order) return null;

    db.prepare(
      `INSERT INTO order_contacts (id, order_id, agent_id, channel, outcome, note, next_callback_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.orderId,
      input.agentId,
      input.channel,
      input.outcome,
      input.note?.trim() ? input.note.trim() : null,
      input.nextCallbackAt ?? null,
      now,
    );

    const nextStatus = STATUS_TRANSITIONS[input.outcome];
    if (nextStatus) {
      db.prepare(
        `UPDATE orders SET confirmation_status = ?, updated_at = ?
         WHERE id = ? AND confirmation_status IN ('new', 'no_answer', 'call_back_later')`,
      ).run(nextStatus, now, input.orderId);
    }

    // One WhatsApp relance per order at most; joins this transaction (outbox
    // pattern) and never throws (own savepoint).
    if (input.outcome === "no_answer") {
      maybeEnqueueNoAnswerRelance(input.orderId);
    }

    const agentName = db
      .prepare("SELECT name FROM users WHERE id = ?")
      .get(input.agentId) as { name: string } | undefined;

    return {
      id,
      orderId: input.orderId,
      agentId: input.agentId,
      agentName: agentName?.name ?? null,
      channel: input.channel,
      outcome: input.outcome,
      note: input.note?.trim() ? input.note.trim() : null,
      nextCallbackAt: input.nextCallbackAt ?? null,
      createdAt: now,
    };
  }).immediate();

  return created;
}
export function userExists(userId: string): boolean {
  return (
    getDb()
      .prepare("SELECT 1 FROM users WHERE id = ?")
      .get(userId) !== undefined
  );
}

export function isAgentEligible(userId: string): boolean {
  return (
    getDb()
      .prepare("SELECT 1 FROM users WHERE id = ? AND is_active = 1")
      .get(userId) !== undefined
  );
}

export function assignOrder(orderId: string, agentId: string | null): boolean {
  const db = getDb();
  if (agentId === null) {
    const result = db
      .prepare("UPDATE orders SET assigned_to = NULL, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), orderId);
    return result.changes > 0;
  }
  const result = db
    .prepare(
      `UPDATE orders SET assigned_to = ?, updated_at = ?
       WHERE id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND is_active = 1)`,
    )
    .run(agentId, new Date().toISOString(), orderId, agentId);
  return result.changes > 0;
}

export function listAgents(): CrmAgent[] {
  return (
    getDb()
      .prepare(
        "SELECT id, name, email, role FROM users WHERE is_active = 1 ORDER BY name ASC",
      )
      .all() as Array<{ id: string; name: string; email: string; role: string }>
  ).map((row) => ({ id: row.id, name: row.name, email: row.email, role: row.role }));
}

export interface CityOption {
  id: number;
  name: string;
  arabicName?: string | null;
}

export function listCities(): CityOption[] {
  return getDb()
    .prepare("SELECT id, name, arabic_name AS arabicName FROM cities WHERE provider = ? ORDER BY name COLLATE NOCASE ASC")
    .all(deliveryProviderName()) as CityOption[];
}

export interface CustomerHistoryOrder {
  id: string;
  confirmationStatus: ConfirmationStatus;
  total: number;
  createdAt: string;
  archived: boolean;
  returned: boolean;
}

export interface CustomerHistory {
  orderCount: number;
  confirmedCount: number;
  cancelledCount: number;
  returnedCount: number;
  deliveredCount: number;
  refusedCount: number;
  blocked: { reason: string; createdAt: string; createdBy: string | null } | null;
  recent: CustomerHistoryOrder[];
}

const CUSTOMER_HISTORY_LIMIT = 8;

/**
 * Read-only past behaviour of the same phone (all other orders, archived
 * included): helps agents spot repeat refusers before confirming.
 */
export function getCustomerHistory(orderId: string, phone: string): CustomerHistory {
  const normalized = normalizePhoneKey(phone);
  const rows = getDb()
    .prepare(
      `SELECT o.id, o.confirmation_status, o.total, o.created_at, o.archived_at,
              EXISTS (SELECT 1 FROM returns r JOIN courier_submissions cs ON cs.id = r.submission_id
                      WHERE cs.order_id = o.id) AS returned,
              o.delivery_outcome
       FROM orders o
       WHERE ${normalizedPhoneExpr("o.customer_phone")} = ${normalizedPhoneExpr("?")} AND o.id <> ?
       ORDER BY o.created_at DESC, o.id DESC`,
    )
    .all(normalized, orderId) as Array<{
      id: string; confirmation_status: ConfirmationStatus; total: number;
      created_at: string; archived_at: string | null; returned: number;
      delivery_outcome: string | null;
    }>;
  const block = getBlockedPhone(phone);
  return {
    orderCount: rows.length,
    confirmedCount: rows.filter((r) => r.confirmation_status === "confirmed").length,
    cancelledCount: rows.filter((r) => r.confirmation_status === "cancelled").length,
    returnedCount: rows.filter((r) => r.returned).length,
    deliveredCount: rows.filter((r) => r.delivery_outcome === "delivered").length,
    refusedCount: rows.filter((r) => r.delivery_outcome === "refused").length,
    blocked: block ? { reason: block.reason, createdAt: block.createdAt, createdBy: block.createdByName ?? block.createdBy } : null,
    recent: rows.slice(0, CUSTOMER_HISTORY_LIMIT).map((r) => ({
      id: r.id,
      confirmationStatus: r.confirmation_status,
      total: r.total,
      createdAt: r.created_at,
      archived: !!r.archived_at,
      returned: !!r.returned,
    })),
  };
}
