import { getDb } from "@/lib/db";
import { normalizeMaPhone } from "@/lib/phone";
import { orderRefSqlMatch } from "@/lib/whatsapp/phone";

export type PublicTrackingStatus = "received" | "confirmed" | "shipped" | "delivered" | "refused" | "cancelled";
export type PublicTracking = { status: PublicTrackingStatus; trackingNumber?: string; updatedAt: string };

type OrderRow = {
  id: string; confirmation_status: string; delivery_outcome: string | null; updated_at: string;
};

/**
 * Minimal public lookup. Requires the order reference the customer saw (full id or the
 * 8-character prefix shown on the thank-you page) AND the matching phone. Every miss
 * (bad ref, bad phone, wrong phone) returns null so callers cannot enumerate orders.
 */
export function lookupOrderTracking(orderRef: unknown, phone: unknown): PublicTracking | null {
  if (typeof orderRef !== "string" || typeof phone !== "string") return null;
  const ref = orderRef.trim().toUpperCase();
  const normalized = normalizeMaPhone(phone);
  if (!normalized || !/^[A-Z0-9_-]{4,40}$/.test(ref)) return null;
  const db = getDb();
  const rows = db.prepare(`SELECT id, confirmation_status, delivery_outcome, updated_at FROM orders
    WHERE customer_phone = ? AND (upper(id) = ?
      OR (length(?) >= 8 AND upper(id) LIKE ? ESCAPE '\\')
      OR (length(?) = 8 AND ${orderRefSqlMatch()}))
    ORDER BY created_at DESC LIMIT 1`).get(normalized, ref, ref, `${ref.replace(/[\\%_]/g, "\\$&")}%`, ref, ref, ref) as OrderRow | undefined;
  if (!rows) return null;
  const submission = db.prepare(`SELECT tracking_number FROM courier_submissions
    WHERE order_id = ? AND status = 'submitted' ORDER BY created_at DESC LIMIT 1`).get(rows.id) as
    { tracking_number: string | null } | undefined;
  const trackingNumber = submission?.tracking_number || undefined;
  let status: PublicTrackingStatus = "received";
  if (rows.confirmation_status === "cancelled") status = "cancelled";
  else if (rows.delivery_outcome === "delivered") status = "delivered";
  else if (rows.delivery_outcome === "refused") status = "refused";
  else if (submission) status = "shipped";
  else if (rows.confirmation_status === "confirmed") status = "confirmed";
  return { status, ...(trackingNumber && (status === "shipped" || status === "delivered" || status === "refused") ? { trackingNumber } : {}),
    updatedAt: rows.updated_at };
}
