import { nanoid } from "nanoid";
import { getDb } from "@/lib/db";
import { deliveryProviderName } from "@/lib/env";
import { getCrmOrder } from "@/lib/services/orders";
import { buildPayloadSnapshot } from "@/lib/shipping/parcel-payload";

export type SubmissionStatus =
  | "queued"
  | "submitting"
  | "submitted"
  | "failed"
  | "needs_review";

export interface SubmissionRow {
  id: string;
  orderId: string;
  status: SubmissionStatus;
  attempts: number;
  nextRetryAt: string;
  payload: string | null;
  trackingNumber: string | null;
  rawResponse: string | null;
  lastError: string | null;
  normalizedStatus: string | null;
  rawStatus: string | null;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
  provider: string;
}

interface SubmissionsTableRow {
  id: string;
  order_id: string;
  status: string;
  attempts: number;
  next_retry_at: string;
  payload_json: string | null;
  tracking_number: string | null;
  raw_response_json: string | null;
  last_error: string | null;
  normalized_status: string | null;
  raw_status: string | null;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
  provider: string;
}

function mapSubmissionRow(row: SubmissionsTableRow): SubmissionRow {
  return {
    id: row.id,
    orderId: row.order_id,
    status: row.status as SubmissionStatus,
    attempts: row.attempts,
    nextRetryAt: row.next_retry_at,
    payload: row.payload_json,
    trackingNumber: row.tracking_number,
    rawResponse: row.raw_response_json,
    lastError: row.last_error,
    normalizedStatus: row.normalized_status,
    rawStatus: row.raw_status,
    lastSyncAt: row.last_sync_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    provider: row.provider,
  };
}

/**
 * Returns null when an active job (queued/submitting) already exists for the
 * order — the partial unique index rejects the insert and callers treat that
 * as a no-op success.
 */
export function createSubmission(orderId: string): SubmissionRow | null {
  const order = getCrmOrder(orderId);
  if (!order) throw new Error(`Commande introuvable : ${orderId}`);
  const db = getDb();
  const now = new Date().toISOString();
  const id = `sub_${nanoid(12)}`;
  try {
    db.prepare(
      `INSERT INTO courier_submissions (id, order_id, provider, status, attempts, next_retry_at, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
    ).run(id, orderId, deliveryProviderName(), now, buildPayloadSnapshot(order), now, now);
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
  const row = db.prepare("SELECT * FROM courier_submissions WHERE id = ?").get(
    id,
  ) as SubmissionsTableRow | undefined;
  return row ? mapSubmissionRow(row) : null;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

export function getSubmission(id: string): SubmissionRow | null {
  const row = getDb()
    .prepare("SELECT * FROM courier_submissions WHERE id = ?")
    .get(id) as SubmissionsTableRow | undefined;
  return row ? mapSubmissionRow(row) : null;
}

export interface SubmissionFilter {
  status?: SubmissionStatus;
  orderId?: string;
  provider?: string;
  /**
   * Excludes parcels in a terminal tracking status (delivered/cancelled) that
   * were submitted before this ISO instant. Recent terminal parcels stay polled
   * so a later, provably newer status (e.g. delivered → returned) is observed.
   */
  terminalBefore?: string;
}

export function listSubmissions(filter: SubmissionFilter = {}): SubmissionRow[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.status) {
    clauses.push("cs.status = ?");
    params.push(filter.status);
  }
  if (filter.orderId) {
    clauses.push("cs.order_id = ?");
    params.push(filter.orderId);
  }
  if (filter.provider) {
    clauses.push("cs.provider = ?");
    params.push(filter.provider);
  }
  if (filter.terminalBefore) {
    clauses.push("NOT (COALESCE(cs.normalized_status, '') IN ('delivered','cancelled') AND cs.created_at < ?)");
    params.push(filter.terminalBefore);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT cs.* FROM courier_submissions cs${where} ORDER BY cs.created_at ASC`)
    .all(...params) as SubmissionsTableRow[];
  return rows.map(mapSubmissionRow);
}
