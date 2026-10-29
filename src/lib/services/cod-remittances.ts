import { nanoid } from "nanoid";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { CSV_MAX_ROWS, CsvError, parseCsv } from "@/lib/csv";
import { setDeliveryOutcome } from "@/lib/services/delivery-outcomes";

export const REMITTANCE_UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;
export const REMITTANCE_MAX_LINES = CSV_MAX_ROWS;

export class RemittanceError extends Error {
  status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "RemittanceError";
    this.status = status;
  }
}

export interface CsvMapping {
  trackingColumn: number;
  amountColumn: number;
  feeColumn: number | null;
}

export type PreviewStatus =
  | "matched"
  | "mismatch"
  | "foreign"
  | "invalid"
  | "duplicate"
  | "already_paid"
  | "needs_delivery"
  | "not_deliverable";

export interface PreviewRow {
  rowNumber: number;
  trackingNumber: string;
  paidAmount: number | null;
  feeAmount: number;
  status: PreviewStatus;
  orderId: string | null;
  expectedAmount: number | null;
  message: string | null;
}

export interface StatementPreview {
  delimiter: string;
  headers: string[];
  mapping: CsvMapping;
  rows: PreviewRow[];
}

/** Parses MAD amounts: "1 234,00", "1234.00", "1,234.00", "350 DH". Non-zero centimes are rejected. */
export function parseMadAmount(raw: string): { ok: true; amount: number } | { ok: false; reason: string } {
  let s = raw.replace(/[\s  ]/g, "").replace(/(mad|dhs?)$/i, "");
  if (!s) return { ok: false, reason: "Montant vide." };
  if (!/^\d[\d.,]*$/.test(s)) return { ok: false, reason: "Montant illisible." };
  const lastSep = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  let intPart = s;
  let decPart = "";
  if (lastSep >= 0) {
    const after = s.length - lastSep - 1;
    const other = s.slice(0, lastSep);
    const mixed = /[.,]/.test(other);
    const sameSep = other.includes(s[lastSep]);
    if (after === 3 && !mixed) {
      intPart = s; // lone separator followed by 3 digits = thousands
    } else if (after <= 2 && after >= 1 && !sameSep) {
      intPart = other;
      decPart = s.slice(lastSep + 1);
    } else if (after === 3 && mixed && !sameSep) {
      return { ok: false, reason: "Montant illisible." };
    } else if (after === 3) {
      intPart = s;
    } else {
      return { ok: false, reason: "Montant illisible." };
    }
    intPart = intPart.replace(/[.,]/g, "");
  }
  if (/[1-9]/.test(decPart)) return { ok: false, reason: "Centimes non nuls : montant non entier." };
  s = intPart;
  const amount = Number(s);
  if (!Number.isSafeInteger(amount)) return { ok: false, reason: "Montant illisible." };
  return { ok: true, amount };
}

export function guessMapping(headers: string[]): CsvMapping {
  const find = (re: RegExp, skip: number[] = []) =>
    headers.findIndex((h, i) => !skip.includes(i) && re.test(h.toLowerCase()));
  const tracking = find(/code|suivi|tracking/);
  const amount = find(/montant|amount|crbt|cod/, [tracking]);
  const fee = find(/frais|fee|commission/, [tracking, amount]);
  return {
    trackingColumn: tracking >= 0 ? tracking : 0,
    amountColumn: amount >= 0 ? amount : Math.min(1, Math.max(headers.length - 1, 0)),
    feeColumn: fee >= 0 ? fee : null,
  };
}

interface MatchRow {
  order_id: string;
  total: number;
  cod_status: string;
  confirmation_status: string;
  delivery_outcome: string | null;
  tracking_number: string;
  remitted: number;
}

function matchTracking(tracking: string): MatchRow | undefined {
  return getDb()
    .prepare(
      `SELECT o.id AS order_id, o.total, o.cod_status, o.confirmation_status, o.delivery_outcome,
              cs.tracking_number,
              EXISTS(SELECT 1 FROM cod_remittance_lines l WHERE l.order_id = o.id) AS remitted
       FROM courier_submissions cs JOIN orders o ON o.id = cs.order_id
       WHERE cs.status = 'submitted' AND upper(cs.tracking_number) = upper(?)
       ORDER BY cs.created_at DESC LIMIT 1`,
    )
    .get(tracking) as MatchRow | undefined;
}

function classify(m: MatchRow | undefined, paid: number, fee: number): Pick<PreviewRow, "status" | "orderId" | "expectedAmount" | "message"> {
  if (!m) return { status: "foreign", orderId: null, expectedAmount: null, message: "Colis inconnu dans cette boutique (autre boutique du même compte ?) — ignoré." };
  const base = { orderId: m.order_id, expectedAmount: m.total };
  if (m.remitted || m.cod_status === "paid") {
    return { ...base, status: "already_paid", message: "Déjà encaissée." };
  }
  if (m.confirmation_status !== "confirmed" || m.delivery_outcome === "refused") {
    return { ...base, status: "not_deliverable", message: m.delivery_outcome === "refused" ? "Colis refusé : pas d'encaissement." : "Commande non confirmée." };
  }
  if (m.delivery_outcome !== "delivered") {
    return { ...base, status: "needs_delivery", message: "Livraison non enregistrée." };
  }
  if (paid + fee !== m.total) {
    return { ...base, status: "mismatch", message: `Écart : attendu ${m.total} MAD, reçu ${paid + fee} MAD (net + frais).` };
  }
  return { ...base, status: "matched", message: null };
}

const mappingSchema = z.object({
  trackingColumn: z.number().int().min(0).max(100),
  amountColumn: z.number().int().min(0).max(100),
  feeColumn: z.number().int().min(0).max(100).nullable(),
});

/** Parses a courier statement and matches rows. Read-only. */
export function previewStatement(csv: string, mappingInput?: unknown): StatementPreview {
  let parsed;
  try {
    parsed = parseCsv(csv);
  } catch (error) {
    throw new RemittanceError(400, error instanceof CsvError ? error.message : "CSV illisible.");
  }
  if (parsed.rows.length < 2) throw new RemittanceError(400, "Le fichier doit contenir un en-tête et au moins une ligne.");
  const headers = parsed.rows[0].map((h) => h.trim());
  let mapping = guessMapping(headers);
  if (mappingInput !== undefined && mappingInput !== null) {
    const m = mappingSchema.safeParse(mappingInput);
    if (!m.success) throw new RemittanceError(400, "Colonnes invalides.");
    mapping = m.data;
  }
  if (mapping.trackingColumn >= headers.length || mapping.amountColumn >= headers.length ||
      (mapping.feeColumn !== null && mapping.feeColumn >= headers.length)) {
    throw new RemittanceError(400, "Colonnes invalides.");
  }
  const seen = new Set<string>();
  const rows: PreviewRow[] = [];
  parsed.rows.slice(1).forEach((cells, i) => {
    const rowNumber = i + 2;
    const tracking = (cells[mapping.trackingColumn] ?? "").trim();
    const amount = parseMadAmount(cells[mapping.amountColumn] ?? "");
    const feeRaw = mapping.feeColumn === null ? "" : (cells[mapping.feeColumn] ?? "").trim();
    const fee = feeRaw === "" ? ({ ok: true, amount: 0 } as const) : parseMadAmount(feeRaw);
    const invalid = (message: string): PreviewRow => ({
      rowNumber, trackingNumber: tracking, paidAmount: null, feeAmount: 0,
      status: "invalid", orderId: null, expectedAmount: null, message,
    });
    if (!tracking) return void rows.push(invalid("Numéro de suivi manquant."));
    if (tracking.length > 120) return void rows.push(invalid("Numéro de suivi trop long."));
    if (!amount.ok) return void rows.push(invalid(amount.reason));
    if (!fee.ok) return void rows.push(invalid(`Frais : ${fee.reason}`));
    const key = tracking.toUpperCase();
    if (seen.has(key)) {
      return void rows.push({
        rowNumber, trackingNumber: tracking, paidAmount: amount.amount, feeAmount: fee.amount,
        status: "duplicate", orderId: null, expectedAmount: null, message: "Doublon dans le fichier.",
      });
    }
    seen.add(key);
    rows.push({
      rowNumber, trackingNumber: tracking, paidAmount: amount.amount, feeAmount: fee.amount,
      ...classify(matchTracking(tracking), amount.amount, fee.amount),
    });
  });
  return { delimiter: parsed.delimiter, headers, mapping, rows };
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date invalide.").refine((d) => {
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().startsWith(d);
}, "Date invalide.");

const intMad = z.number().int("Montant entier requis.").min(0, "Montant positif requis.").max(100_000_000);

const metaShape = {
  reference: z.string().trim().min(1, "Référence requise.").max(120, "Référence trop longue."),
  receivedOn: dateSchema,
  declaredTotal: intMad.nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
};

const statementRowSchema = z.object({
  trackingNumber: z.string().trim().min(1).max(120),
  paidAmount: intMad,
  feeAmount: intMad.default(0),
  acceptMismatch: z.boolean().optional(),
  markDelivered: z.boolean().optional(),
});

export const commitInputSchema = z.union([
  z.object({
    ...metaShape,
    rows: z.array(statementRowSchema).min(1, "Aucune ligne sélectionnée.").max(REMITTANCE_MAX_LINES),
  }),
  z.object({
    ...metaShape,
    orderIds: z.array(z.string().min(1).max(64)).min(1, "Aucune commande sélectionnée.").max(REMITTANCE_MAX_LINES),
  }),
]);

export interface SkippedLine {
  key: string;
  reason: string;
  status?: PreviewStatus;
}

export interface RemittanceSummary {
  id: string;
  reference: string;
  receivedOn: string;
  declaredTotal: number | null;
  feesTotal: number;
  paidTotal: number;
  lineCount: number;
  mismatchCount: number;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  canUndo: boolean;
}

export interface RemittanceLine {
  orderId: string;
  trackingNumber: string | null;
  customerName: string;
  expectedAmount: number;
  paidAmount: number;
  feeAmount: number;
  mismatch: boolean;
}

export interface CommitResult {
  remittance: RemittanceSummary | null;
  applied: number;
  skipped: SkippedLine[];
}

interface Candidate {
  key: string;
  tracking: string | null;
  orderId: string | null;
  paid: number | null;
  fee: number;
  acceptMismatch: boolean;
  markDelivered: boolean;
  /** Reason the eligibility pre-step rejected this row (reported by the transaction). */
  preReason?: string;
}

interface EligibilityOrder {
  id: string;
  total: number;
  cod_status: string;
  confirmation_status: string;
  delivery_outcome: string | null;
}

/**
 * Single source of truth for row eligibility, used by both the pre-transaction
 * "mark delivered" step (assumeDelivered = true) and the commit transaction, so
 * the two can never drift. Pure: returns a rejection reason or null.
 */
function rowRejection(
  c: Pick<Candidate, "paid" | "fee" | "acceptMismatch"> & { tracking?: string | null },
  order: EligibilityOrder | undefined,
  state: { taken: boolean; remitted: boolean },
  assumeDelivered: boolean,
): string | null {
  if (!order) return c.tracking ? "Colis inconnu dans cette boutique (autre boutique du même compte ?) — ignoré." : "Commande introuvable.";
  if (state.taken) return "Doublon.";
  if (state.remitted || order.cod_status === "paid") return "Déjà encaissée.";
  const delivered = assumeDelivered ? order.delivery_outcome === null : order.delivery_outcome === "delivered";
  if (order.confirmation_status !== "confirmed" || !delivered) return "Commande non livrée.";
  const paid = c.paid ?? order.total;
  if (paid + c.fee !== order.total && !c.acceptMismatch) return `Écart de montant (attendu ${order.total} MAD).`;
  return null;
}

/**
 * Admin-confirmed remittance. The server re-matches every row (the client's
 * preview is never trusted), skips orders already remitted (unique index +
 * explicit check, so re-imports are idempotent), refuses mismatches unless
 * explicitly accepted, and writes everything in one immediate transaction.
 */
export function commitRemittance(input: unknown, actorId: string | null): CommitResult {
  const parsed = commitInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new RemittanceError(400, parsed.error.issues[0]?.message ?? "Données invalides.");
  }
  const data = parsed.data;
  const db = getDb();
  const candidates: Candidate[] =
    "rows" in data
      ? data.rows.map((r) => ({
          key: r.trackingNumber, tracking: r.trackingNumber, orderId: null, paid: r.paidAmount,
          fee: r.feeAmount, acceptMismatch: r.acceptMismatch === true, markDelivered: r.markDelivered === true,
        }))
      : data.orderIds.map((id) => ({
          key: id, tracking: null, orderId: id, paid: null, fee: 0, acceptMismatch: false, markDelivered: false,
        }));

  const skipped: SkippedLine[] = [];

  // Optional "livré et payé": delivery outcome has its own transaction, so it runs per order first.
  const actor = actorId ? ({ id: actorId, role: "admin" } as const) : null;
  const preTaken = new Set<string>();
  for (const c of candidates) {
    if (!c.markDelivered || !c.tracking || !actor) continue;
    const m = matchTracking(c.tracking);
    if (!m || m.delivery_outcome) continue; // transaction reports/validates these
    const reason = rowRejection(
      c,
      { id: m.order_id, total: m.total, cod_status: m.cod_status, confirmation_status: m.confirmation_status, delivery_outcome: m.delivery_outcome },
      { taken: preTaken.has(m.order_id), remitted: !!m.remitted },
      true,
    );
    if (reason) { c.preReason = reason; continue; }
    try {
      setDeliveryOutcome(m.order_id, "delivered", actor, "agent");
      preTaken.add(m.order_id);
    } catch (error) {
      skipped.push({ key: c.key, reason: error instanceof Error ? error.message : "Livraison impossible." });
      c.markDelivered = false;
      c.tracking = null;
      c.orderId = null;
    }
  }

  const now = new Date();
  const result = db
    .transaction((): CommitResult => {
      const applied: Array<{ orderId: string; tracking: string | null; expected: number; paid: number; fee: number }> = [];
      const takenOrders = new Set<string>();
      for (const c of candidates) {
        if (!c.tracking && !c.orderId) continue; // already reported as skipped
        let order: { id: string; total: number; cod_status: string; confirmation_status: string; delivery_outcome: string | null; tracking: string | null } | undefined;
        if (c.tracking) {
          const m = matchTracking(c.tracking);
          order = m && {
            id: m.order_id, total: m.total, cod_status: m.cod_status,
            confirmation_status: m.confirmation_status, delivery_outcome: m.delivery_outcome, tracking: m.tracking_number,
          };
        } else {
          order = db
            .prepare(
              `SELECT o.id, o.total, o.cod_status, o.confirmation_status, o.delivery_outcome,
                      (SELECT tracking_number FROM courier_submissions cs WHERE cs.order_id = o.id AND cs.status = 'submitted'
                       ORDER BY cs.created_at DESC LIMIT 1) AS tracking
               FROM orders o WHERE o.id = ?`,
            )
            .get(c.orderId) as typeof order;
        }
        const reason = rowRejection(
          c,
          order,
          {
            taken: !!order && takenOrders.has(order.id),
            remitted: !!order && !!db.prepare("SELECT 1 FROM cod_remittance_lines WHERE order_id = ?").get(order.id),
          },
          false,
        );
        if (reason || !order) {
          const isForeign = !order && !!c.tracking;
          skipped.push({
            key: c.key,
            reason: c.preReason ?? reason ?? (isForeign ? "Colis inconnu dans cette boutique (autre boutique du même compte ?) — ignoré." : "Commande introuvable."),
            ...(isForeign ? { status: "foreign" as const } : {}),
          });
          continue;
        }
        const paid = c.paid ?? order.total;
        takenOrders.add(order.id);
        applied.push({ orderId: order.id, tracking: order.tracking, expected: order.total, paid, fee: c.fee });
      }
      if (applied.length === 0) return { remittance: null, applied: 0, skipped };

      const id = `rem_${nanoid(16)}`;
      const createdAt = now.toISOString();
      const feesTotal = applied.reduce((s, l) => s + l.fee, 0);
      db.prepare(
        `INSERT INTO cod_remittances (id, reference, received_on, declared_total, fees_total, note, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, data.reference, data.receivedOn, data.declaredTotal ?? null, feesTotal, data.note || null, actorId, createdAt);
      const insertLine = db.prepare(
        `INSERT INTO cod_remittance_lines (remittance_id, order_id, tracking_number, expected_amount, paid_amount, fee_amount)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const markPaid = db.prepare(
        `UPDATE orders SET cod_status = 'paid', cod_paid_at = ?, updated_at = ? WHERE id = ?`,
      );
      for (const l of applied) {
        insertLine.run(id, l.orderId, l.tracking, l.expected, l.paid, l.fee);
        markPaid.run(createdAt, createdAt, l.orderId);
      }
      return { remittance: getRemittanceSummary(id, now), applied: applied.length, skipped };
    })
    .immediate();
  return result;
}

interface SummaryRow {
  id: string;
  reference: string;
  received_on: string;
  declared_total: number | null;
  fees_total: number;
  note: string | null;
  created_by: string | null;
  created_at: string;
  paid_total: number;
  line_count: number;
  mismatch_count: number;
}

const SUMMARY_SQL = `SELECT r.*,
    COALESCE((SELECT SUM(paid_amount) FROM cod_remittance_lines l WHERE l.remittance_id = r.id), 0) AS paid_total,
    (SELECT COUNT(*) FROM cod_remittance_lines l WHERE l.remittance_id = r.id) AS line_count,
    (SELECT COUNT(*) FROM cod_remittance_lines l WHERE l.remittance_id = r.id
       AND l.paid_amount + l.fee_amount <> l.expected_amount) AS mismatch_count
  FROM cod_remittances r`;

function toSummary(r: SummaryRow, now: Date): RemittanceSummary {
  return {
    id: r.id, reference: r.reference, receivedOn: r.received_on, declaredTotal: r.declared_total,
    feesTotal: r.fees_total, paidTotal: r.paid_total, lineCount: r.line_count,
    mismatchCount: r.mismatch_count, note: r.note, createdBy: r.created_by, createdAt: r.created_at,
    canUndo: now.getTime() - new Date(r.created_at).getTime() < REMITTANCE_UNDO_WINDOW_MS,
  };
}

function getRemittanceSummary(id: string, now = new Date()): RemittanceSummary {
  const row = getDb().prepare(`${SUMMARY_SQL} WHERE r.id = ?`).get(id) as SummaryRow;
  return toSummary(row, now);
}

export function listRemittances(limit = 100, now = new Date()): RemittanceSummary[] {
  const rows = getDb()
    .prepare(`${SUMMARY_SQL} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`)
    .all(Math.min(Math.max(limit, 1), 500)) as SummaryRow[];
  return rows.map((r) => toSummary(r, now));
}

export function getRemittance(id: string, now = new Date()): { remittance: RemittanceSummary; lines: RemittanceLine[] } {
  const row = getDb().prepare(`${SUMMARY_SQL} WHERE r.id = ?`).get(id) as SummaryRow | undefined;
  if (!row) throw new RemittanceError(404, "Encaissement introuvable.");
  const lines = getDb()
    .prepare(
      `SELECT l.order_id, l.tracking_number, l.expected_amount, l.paid_amount, l.fee_amount, o.customer_name
       FROM cod_remittance_lines l JOIN orders o ON o.id = l.order_id
       WHERE l.remittance_id = ? ORDER BY l.order_id`,
    )
    .all(id) as Array<{ order_id: string; tracking_number: string | null; expected_amount: number; paid_amount: number; fee_amount: number; customer_name: string }>;
  return {
    remittance: toSummary(row, now),
    lines: lines.map((l) => ({
      orderId: l.order_id, trackingNumber: l.tracking_number, customerName: l.customer_name,
      expectedAmount: l.expected_amount, paidAmount: l.paid_amount, feeAmount: l.fee_amount,
      mismatch: l.paid_amount + l.fee_amount !== l.expected_amount,
    })),
  };
}

/** Reverts orders to awaiting_payment; only within 24 h of creation. */
export function deleteRemittance(id: string, now = new Date()): { reverted: number } {
  const db = getDb();
  return db
    .transaction(() => {
      const row = db.prepare("SELECT created_at FROM cod_remittances WHERE id = ?").get(id) as { created_at: string } | undefined;
      if (!row) throw new RemittanceError(404, "Encaissement introuvable.");
      if (now.getTime() - new Date(row.created_at).getTime() >= REMITTANCE_UNDO_WINDOW_MS) {
        throw new RemittanceError(409, "Annulation impossible : l'encaissement date de plus de 24 h.");
      }
      const ts = now.toISOString();
      const res = db
        .prepare(
          `UPDATE orders SET cod_status = 'awaiting_payment', cod_paid_at = NULL, updated_at = ?
           WHERE id IN (SELECT order_id FROM cod_remittance_lines WHERE remittance_id = ?)`,
        )
        .run(ts, id);
      db.prepare("DELETE FROM cod_remittance_lines WHERE remittance_id = ?").run(id);
      db.prepare("DELETE FROM cod_remittances WHERE id = ?").run(id);
      return { reverted: res.changes };
    })
    .immediate();
}

export const AGING_BUCKETS = ["0–7 j", "8–15 j", "16–30 j", "> 30 j"] as const;

export interface AgingOrder {
  orderId: string;
  customerName: string;
  trackingNumber: string | null;
  total: number;
  deliveredAt: string;
  ageDays: number;
}

export interface AgingBucket {
  label: (typeof AGING_BUCKETS)[number];
  count: number;
  total: number;
  orders: AgingOrder[];
}

const AGING_ORDER_CAP = 200;

/** Delivered orders still awaiting_payment, grouped by days since delivery_outcome_at. */
export function getUnpaidAging(now = new Date()): AgingBucket[] {
  const rows = getDb()
    .prepare(
      `SELECT o.id, o.customer_name, o.total, o.delivery_outcome_at,
              (SELECT tracking_number FROM courier_submissions cs WHERE cs.order_id = o.id AND cs.status = 'submitted'
               ORDER BY cs.created_at DESC LIMIT 1) AS tracking
       FROM orders o
       WHERE o.delivery_outcome = 'delivered' AND o.cod_status = 'awaiting_payment'
         AND o.delivery_outcome_at IS NOT NULL
       ORDER BY o.delivery_outcome_at ASC`,
    )
    .all() as Array<{ id: string; customer_name: string; total: number; delivery_outcome_at: string; tracking: string | null }>;
  const buckets: AgingBucket[] = AGING_BUCKETS.map((label) => ({ label, count: 0, total: 0, orders: [] }));
  for (const r of rows) {
    const ageDays = Math.max(0, Math.floor((now.getTime() - new Date(r.delivery_outcome_at).getTime()) / 86_400_000));
    const b = buckets[ageDays <= 7 ? 0 : ageDays <= 15 ? 1 : ageDays <= 30 ? 2 : 3];
    b.count += 1;
    b.total += r.total;
    if (b.orders.length < AGING_ORDER_CAP) {
      b.orders.push({
        orderId: r.id, customerName: r.customer_name, trackingNumber: r.tracking,
        total: r.total, deliveredAt: r.delivery_outcome_at, ageDays,
      });
    }
  }
  return buckets;
}
