import { nanoid } from "nanoid";
import { getDb } from "@/lib/db";
import { courierNumberEnv, courierProfile, deliveryProviderName } from "@/lib/env";
import { getCrmOrder as getOrder } from "./orders";
import { getProvider } from "@/lib/shipping";
import type { CourierName } from "@/lib/shipping/couriers";
import { ProviderError } from "@/lib/shipping/errors";
import type { DeliveryProvider } from "@/lib/shipping/provider";
import { redactText } from "@/lib/shipping/redact";
import { normalizeStatus, type NormalizedTrackingStatus } from "@/lib/shipping/status-map";
import {
  maybeNotifyFromRawStatus,
  recordRawStatus,
} from "@/lib/services/carrier-status-map";
import { setDeliveryOutcome } from "@/lib/services/delivery-outcomes";
import { listMovements, recoverDispatch } from "@/lib/services/inventory";
import { listSubmissions, type SubmissionRow } from "@/lib/services/submissions";
import { ensureReturn } from "@/lib/services/returns";
import { getAppState, setAppState } from "@/lib/services/app-state";

const DEFAULT_POLL_INTERVAL_MIN = 30;
const MIN_POLL_INTERVAL_MIN = 5;
const DEFAULT_TRACK_BATCH = 25;

/** app_state key holding the ISO timestamp of the last successful poll. */
export const TRACKING_LAST_SYNC_KEY = "tracking_last_sync";
/** Delivered/cancelled parcels older than this are no longer polled. */
const TERMINAL_POLL_RETENTION_MS = 45 * 24 * 60 * 60 * 1000;

export function pollIntervalMin(): number {
  const raw = courierNumberEnv("POLL_INTERVAL_MIN");
  const min = raw !== undefined && raw > 0 ? raw : DEFAULT_POLL_INTERVAL_MIN;
  return Math.max(min, MIN_POLL_INTERVAL_MIN);
}

export function pollIntervalMs(): number {
  return pollIntervalMin() * 60_000;
}

export function trackBatchSize(): number {
  const raw = courierNumberEnv("TRACK_BATCH");
  return raw !== undefined && Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_TRACK_BATCH;
}

export { getAppState, setAppState };

export interface TrackingHealth {
  lastSuccessfulSync: string | null;
  failing: boolean;
  /** Submitted parcels not successfully tracked within 2× the poll interval. */
  staleParcels: number;
}

/**
/**
 * Staleness signal consumed by the CRM dashboard (task-17): failing once the
 * last successful sync is older than 2× the poll interval (or missing), OR when
 * any submitted parcel has itself gone unsynced for longer than that window — a
 * single healthy batch must not mask parcels whose batch keeps failing. Parcels
 * submitted within the window are given time to be polled once.
 */
export function getTrackingHealth(now: Date = new Date()): TrackingHealth {
  const last = getAppState(TRACKING_LAST_SYNC_KEY);
  const parsed = last ? Date.parse(last) : Number.NaN;
  const windowMs = 2 * pollIntervalMs();
  const globalStale = Number.isNaN(parsed) || now.getTime() - parsed > windowMs;
  const cutoff = new Date(now.getTime() - windowMs).toISOString();
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM courier_submissions
       WHERE status = 'submitted' AND tracking_number IS NOT NULL
         AND COALESCE(last_sync_at, created_at) < ?
         AND (normalized_status IS NULL
              OR normalized_status NOT IN ('delivered','cancelled'))`,
    )
    .get(cutoff) as { n: number };
  return {
    lastSuccessfulSync: last,
    failing: globalStale || row.n > 0,
    staleParcels: row.n,
  };
}

// --- Defensive payload helpers (the tracking response schema is unverified,
// docs/operations.md — nothing here may throw on unexpected shapes).

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyOf(value: string): string {
  return value.toLowerCase().replace(/[\s_-]/g, "");
}

// Best-effort timestamp keys inside an (unverified) tracking payload — the
// poller stores only what the provider actually reports, never invents times.
const OBSERVED_AT_KEYS = new Set([
  "observedat",
  "date",
  "datetime",
  "timestamp",
  "statusdate",
  "datestatus",
  "lastupdate",
  "lastupdated",
  "updatedat",
]);

function extractObservedAt(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  for (const [key, value] of Object.entries(raw)) {
    if (!OBSERVED_AT_KEYS.has(keyOf(key))) continue;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function rawJsonOf(raw: unknown): string | null {
  try {
    return JSON.stringify(raw) ?? null;
  } catch {
    return null;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

function errMessage(err: unknown): string {
  return redactText(err instanceof Error ? err.message : String(err));
}

// --- Observation persistence.

interface Observation {
  submission: SubmissionRow;
  rawStatus: string;
  normalized: NormalizedTrackingStatus;
  raw: unknown;
}

/** A delivered parcel is final: nothing without proof of recency may move it. */
const STICKY_STATUS: NormalizedTrackingStatus = "delivered";

function parseObservedAt(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Stores the tracking event (raw history is always preserved) and updates the
 * submission's current status ONLY when the observation is eligible. Returns
 * true when it was applied (callers run stock/return side effects only then).
 *
 * observed_at sentinel: the provider may not yield an observed timestamp
 * (response schema unknown) — an empty string is stored instead of NULL so
 * UNIQUE(submission_id, raw_status, observed_at) actually dedupes across
 * re-polls (SQLite treats NULLs as distinct). When the provider DOES report a
 * timestamp it is stored as-is; only genuinely observed values are kept.
 *
 * Eligibility (R5):
 * - A parseable observed_at strictly OLDER than the newest parseable event
 *   already stored for this parcel is stale: history only, state untouched.
 * - Without ordering evidence (missing/unparseable timestamp) the poll is
 *   treated as current, except that a `delivered` parcel is never moved to a
 *   different status — a non-terminal or contradictory status needs a newer,
 *   parseable timestamp to override it.
 * - An observation with a newer parseable timestamp always applies.
 */
function persistObservation(obs: Observation, now: string): boolean {
  const db = getDb();
  const observedAt = extractObservedAt(obs.raw) ?? "";
  const observedMs = parseObservedAt(observedAt);
  return db.transaction(() => {
    const current = db
      .prepare("SELECT normalized_status FROM courier_submissions WHERE id = ?")
      .get(obs.submission.id) as { normalized_status: string | null } | undefined;
    const known = db
      .prepare("SELECT observed_at FROM tracking_events WHERE submission_id = ? AND observed_at != ''")
      .all(obs.submission.id) as { observed_at: string }[];
    let newestMs: number | null = null;
    for (const row of known) {
      const ms = parseObservedAt(row.observed_at);
      if (ms !== null && (newestMs === null || ms > newestMs)) newestMs = ms;
    }

    try {
      db.prepare(
        `INSERT INTO tracking_events
           (id, submission_id, raw_status, normalized_status, observed_at, raw_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `evt_${nanoid(12)}`,
        obs.submission.id,
        obs.rawStatus,
        obs.normalized,
        observedAt,
        rawJsonOf(obs.raw),
        now,
      );
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Exact replay (same raw status + same observed_at) — already stored.
    }

    let eligible = true;
    if (observedMs !== null && newestMs !== null && observedMs < newestMs) {
      eligible = false; // Older than something we already know.
    } else if (
      (observedMs === null || newestMs === null || observedMs <= newestMs) &&
      current?.normalized_status === STICKY_STATUS &&
      obs.normalized !== STICKY_STATUS
    ) {
      eligible = false; // No proof of recency against a terminal status.
    }

    if (!eligible) {
      db.prepare(
        "UPDATE courier_submissions SET last_sync_at = ?, updated_at = ? WHERE id = ?",
      ).run(now, now, obs.submission.id);
      console.warn(
        `[tracking] observation « ${obs.rawStatus} » ignorée pour l'état courant de ${obs.submission.id} (antérieure ou contradictoire) — historique conservé`,
      );
      return false;
    }
    db.prepare(
      `UPDATE courier_submissions
       SET raw_status = ?, normalized_status = ?, last_sync_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(obs.rawStatus, obs.normalized, now, now, obs.submission.id);
    return true;
  })();
}

function touchLastSync(submission: SubmissionRow, now: string): void {
  getDb()
    .prepare(
      "UPDATE courier_submissions SET last_sync_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(now, now, submission.id);
}

// --- Side effects. Inventory is touched ONLY through the inventory service
// (recoverDispatch); returns rows NEVER restock (receipt+inspection is task-16).

/** Missed-dispatch recovery: exactly-once, guarded both here and inside the service. */
function recoverMissedDispatch(submission: SubmissionRow): void {
  const order = getOrder(submission.orderId);
  if (!order) {
    console.warn(
      `[tracking] colis ${submission.trackingNumber} livré mais commande ${submission.orderId} introuvable — rattrapage ignoré`,
    );
    return;
  }
  if (order.confirmationStatus === "cancelled") {
    console.warn(
      `[tracking] colis ${submission.trackingNumber} livré mais commande ${submission.orderId} annulée — rattrapage ignoré`,
    );
    return;
  }
  const prior = listMovements({ orderId: submission.orderId }).filter(
    (m) => m.kind === "dispatch" || m.ref.startsWith("disp"),
  );
  if (prior.length > 0) return; // Handoff already recorded (disp:* / disp-recovered:*).
  try {
    recoverDispatch(submission.orderId, "tracking-poller");
    console.log(`[tracking] remise au livreur rattrapée pour ${submission.orderId}`);
  } catch (err) {
    console.error(
      `[tracking] rattrapage impossible pour ${submission.orderId} : ${errMessage(err)}`,
    );
  }
}

function applySideEffects(
  submission: SubmissionRow,
  normalized: NormalizedTrackingStatus,
  rawStatus: string,
): void {
  try {
    switch (normalized) {
      case "delivered":
        // Movement recorded exactly once via recoverDispatch's order-wide guard.
        // cod_status stays untouched (delivered ≠ paid out).
        recoverMissedDispatch(submission);
        // Idempotent; never overrides an agent-declared outcome.
        setDeliveryOutcome(submission.orderId, "delivered", "tracking-poller", "tracking");
        break;
      case "refused":
      case "return_in_transit":
        // insert-or-ignore: monitoring only, never any stock change here.
        ensureReturn(submission.id, rawStatus);
        if (normalized === "refused") {
          setDeliveryOutcome(submission.orderId, "refused", "tracking-poller", "tracking");
        }
        break;
      case "cancelled":
        // Change-gated so re-polls don't spam; stock untouched either way.
        if (submission.normalizedStatus !== normalized) {
          console.log(
            `[tracking] colis ${submission.trackingNumber} signalé annulé — stock inchangé`,
          );
        }
        break;
      default:
        break; // unknown / in_transit / at_facility / out_for_delivery / awaiting_pickup / delivery_issue: stored only.
    }
  } catch (err) {
    console.error(
      `[tracking] effet secondaire impossible pour ${submission.id} (${normalized}) : ${errMessage(err)}`,
    );
  }
}

// --- Per-result processing (defensive: one bad result never aborts the batch).

function processResult(
  result: unknown,
  byCode: Map<string, SubmissionRow[]>,
  courier: CourierName = "ozon",
): void {
  if (!isRecord(result)) {
    console.warn(
      `[tracking] entrée de suivi illisible, ignorée : ${redactText(rawJsonOf(result) ?? String(result))}`,
    );
    return;
  }
  const code = typeof result.trackingNumber === "string" ? result.trackingNumber.trim() : "";
  const targets = code ? byCode.get(code) : undefined;
  if (!targets) {
    console.warn(`[tracking] suivi inconnu dans la réponse, ignoré : ${redactText(code)}`);
    return;
  }
  const rawStatus =
    typeof result.rawStatus === "string" && result.rawStatus.trim()
      ? result.rawStatus.trim()
      : null;

  for (const submission of targets) {
    try {
      const now = new Date().toISOString();
      if (!rawStatus) {
        // Nothing observed for this code — keep last seen status, mark sync time.
        touchLastSync(submission, now);
        continue;
      }
      const normalized = normalizeStatus(rawStatus, courier);
      // Owner-maintained carrier mapping: every raw status the poller sees is
      // recorded per provider so the owner can map it to a notification
      // category. Telemetry only — must never break the poll or touch stock.
      try {
        recordRawStatus(submission.provider, rawStatus);
      } catch (err) {
        console.error(
          `[tracking] enregistrement du statut brut impossible pour ${submission.id} : ${errMessage(err)}`,
        );
      }
      const applied = persistObservation(
        { submission, rawStatus, normalized, raw: result.raw },
        now,
      );
      if (applied) {
        applySideEffects(submission, normalized, rawStatus);
        // Mapped raw statuses may enqueue WhatsApp notifications 3/4; the
        // helper catches its own failures and never touches stock, delivery
        // outcomes, returns or normalized statuses.
        maybeNotifyFromRawStatus(submission.orderId, submission.id, rawStatus, submission.provider);
      }
    } catch (err) {
      console.error(
        `[tracking] résultat non traité pour ${submission.id} : ${errMessage(err)}`,
      );
    }
  }
}

// --- Poll.

/**
 * One tracking pass over every submitted parcel. Batched bulk calls; a failed
 * batch is logged (redacted) and skipped without touching its last_sync_at;
 * a pass with at least one usable batch (or nothing to poll) updates
 * app_state `tracking_last_sync` for the staleness alert (getTrackingHealth).
 */
export async function pollOnce(provider?: DeliveryProvider): Promise<void> {
  const p = provider ?? getProvider();
  const pollAt = new Date().toISOString();
  const profile: CourierName = p.profile ?? courierProfile();

  const byCode = new Map<string, SubmissionRow[]>();
  for (const row of listSubmissions({
    status: "submitted",
    provider: deliveryProviderName(),
    terminalBefore: new Date(Date.now() - TERMINAL_POLL_RETENTION_MS).toISOString(),
  })) {
    const code = row.trackingNumber?.trim();
    if (!code) continue;
    const list = byCode.get(code) ?? [];
    list.push(row);
    byCode.set(code, list);
  }
  const codes = [...byCode.keys()];
  if (codes.length === 0) {
    setAppState(TRACKING_LAST_SYNC_KEY, pollAt);
    return;
  }

  const batch = trackBatchSize();
  let anySuccess = false;
  for (let i = 0; i < codes.length; i += batch) {
    const slice = codes.slice(i, i + batch);
    try {
      const results = await p.track(slice);
      if (!Array.isArray(results)) {
        console.error("[tracking] réponse tracking inattendue (pas un tableau) — lot ignoré");
        continue;
      }
      anySuccess = true;
      for (const result of results) {
        try {
          processResult(result, byCode, profile);
        } catch (err) {
          console.error(`[tracking] résultat non traité : ${errMessage(err)}`);
        }
      }
    } catch (err) {
      const kind = err instanceof ProviderError ? err.kind : "unknown";
      console.error(`[tracking] échec du lot (${kind}) : ${errMessage(err)}`);
    }
  }
  if (anySuccess) setAppState(TRACKING_LAST_SYNC_KEY, pollAt);
}
