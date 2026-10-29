import { getDb } from "@/lib/db";
import type { CommerceOrderItem as OrderItem } from "@/lib/commerce-types";
import { formatCasablanca, summarizeItems } from "@/lib/services/orders";
import {
  dispatchOrder,
  InventoryConflictError,
} from "@/lib/services/inventory";
import { courierProfile } from "@/lib/env";
import { COURIERS } from "@/lib/shipping/couriers";
import { getProvider } from "@/lib/shipping";
import { redactText } from "@/lib/shipping/redact";
export { BlError, createOrResumeBl, blPdfLinks } from "@/lib/services/delivery-notes";

function requiresSavedBl(): boolean {
  try {
    return getProvider().capabilities.deliveryNotes;
  } catch {
    return COURIERS[courierProfile()].capabilities.deliveryNotes;
  }
}

// --- Board view model (serializable — flows into the client component).

export interface BoardParcel {
  submissionId: string;
  orderId: string;
  customerName: string;
  cityName: string | null;
  total: number;
  itemsSummary: string;
  trackingNumber: string;
}

// Dates are formatted server-side (formatCasablanca) so the client component
// renders plain strings — Intl offsets differ between Node ICU and browsers,
// which would cause hydration mismatches.
export interface BoardNote {
  id: string;
  ref: string;
  createdAtLabel: string;
  savedAtLabel: string | null;
  parcels: BoardParcel[];
}

export interface BoardDispatchedOrder {
  orderId: string;
  customerName: string;
  cityName: string | null;
  total: number;
  actor: string;
  dispatchedAtLabel: string;
}

export interface ShipmentBoard {
  ready: BoardParcel[];
  operations: BoardBlOperation[];
  savedNotes: BoardNote[];
  dispatched: BoardDispatchedOrder[];
}

export interface BoardBlOperation {
  id: string;
  ref: string | null;
  stage: "create" | "attach" | "save";
  status: "ready" | "running" | "needs_review";
  revision: number;
  canResolve: boolean;
  lastError: string | null;
  createdAtLabel: string;
  parcels: (BoardParcel & { attached: boolean })[];
  resolutions: { stage: string; outcome: string; evidence: string; actor: string; atLabel: string }[];
}

// Orders already handed off (disp:* = agent handoff, disp-recovered:* =
// tracking-poller catch-up) — used by the board and the handoff guards.
// Unqualified on purpose: `kind`/`ref` only exist on stock_movements in every
// query that embeds this fragment.
const DISPATCH_GUARD_SQL =
  "(kind = 'dispatch' OR ref LIKE 'disp%')";

const READY_LIMIT = 200;
const NOTES_LIMIT = 100;
const DISPATCHED_WINDOW_DAYS = 14;
const DISPATCHED_LIMIT = 100;

interface ParcelSourceRow {
  submission_id: string;
  tracking_number: string | null;
  order_id: string;
  customer_name: string;
  city_name: string | null;
  total: number;
  items_json: string | null;
  upsell_status: string | null;
  upsell_items_json: string | null;
}

function itemsSummaryOf(row: {
  items_json: string | null;
  upsell_status: string | null;
  upsell_items_json: string | null;
}): string {
  const parse = (json: string | null): OrderItem[] => {
    if (!json) return [];
    try {
      const parsed: unknown = JSON.parse(json);
      return Array.isArray(parsed) ? (parsed as OrderItem[]) : [];
    } catch {
      return [];
    }
  };
  const items = parse(row.items_json);
  const upsell = row.upsell_status === "accepted" ? parse(row.upsell_items_json) : [];
  return summarizeItems([...items, ...upsell]);
}

function toBoardParcel(row: ParcelSourceRow): BoardParcel {
  return {
    submissionId: row.submission_id,
    orderId: row.order_id,
    customerName: row.customer_name,
    cityName: row.city_name,
    total: row.total,
    itemsSummary: itemsSummaryOf(row),
    trackingNumber: row.tracking_number ?? "",
  };
}

// --- Section 1: submitted parcels, confirmed orders, ready for BL or direct handoff.

function readyParcels(): BoardParcel[] {
  if (!requiresSavedBl()) {
    const rows = getDb()
      .prepare(
        `SELECT cs.id AS submission_id, cs.tracking_number, o.id AS order_id,
                o.customer_name, o.city_name, o.total, o.items_json,
                o.upsell_status, o.upsell_items_json
         FROM courier_submissions cs
         JOIN orders o ON o.id = cs.order_id
         WHERE cs.status = 'submitted'
           AND cs.tracking_number IS NOT NULL
           AND o.confirmation_status = 'confirmed'
           AND NOT EXISTS (
             SELECT 1 FROM stock_movements m WHERE m.order_id = o.id AND ${DISPATCH_GUARD_SQL}
           )
         ORDER BY cs.updated_at ASC, cs.id ASC
         LIMIT ${READY_LIMIT}`,
      )
      .all() as ParcelSourceRow[];
    return rows.map(toBoardParcel);
  }

  const rows = getDb()
    .prepare(
      `SELECT cs.id AS submission_id, cs.tracking_number, o.id AS order_id,
              o.customer_name, o.city_name, o.total, o.items_json,
              o.upsell_status, o.upsell_items_json
       FROM courier_submissions cs
       JOIN orders o ON o.id = cs.order_id
       WHERE cs.status = 'submitted'
         AND cs.tracking_number IS NOT NULL
         AND o.confirmation_status = 'confirmed'
         AND NOT EXISTS (
           SELECT 1 FROM stock_movements m WHERE m.order_id = o.id AND ${DISPATCH_GUARD_SQL}
         )
         AND NOT EXISTS (
           SELECT 1 FROM delivery_note_parcels dnp WHERE dnp.submission_id = cs.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM bl_operation_parcels p WHERE p.submission_id = cs.id
         )
       ORDER BY cs.updated_at ASC, cs.id ASC
       LIMIT ${READY_LIMIT}`,
    )
    .all() as ParcelSourceRow[];
  return rows.map(toBoardParcel);
}

// --- Saved BLs, minus handed-off parcels. Pending work uses durable operations.

interface NoteRow {
  note_id: string;
  ref: string;
  created_at: string;
  saved_at: string | null;
  submission_id: string | null;
  tracking_number: string | null;
  order_id: string | null;
  customer_name: string | null;
  city_name: string | null;
  total: number | null;
  items_json: string | null;
  upsell_status: string | null;
  upsell_items_json: string | null;
  has_dispatch: number;
}

function notesWithStatus(status: "saved"): BoardNote[] {
  const rows = getDb()
    .prepare(
      `SELECT dn.id AS note_id, dn.ref, dn.created_at, dn.saved_at,
              cs.id AS submission_id, cs.tracking_number,
              o.id AS order_id, o.customer_name, o.city_name, o.total,
              o.items_json, o.upsell_status, o.upsell_items_json,
              CASE WHEN EXISTS (
                SELECT 1 FROM stock_movements m
                WHERE m.order_id = o.id AND ${DISPATCH_GUARD_SQL}
              ) THEN 1 ELSE 0 END AS has_dispatch
       FROM (SELECT * FROM delivery_notes WHERE status = ?
             ORDER BY created_at ASC, id ASC LIMIT ${NOTES_LIMIT}) dn
       LEFT JOIN delivery_note_parcels dnp ON dnp.delivery_note_id = dn.id
       LEFT JOIN courier_submissions cs ON cs.id = dnp.submission_id
       LEFT JOIN orders o ON o.id = cs.order_id
       ORDER BY dn.created_at ASC, dn.id ASC, dnp.added_at ASC, cs.id ASC`,
    )
    .all(status) as NoteRow[];

  const byNote = new Map<string, BoardNote>();
  const totalPerNote = new Map<string, number>();
  for (const row of rows) {
    let note = byNote.get(row.note_id);
    if (!note) {
      note = {
        id: row.note_id,
        ref: row.ref,
        createdAtLabel: formatCasablanca(row.created_at),
        savedAtLabel: row.saved_at ? formatCasablanca(row.saved_at) : null,
        parcels: [],
      };
      byNote.set(row.note_id, note);
    }
    if (row.submission_id === null || row.order_id === null) continue;
    totalPerNote.set(row.note_id, (totalPerNote.get(row.note_id) ?? 0) + 1);
    if (row.has_dispatch === 1) continue; // Already handed off — leave this board.
    note.parcels.push(
      toBoardParcel({
        submission_id: row.submission_id,
        tracking_number: row.tracking_number,
        order_id: row.order_id,
        customer_name: row.customer_name ?? "",
        city_name: row.city_name,
        total: row.total ?? 0,
        items_json: row.items_json,
        upsell_status: row.upsell_status,
        upsell_items_json: row.upsell_items_json,
      }),
    );
  }

  // Keep notes with remaining parcels, plus legacy empty notes.
  const notes = [...byNote.values()].filter(
    (note) => note.parcels.length > 0 || (totalPerNote.get(note.id) ?? 0) === 0,
  );
  return notes;
}

// --- Section 4: orders handed off (last 14 days, actor + date).

function dispatchedOrders(now: Date): BoardDispatchedOrder[] {
  const cutoff = new Date(
    now.getTime() - DISPATCHED_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const rows = getDb()
    .prepare(
      `SELECT m.order_id, o.customer_name, o.city_name, o.total,
              m.actor AS actor, MAX(m.created_at) AS dispatched_at
       FROM stock_movements m
       JOIN orders o ON o.id = m.order_id
       WHERE ${DISPATCH_GUARD_SQL} AND m.created_at >= ?
       GROUP BY m.order_id
       ORDER BY dispatched_at DESC
       LIMIT ${DISPATCHED_LIMIT}`,
    )
    .all(cutoff) as Array<{
    order_id: string;
    customer_name: string;
    city_name: string | null;
    total: number;
    actor: string;
    dispatched_at: string;
  }>;
  return rows.map((row) => ({
    orderId: row.order_id,
    customerName: row.customer_name,
    cityName: row.city_name,
    total: row.total,
    actor: row.actor,
    dispatchedAtLabel: formatCasablanca(row.dispatched_at),
  }));
}

export function getShipmentBoard(): ShipmentBoard {
  return {
    ready: readyParcels(),
    operations: pendingBlOperations(),
    savedNotes: notesWithStatus("saved"),
    dispatched: dispatchedOrders(new Date()),
  };
}

function pendingBlOperations(): BoardBlOperation[] {
  const db = getDb();
  const rows = db.prepare(`SELECT op.*, dn.ref FROM bl_operations op
    LEFT JOIN delivery_notes dn ON dn.id = op.delivery_note_id
    WHERE op.status NOT IN ('completed', 'abandoned') ORDER BY op.created_at ASC LIMIT ${NOTES_LIMIT}`).all() as Array<{
      id: string; ref: string | null; observed_ref: string | null;
      stage: BoardBlOperation["stage"]; status: BoardBlOperation["status"];
      revision: number; lease_expires_at: string | null; last_error: string | null; created_at: string;
    }>;
  return rows.map(row => {
    const parcels = db.prepare(`SELECT cs.id AS submission_id, p.tracking_number, p.attached_at,
      o.id AS order_id, o.customer_name, o.city_name, o.total, o.items_json, o.upsell_status, o.upsell_items_json
      FROM bl_operation_parcels p JOIN courier_submissions cs ON cs.id = p.submission_id
      JOIN orders o ON o.id = cs.order_id WHERE p.operation_id = ? ORDER BY p.submission_id`).all(row.id) as (ParcelSourceRow & { attached_at: string | null })[];
    const history = db.prepare(`SELECT e.stage, e.detail, e.created_at, COALESCE(u.name, e.actor) AS actor
      FROM bl_operation_events e LEFT JOIN users u ON u.id = e.actor
      WHERE e.operation_id = ? AND e.kind = 'reconciled' ORDER BY e.rowid DESC LIMIT 5`).all(row.id) as Array<{
        stage: string; detail: string; created_at: string; actor: string;
      }>;
    return {
      id: row.id, ref: row.ref ?? row.observed_ref, stage: row.stage, status: row.status,
      revision: row.revision,
      canResolve: row.status === "needs_review" || (row.status === "running" && !!row.lease_expires_at && row.lease_expires_at <= new Date().toISOString()),
      lastError: row.last_error, createdAtLabel: formatCasablanca(row.created_at),
      parcels: parcels.map(parcel => ({ ...toBoardParcel(parcel), attached: !!parcel.attached_at })),
      resolutions: history.map(entry => {
        const detail = JSON.parse(entry.detail) as { outcome: string; evidence: string };
        return { stage: entry.stage, outcome: detail.outcome, evidence: detail.evidence, actor: entry.actor,
          atLabel: formatCasablanca(entry.created_at) };
      }),
    };
  });
}

// --- Handoff (physical pickup): consumes reservations exactly once.

export class HandoffError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HandoffError";
    this.status = status;
  }
}

export interface HandoffOutcome {
  submissionId: string;
  orderId: string;
  ok: boolean;
  alreadyDispatched: boolean;
  dispatchedAt: string | null;
  error?: string;
}

function hasDispatchMovement(orderId: string): boolean {
  return (
    getDb()
      .prepare(
        `SELECT 1 FROM stock_movements
         WHERE order_id = ? AND ${DISPATCH_GUARD_SQL}
         LIMIT 1`,
      )
      .get(orderId) !== undefined
  );
}

function latestDispatchAt(orderId: string): string | null {
  return (
    (
      getDb()
        .prepare(
          `SELECT MAX(created_at) AS at FROM stock_movements
           WHERE order_id = ? AND ${DISPATCH_GUARD_SQL}`,
        )
        .get(orderId) as { at: string | null }
    ).at ?? null
  );
}

/**
 * Records the handoff for one order through the inventory service — a no-op
 * on replay (order-wide disp guard inside the service), so a double click can
 * never double-debit the stock.
 */
function recordDispatch(orderId: string, actor: string): {
  orderId: string;
  alreadyDispatched: boolean;
  dispatchedAt: string | null;
} {
  const alreadyDispatched = hasDispatchMovement(orderId);
  if (!alreadyDispatched) {
    try {
      dispatchOrder(orderId, actor);
    } catch (err) {
      if (err instanceof InventoryConflictError) {
        throw new HandoffError(409, err.message);
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("aucune réservation active")) {
        throw new HandoffError(
          409,
          "Aucune réservation active pour cette commande — remise au livreur impossible (colis déjà traité ou commande annulée).",
        );
      }
      throw new HandoffError(500, redactText(message));
    }
  }
  return {
    orderId,
    alreadyDispatched,
    dispatchedAt: latestDispatchAt(orderId),
  };
}

export function handoffParcel(parcelId: string, actor: string): HandoffOutcome {
  const row = getDb()
    .prepare(
      `SELECT cs.id AS submission_id, cs.order_id, o.confirmation_status,
              cs.status, cs.tracking_number,
              EXISTS (SELECT 1 FROM delivery_note_parcels p
                JOIN delivery_notes dn ON dn.id = p.delivery_note_id
                JOIN bl_operations op ON op.delivery_note_id = dn.id
                WHERE p.submission_id = cs.id AND dn.status = 'saved' AND op.status = 'completed') AS saved_bl
       FROM courier_submissions cs
       JOIN orders o ON o.id = cs.order_id
       WHERE cs.id = ?`,
    )
    .get(parcelId) as
    | { submission_id: string; order_id: string; confirmation_status: string;
        status: string; tracking_number: string | null; saved_bl: number }
    | undefined;
  if (!row) throw new HandoffError(404, "Colis introuvable.");
  if (row.confirmation_status !== "confirmed") {
    throw new HandoffError(
      409,
      "Commande non confirmée — remise au livreur impossible.",
    );
  }
  if (row.status !== "submitted" || !row.tracking_number || (requiresSavedBl() && !row.saved_bl)) {
    if (requiresSavedBl()) {
      throw new HandoffError(
        409,
        "Colis non transmis ou BL non enregistré — résolvez le BL avant la remise au livreur.",
      );
    }
    throw new HandoffError(
      409,
      "Colis non transmis (pas de numéro de suivi) — remise au livreur impossible.",
    );
  }
  return { submissionId: row.submission_id, ok: true, ...recordDispatch(row.order_id, actor) };
}

export function handoffParcels(
  ids: string[],
  actor: string,
): { results: HandoffOutcome[] } {
  if (requiresSavedBl()) {
    throw new HandoffError(
      409,
      "Remise groupée réservée aux transporteurs sans BL — utilisez la remise par BL.",
    );
  }
  const uniqueIds = Array.from(new Set(ids));
  const results: HandoffOutcome[] = [];
  for (const id of uniqueIds) {
    try {
      results.push(handoffParcel(id, actor));
    } catch (err) {
      const message =
        err instanceof HandoffError
          ? err.message
          : redactText(err instanceof Error ? err.message : String(err));
      const sub = getDb()
        .prepare("SELECT order_id FROM courier_submissions WHERE id = ?")
        .get(id) as { order_id: string } | undefined;
      results.push({
        submissionId: id,
        orderId: sub?.order_id ?? "",
        ok: false,
        alreadyDispatched: false,
        dispatchedAt: null,
        error: message,
      });
    }
  }
  return { results };
}

export function handoffBl(
  blId: string,
  actor: string,
): { results: HandoffOutcome[] } {
  const note = getDb()
    .prepare("SELECT id, ref, status FROM delivery_notes WHERE id = ?")
    .get(blId) as { id: string; ref: string; status: string } | undefined;
  if (!note) throw new HandoffError(404, "BL introuvable.");
  if (note.status !== "saved") {
    throw new HandoffError(
      409,
      "Ce BL n'est pas encore enregistré — enregistrez-le avant la remise au livreur.",
    );
  }
  const op = getDb().prepare("SELECT status FROM bl_operations WHERE delivery_note_id = ?").get(blId) as { status: string } | undefined;
  if (op?.status !== "completed") throw new HandoffError(409, "Opération BL non résolue — remise au livreur impossible.");

  const parcels = getDb()
    .prepare(
      `SELECT dnp.submission_id, cs.order_id, o.confirmation_status, cs.status, cs.tracking_number
       FROM delivery_note_parcels dnp
       JOIN courier_submissions cs ON cs.id = dnp.submission_id
       LEFT JOIN orders o ON o.id = cs.order_id
       WHERE dnp.delivery_note_id = ?
       ORDER BY dnp.added_at ASC, cs.id ASC`,
    )
    .all(blId) as Array<{
    submission_id: string;
    order_id: string | null;
    confirmation_status: string | null;
    status: string;
    tracking_number: string | null;
  }>;

  const results: HandoffOutcome[] = [];
  for (const parcel of parcels) {
    if (!parcel.order_id || parcel.confirmation_status !== "confirmed" || parcel.status !== "submitted" || !parcel.tracking_number) {
      results.push({
        submissionId: parcel.submission_id,
        orderId: parcel.order_id ?? "",
        ok: false,
        alreadyDispatched: false,
        dispatchedAt: null,
        error: "Commande non confirmée, colis non transmis ou numéro de suivi manquant.",
      });
      continue;
    }
    try {
      results.push({
        submissionId: parcel.submission_id,
        ok: true,
        ...recordDispatch(parcel.order_id, actor),
      });
    } catch (err) {
      results.push({
        submissionId: parcel.submission_id,
        orderId: parcel.order_id,
        ok: false,
        alreadyDispatched: false,
        dispatchedAt: null,
        error:
          err instanceof HandoffError
            ? err.message
            : redactText(err instanceof Error ? err.message : String(err)),
      });
    }
  }
  return { results };
}
