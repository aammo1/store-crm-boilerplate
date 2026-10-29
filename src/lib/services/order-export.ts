import { getDb } from "@/lib/db";
import { toCsv } from "@/lib/csv";
import { toLocalPhone } from "@/lib/phone";
import { TRACKING_STATUSES } from "@/lib/shipping/status-map";
import {
  NEXT_CALLBACK_SQL,
  endOfTodayCasablancaIso,
  formatCasablanca,
  summarizeItems,
  type ConfirmationStatus,
} from "@/lib/services/orders";

/** Hard cap: above this the export fails (413) instead of truncating silently. */
export const ORDER_EXPORT_MAX_ROWS = 50_000;
export const ORDER_EXPORT_TOO_LARGE_MESSAGE = "Trop de lignes : affinez les filtres.";

export class OrderExportTooLargeError extends Error {
  constructor(readonly total: number) {
    super(ORDER_EXPORT_TOO_LARGE_MESSAGE);
    this.name = "OrderExportTooLargeError";
  }
}

export interface OrderExportFilters {
  archived?: boolean;
  status?: ConfirmationStatus | "all";
  q?: string;
  assignedTo?: string;
  utmSource?: string;
  utmCampaign?: string;
  callbackDue?: boolean;
  submission?: string[];
  tracking?: string[];
}

export const ORDER_EXPORT_HEADERS = [
  "Référence", "Date (Casablanca)", "Client", "Téléphone", "Ville", "Adresse", "Articles",
  "Quantité", "Sous-total", "Remise", "Livraison", "Total", "Statut confirmation", "Agent",
  "Statut colis", "N° suivi", "Résultat livraison", "Date résultat", "Statut COD", "Payé le",
  "Source", "utm_source", "utm_medium", "utm_campaign", "utm_content", "Bloqué",
] as const;

const CONFIRMATION_FR: Record<string, string> = {
  new: "Nouvelle", no_answer: "Sans réponse", call_back_later: "Rappel",
  confirmed: "Confirmée", cancelled: "Annulée",
};
const SUBMISSION_FR: Record<string, string> = {
  queued: "En file", submitting: "En cours d'envoi", submitted: "Transmise au transporteur",
  failed: "Échec", needs_review: "À vérifier",
};
const OUTCOME_FR: Record<string, string> = { delivered: "Livrée", refused: "Refusée" };
const COD_FR: Record<string, string> = { awaiting_payment: "À encaisser", paid: "Encaissée" };

const SUBMISSION_FILTERS = ["queued", "submitting", "submitted", "failed", "needs_review"];

/** Same normalization as the orders page: an unspecified status means "new" unless another view filter is set. */
export function resolveExportStatus(
  rawStatus: string | undefined,
  f: Pick<OrderExportFilters, "archived" | "callbackDue" | "submission" | "tracking">,
): ConfirmationStatus | "all" {
  const known = ["new", "no_answer", "call_back_later", "confirmed", "cancelled", "all"];
  let status: ConfirmationStatus | "all";
  if (rawStatus && known.includes(rawStatus)) status = rawStatus as ConfirmationStatus | "all";
  else if (f.archived || f.callbackDue || (f.submission?.length ?? 0) > 0 || (f.tracking?.length ?? 0) > 0) status = "all";
  else status = "new";
  if (f.callbackDue && status !== "all" && status !== "call_back_later") status = "all";
  return status;
}

interface ExportRow {
  id: string; created_at: string; customer_name: string; customer_phone: string;
  city_name: string | null; address: string | null; items_json: string; upsell_status: string | null; upsell_items_json: string | null;
  subtotal: number; discount_amount: number; shipping: number; total: number;
  confirmation_status: string; agent_name: string | null;
  sub_status: string | null; tracking_number: string | null;
  delivery_outcome: string | null; delivery_outcome_at: string | null;
  cod_status: string | null; cod_paid_at: string | null; source: string | null;
  utm_source: string | null; utm_medium: string | null; utm_campaign: string | null;
  utm_content: string | null; phone_blocked: number;
}

function buildWhere(options: OrderExportFilters, now: Date): { sql: string; params: Array<string | number> } {
  const where: string[] = [options.archived ? "o.archived_at IS NOT NULL" : "o.archived_at IS NULL"];
  const params: Array<string | number> = [];
  if (options.status && options.status !== "all") {
    where.push("o.confirmation_status = ?");
    params.push(options.status);
  }
  if (options.assignedTo) { where.push("o.assigned_to = ?"); params.push(options.assignedTo); }
  if (options.utmSource) { where.push("o.utm_source = ?"); params.push(options.utmSource); }
  if (options.utmCampaign) { where.push("o.utm_campaign = ?"); params.push(options.utmCampaign); }
  const submission = options.submission?.filter((v) => SUBMISSION_FILTERS.includes(v));
  if (submission && submission.length > 0) {
    where.push(`EXISTS (SELECT 1 FROM courier_submissions cs WHERE cs.order_id = o.id AND cs.status IN (${submission.map(() => "?").join(", ")}))`);
    params.push(...submission);
  }
  const tracking = options.tracking?.filter((v) => (TRACKING_STATUSES as readonly string[]).includes(v));
  if (tracking && tracking.length > 0) {
    where.push(`EXISTS (SELECT 1 FROM courier_submissions cs WHERE cs.order_id = o.id AND cs.status = 'submitted' AND cs.normalized_status IN (${tracking.map(() => "?").join(", ")}))`);
    params.push(...tracking);
  }
  if (options.callbackDue) {
    where.push(`${NEXT_CALLBACK_SQL} <= ?`);
    params.push(endOfTodayCasablancaIso(now));
  }
  const q = options.q?.trim();
  if (q) {
    const norm = (c: string) => `replace(replace(replace(replace(${c}, ' ', ''), '-', ''), '(', ''), ')', '')`;
    const like = `%${q}%`;
    const clauses = [
      `${norm("o.customer_phone")} LIKE ?`, "o.customer_name LIKE ?", "o.id LIKE ?",
      "EXISTS (SELECT 1 FROM courier_submissions cs WHERE cs.order_id = o.id AND cs.tracking_number LIKE ?)",
    ];
    const qParams: string[] = [like, like, like, like];
    const digits = q.replace(/\D/g, "");
    if (digits.length >= 9) {
      const core = (digits.startsWith("212") ? digits.slice(3) : digits.replace(/^0+/, "")).slice(-9);
      clauses.push(`substr(${norm("o.customer_phone")}, -9) LIKE ?`);
      qParams.push(`%${core}%`);
    }
    where.push(`(${clauses.join(" OR ")})`);
    params.push(...qParams);
  }
  return { sql: `WHERE ${where.join(" AND ")}`, params };
}

function parseItems(json: string): Array<{ name: string; quantity: number; variant_label?: string }> {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Local form (05…/06…/07…) for valid +212 numbers: starts with 0, so no formula-guard apostrophe. Else unchanged. */
function localPhone(phone: string): string {
  const local = toLocalPhone(phone);
  return /^0[5-7]\d{8}$/.test(local) ? local : phone;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : formatCasablanca(iso);
}

/** Today's date as YYYY-MM-DD in Africa/Casablanca (for the download filename). */
export function exportFileDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Casablanca", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/**
 * Builds the CSV text (UTF-8 BOM, ';' delimiter, CRLF) for the filtered orders.
 * Throws OrderExportTooLargeError above ORDER_EXPORT_MAX_ROWS. Read-only.
 */
export function buildOrdersCsv(
  filters: OrderExportFilters,
  options: { now?: Date; maxRows?: number } = {},
): { csv: string; rowCount: number } {
  const db = getDb();
  const now = options.now ?? new Date();
  const maxRows = options.maxRows ?? ORDER_EXPORT_MAX_ROWS;
  const { sql, params } = buildWhere(filters, now);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM orders o ${sql}`).get(...params) as { n: number }).n;
  if (total > maxRows) throw new OrderExportTooLargeError(total);

  const rows = db
    .prepare(
      `SELECT o.id, o.created_at, o.customer_name, o.customer_phone, o.city_name, o.address, o.items_json, o.upsell_status, o.upsell_items_json,
              o.subtotal, o.discount_amount, o.shipping, o.total, o.confirmation_status,
              u.name AS agent_name,
              o.delivery_outcome, o.delivery_outcome_at, o.cod_status, o.cod_paid_at, o.source,
              o.utm_source, o.utm_medium, o.utm_campaign, o.utm_content,
              (SELECT cs.status FROM courier_submissions cs WHERE cs.order_id = o.id ORDER BY cs.created_at DESC, cs.rowid DESC LIMIT 1) AS sub_status,
              (SELECT cs.tracking_number FROM courier_submissions cs WHERE cs.order_id = o.id AND cs.tracking_number IS NOT NULL ORDER BY cs.created_at DESC, cs.rowid DESC LIMIT 1) AS tracking_number,
              (bp.phone IS NOT NULL) AS phone_blocked
       FROM orders o
       LEFT JOIN users u ON u.id = o.assigned_to
       LEFT JOIN blocked_phones bp ON bp.phone = o.customer_phone
       ${sql}
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT ?`,
    )
    .all(...params, maxRows) as ExportRow[];

  const body: unknown[][] = rows.map((r) => {
    const items = [
      ...parseItems(r.items_json),
      ...(r.upsell_status === "accepted" && r.upsell_items_json ? parseItems(r.upsell_items_json) : []),
    ];
    return [
      r.id, fmtDate(r.created_at), r.customer_name, localPhone(r.customer_phone), r.city_name ?? "", r.address ?? "",
      summarizeItems(items), items.reduce((s, it) => s + (Number(it.quantity) || 0), 0),
      r.subtotal, r.discount_amount ?? 0, r.shipping, r.total,
      CONFIRMATION_FR[r.confirmation_status] ?? r.confirmation_status, r.agent_name ?? "",
      r.sub_status ? SUBMISSION_FR[r.sub_status] ?? r.sub_status : "", r.tracking_number ?? "",
      r.delivery_outcome ? OUTCOME_FR[r.delivery_outcome] ?? r.delivery_outcome : "", fmtDate(r.delivery_outcome_at),
      r.cod_status ? COD_FR[r.cod_status] ?? r.cod_status : "", fmtDate(r.cod_paid_at),
      r.source ?? "", r.utm_source ?? "", r.utm_medium ?? "", r.utm_campaign ?? "", r.utm_content ?? "",
      r.phone_blocked ? "Oui" : "Non",
    ];
  });
  const csv = "﻿" + toCsv([[...ORDER_EXPORT_HEADERS], ...body], ";");
  return { csv, rowCount: rows.length };
}
