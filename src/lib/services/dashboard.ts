import { getDb } from "@/lib/db";
import { deliveryProviderName } from "@/lib/env";
import {
  NEXT_CALLBACK_SQL,
  endOfTodayCasablancaIso,
  formatCasablanca,
} from "@/lib/services/orders";
import { lowStock, type LowStockRow } from "@/lib/services/inventory";
import { getTrackingHealth } from "@/lib/services/tracking";
import { redactText } from "@/lib/shipping/redact";

// Aggregated read-only counts for the /crm dashboard (task-17).
// One SQL statement per card (window counts, no per-row hydration loops) and
// NO financial columns anywhere — counts and operational rows only.

const ROW_LIMIT = 5;
const ERROR_PREVIEW_MAX = 140;

// Normalized tracking statuses that mean "the parcel is moving toward delivery".
const TRANSIT_STATUSES_SQL = "('in_transit','out_for_delivery','at_facility')";

// Same computed next-callback expression as the orders list — the card count
// must equal what /crm/orders?callbackDue=1 shows.
export const DASHBOARD_CALLBACK_DUE_SQL = `${NEXT_CALLBACK_SQL} <= ?`;

export interface DashboardOrderRow {
  orderId: string;
  customerName: string;
  customerPhone: string;
  cityName: string | null;
  createdAt: string;
  nextCallbackAt: string | null;
}

export interface DashboardSubmissionRow {
  submissionId: string;
  orderId: string;
  customerName: string;
  status: string;
  lastError: string | null;
  updatedAt: string;
}

export interface DashboardParcelRow {
  submissionId: string;
  orderId: string;
  customerName: string;
  cityName: string | null;
  trackingNumber: string | null;
  blRef: string | null;
  updatedAt: string;
}

export interface DashboardTransitRow {
  submissionId: string;
  orderId: string;
  customerName: string;
  trackingNumber: string | null;
  normalizedStatus: string;
  rawStatus: string | null;
  updatedAt: string;
}

export interface DashboardReturnRow {
  id: string;
  orderId: string;
  customerName: string;
  trackingNumber: string | null;
  status: string;
  reason: string | null;
  createdAt: string;
}

export interface DashboardList<T> {
  count: number;
  rows: T[];
}

export interface DashboardInTransit {
  count: number;
  unknownCount: number;
  rows: DashboardTransitRow[];
  unknownRows: DashboardTransitRow[];
}

export interface DashboardReturns {
  returningCount: number;
  receivedCount: number;
  rows: DashboardReturnRow[];
}

export interface DashboardSyncHealth {
  lastSuccessfulSync: string | null;
  lastSyncLabel: string | null;
  lastSyncAbsolute: string | null;
  failing: boolean;
  /** Submitted parcels not tracked successfully within the staleness window. */
  staleParcels: number;
  citiesLastSync: string | null;
  citiesLastSyncLabel: string | null;
  citiesLastSyncAbsolute: string | null;
}

export interface DashboardData {
  generatedAt: string;
  newOrders: DashboardList<DashboardOrderRow>;
  callbacksDue: DashboardList<DashboardOrderRow>;
  pendingSubmissions: DashboardList<DashboardSubmissionRow>;
  failedSubmissions: DashboardList<DashboardSubmissionRow>;
  readyBl: DashboardList<DashboardParcelRow>;
  awaitingHandoff: DashboardList<DashboardParcelRow>;
  inTransit: DashboardInTransit;
  returns: DashboardReturns;
  lowStockItems: DashboardList<LowStockRow>;
  syncHealth: DashboardSyncHealth;
  deliveryIssuesCount: number;
}

interface OrderCountRow {
  id: string;
  customer_name: string;
  customer_phone: string;
  city_name: string | null;
  created_at: string;
  next_callback_at: string | null;
  total_count: number;
}

interface SubmissionCountRow {
  id: string;
  order_id: string;
  customer_name: string;
  status: string;
  last_error: string | null;
  updated_at: string;
  total_count: number;
}

interface ParcelCountRow {
  submission_id: string;
  tracking_number: string | null;
  order_id: string;
  customer_name: string;
  city_name: string | null;
  bl_ref: string | null;
  updated_at: string;
  total_count: number;
}

interface TransitCountRow {
  id: string;
  order_id: string;
  customer_name: string;
  tracking_number: string | null;
  normalized_status: string;
  raw_status: string | null;
  updated_at: string;
  transit_count: number;
  unknown_count: number;
}

interface ReturnCountRow {
  id: string;
  order_id: string;
  customer_name: string;
  tracking_number: string | null;
  status: string;
  reason: string | null;
  created_at: string;
  returning_count: number;
  received_count: number;
}

interface WithTotalCount {
  total_count: number;
}

function listFromRows<TRow extends WithTotalCount, TOut>(
  rows: TRow[],
  map: (row: TRow) => TOut,
): DashboardList<TOut> {
  if (rows.length === 0) return { count: 0, rows: [] };
  return {
    count: Number(rows[0].total_count),
    rows: rows.map(map),
  };
}

function errorPreview(raw: string | null): string | null {
  if (!raw) return null;
  // Errors are redacted at write time; scrub again defensively before display.
  return redactText(raw.length > ERROR_PREVIEW_MAX ? `${raw.slice(0, ERROR_PREVIEW_MAX)}…` : raw);
}

function relativeLabel(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  const minutes = Math.max(0, Math.floor((now.getTime() - parsed) / 60_000));
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return `il y a ${Math.floor(hours / 24)} j`;
}

// --- Card queries (one SQL each: windowed totals + latest rows).

function newOrders(): DashboardList<DashboardOrderRow> {
  const rows = getDb()
    .prepare(
      `SELECT o.id, o.customer_name, o.customer_phone, o.city_name, o.created_at,
              COUNT(*) OVER () AS total_count
       FROM orders o
       WHERE o.confirmation_status = 'new' AND o.archived_at IS NULL
       ORDER BY o.created_at ASC, o.id ASC
       LIMIT ${ROW_LIMIT}`,
    )
    .all() as OrderCountRow[];
  return listFromRows(rows, (row) => ({
    orderId: row.id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    cityName: row.city_name,
    createdAt: row.created_at,
    nextCallbackAt: null,
  }));
}

function callbacksDue(now: Date): DashboardList<DashboardOrderRow> {
  const rows = getDb()
    .prepare(
      `SELECT o.id, o.customer_name, o.customer_phone, o.city_name, o.created_at,
              ${NEXT_CALLBACK_SQL} AS next_callback_at,
              COUNT(*) OVER () AS total_count
       FROM orders o
       WHERE ${DASHBOARD_CALLBACK_DUE_SQL} AND o.archived_at IS NULL
       ORDER BY next_callback_at ASC, o.created_at ASC
       LIMIT ${ROW_LIMIT}`,
    )
    .all(endOfTodayCasablancaIso(now)) as OrderCountRow[];
  return listFromRows(rows, (row) => ({
    orderId: row.id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    cityName: row.city_name,
    createdAt: row.created_at,
    nextCallbackAt: row.next_callback_at,
  }));
}

function pendingSubmissions(): DashboardList<DashboardSubmissionRow> {
  const rows = getDb()
    .prepare(
      `SELECT cs.id, cs.order_id, o.customer_name, cs.status, NULL AS last_error,
              cs.updated_at, COUNT(*) OVER () AS total_count
       FROM courier_submissions cs
       JOIN orders o ON o.id = cs.order_id
        WHERE cs.status IN ('queued','submitting') AND o.confirmation_status != 'cancelled'
       ORDER BY cs.created_at ASC, cs.id ASC
       LIMIT ${ROW_LIMIT}`,
    )
    .all() as SubmissionCountRow[];
  return listFromRows(rows, (row) => ({
    submissionId: row.id,
    orderId: row.order_id,
    customerName: row.customer_name,
    status: row.status,
    lastError: null,
    updatedAt: row.updated_at,
  }));
}

function failedSubmissions(): DashboardList<DashboardSubmissionRow> {
  const rows = getDb()
    .prepare(
      `SELECT cs.id, cs.order_id, o.customer_name, cs.status, cs.last_error,
              cs.updated_at, COUNT(*) OVER () AS total_count
       FROM courier_submissions cs
       JOIN orders o ON o.id = cs.order_id
        WHERE cs.status IN ('failed','needs_review') AND o.confirmation_status != 'cancelled'
       ORDER BY cs.updated_at DESC, cs.id DESC
       LIMIT ${ROW_LIMIT}`,
    )
    .all() as SubmissionCountRow[];
  return listFromRows(rows, (row) => ({
    submissionId: row.id,
    orderId: row.order_id,
    customerName: row.customer_name,
    status: row.status,
    lastError: errorPreview(row.last_error),
    updatedAt: row.updated_at,
  }));
}

// Mirrors expeditions.ts readyParcels(): submitted + tracking + confirmed, in
// no BL at all yet — plus parcels parked on a draft BL (board's draft section).
function readyBl(): DashboardList<DashboardParcelRow> {
  const rows = getDb()
    .prepare(
      `SELECT cs.id AS submission_id, cs.tracking_number, o.id AS order_id,
              o.customer_name, o.city_name, cs.updated_at,
              (SELECT dn.ref FROM delivery_note_parcels dnp
               JOIN delivery_notes dn ON dn.id = dnp.delivery_note_id
               WHERE dnp.submission_id = cs.id AND dn.status = 'draft'
               LIMIT 1) AS bl_ref,
              COUNT(*) OVER () AS total_count
       FROM courier_submissions cs
       JOIN orders o ON o.id = cs.order_id
       WHERE cs.status = 'submitted'
         AND cs.tracking_number IS NOT NULL
         AND o.confirmation_status = 'confirmed'
         AND NOT EXISTS (
           SELECT 1 FROM delivery_note_parcels dnp
           JOIN delivery_notes dn ON dn.id = dnp.delivery_note_id
           WHERE dnp.submission_id = cs.id AND dn.status = 'saved'
         )
       ORDER BY cs.updated_at ASC, cs.id ASC
       LIMIT ${ROW_LIMIT}`,
    )
    .all() as ParcelCountRow[];
  return listFromRows(rows, (row) => ({
    submissionId: row.submission_id,
    orderId: row.order_id,
    customerName: row.customer_name,
    cityName: row.city_name,
    trackingNumber: row.tracking_number,
    blRef: row.bl_ref,
    updatedAt: row.updated_at,
  }));
}

// Parcels parked on a saved BL with no handoff movement yet (board's saved
// section minus handed-off parcels).
function awaitingHandoff(): DashboardList<DashboardParcelRow> {
  const rows = getDb()
    .prepare(
      `SELECT cs.id AS submission_id, cs.tracking_number, o.id AS order_id,
              o.customer_name, o.city_name, cs.updated_at, dn.ref AS bl_ref,
              COUNT(*) OVER () AS total_count
       FROM delivery_note_parcels dnp
       JOIN delivery_notes dn ON dn.id = dnp.delivery_note_id
       JOIN courier_submissions cs ON cs.id = dnp.submission_id
       JOIN orders o ON o.id = cs.order_id
       WHERE dn.status = 'saved'
         AND NOT EXISTS (
           SELECT 1 FROM stock_movements m
           WHERE m.order_id = o.id AND (m.kind = 'dispatch' OR m.ref LIKE 'disp%')
         )
       ORDER BY dnp.added_at ASC, cs.id ASC
       LIMIT ${ROW_LIMIT}`,
    )
    .all() as ParcelCountRow[];
  return listFromRows(rows, (row) => ({
    submissionId: row.submission_id,
    orderId: row.order_id,
    customerName: row.customer_name,
    cityName: row.city_name,
    trackingNumber: row.tracking_number,
    blRef: row.bl_ref,
    updatedAt: row.updated_at,
  }));
}

function inTransit(): DashboardInTransit {
  const db = getDb();
  const counts = db
    .prepare(
      `SELECT
         COUNT(CASE WHEN normalized_status IN ${TRANSIT_STATUSES_SQL} THEN 1 END) AS transit_count,
         COUNT(CASE WHEN normalized_status = 'unknown' THEN 1 END) AS unknown_count
       FROM courier_submissions
       WHERE status = 'submitted'`,
    )
    .get() as { transit_count: number; unknown_count: number };
  const select = (condition: string): DashboardTransitRow[] =>
    (
      db
        .prepare(
          `SELECT cs.id, cs.order_id, o.customer_name, cs.tracking_number,
                  cs.normalized_status, cs.raw_status, cs.updated_at
           FROM courier_submissions cs
           JOIN orders o ON o.id = cs.order_id
           WHERE cs.status = 'submitted' AND ${condition}
           ORDER BY cs.updated_at DESC, cs.id DESC
           LIMIT ${ROW_LIMIT}`,
        )
        .all() as Omit<TransitCountRow, "transit_count" | "unknown_count">[]
    ).map((row) => ({
      submissionId: row.id,
      orderId: row.order_id,
      customerName: row.customer_name,
      trackingNumber: row.tracking_number,
      normalizedStatus: row.normalized_status,
      rawStatus: row.raw_status,
      updatedAt: row.updated_at,
    }));
  const transit = Number(counts.transit_count);
  const unknown = Number(counts.unknown_count);
  return {
    count: transit,
    unknownCount: unknown,
    rows: transit > 0 ? select(`cs.normalized_status IN ${TRANSIT_STATUSES_SQL}`) : [],
    unknownRows: unknown > 0 ? select("cs.normalized_status = 'unknown'") : [],
  };
}

// Active returns only (returning / received): inspected history lives on the
// Retours page. Counts are aggregated in SQL; row loading is bounded.
function returnsCard(): DashboardReturns {
  const db = getDb();
  const counts = db
    .prepare(
      `SELECT
         COUNT(CASE WHEN status = 'returning' THEN 1 END) AS returning_count,
         COUNT(CASE WHEN status = 'received' THEN 1 END) AS received_count
       FROM returns`,
    )
    .get() as { returning_count: number; received_count: number };
  const rows = db
    .prepare(
      `SELECT r.id, cs.order_id, o.customer_name, cs.tracking_number,
              r.status, r.reason, r.created_at
       FROM returns r
       JOIN courier_submissions cs ON cs.id = r.submission_id
       JOIN orders o ON o.id = cs.order_id
       WHERE r.status IN ('returning', 'received')
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT ${ROW_LIMIT}`,
    )
    .all() as Omit<ReturnCountRow, "returning_count" | "received_count">[];
  return {
    returningCount: Number(counts.returning_count),
    receivedCount: Number(counts.received_count),
    rows: rows.map((row) => ({
      id: row.id,
      orderId: row.order_id,
      customerName: row.customer_name,
      trackingNumber: row.tracking_number,
      status: row.status,
      reason: row.reason,
      createdAt: row.created_at,
    })),
  };
}

function lowStockCard(): DashboardList<LowStockRow> {
  const rows = [...lowStock(3)].sort((a, b) => a.available - b.available);
  return { count: rows.length, rows: rows.slice(0, ROW_LIMIT) };
}

function syncHealth(now: Date): DashboardSyncHealth {
  const health = getTrackingHealth(now);
  const citiesRow = getDb()
    .prepare("SELECT MAX(updated_at) AS at FROM cities WHERE provider = ?")
    .get(deliveryProviderName()) as { at: string | null } | undefined;
  const at = citiesRow?.at ?? null;
  return {
    lastSuccessfulSync: health.lastSuccessfulSync,
    lastSyncLabel: relativeLabel(health.lastSuccessfulSync, now),
    lastSyncAbsolute: health.lastSuccessfulSync
      ? formatCasablanca(health.lastSuccessfulSync)
      : null,
    failing: health.failing,
    staleParcels: health.staleParcels,
    citiesLastSync: at,
    citiesLastSyncLabel: relativeLabel(at, now),
    citiesLastSyncAbsolute: at ? formatCasablanca(at) : null,
  };
}

export function countDeliveryIssues(): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c
       FROM courier_submissions
       WHERE status = 'submitted' AND normalized_status = 'delivery_issue'`,
    )
    .get() as { c: number } | undefined;
  return row ? Number(row.c) : 0;
}

export function getDashboard(now: Date = new Date()): DashboardData {
  return {
    generatedAt: now.toISOString(),
    newOrders: newOrders(),
    callbacksDue: callbacksDue(now),
    pendingSubmissions: pendingSubmissions(),
    failedSubmissions: failedSubmissions(),
    readyBl: readyBl(),
    awaitingHandoff: awaitingHandoff(),
    inTransit: inTransit(),
    returns: returnsCard(),
    lowStockItems: lowStockCard(),
    syncHealth: syncHealth(now),
    deliveryIssuesCount: countDeliveryIssues(),
  };
}
