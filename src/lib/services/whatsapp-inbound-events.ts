import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { redactText } from "@/lib/shipping/redact";

export function storeInboundEvent(input: {
  eventType: string;
  waMessageId: string | null;
  payload: unknown;
  now?: Date;
}): { stored: boolean; duplicate: boolean } {
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(input.payload);
    if (typeof payloadJson !== "string") {
      return { stored: false, duplicate: false };
    }
  } catch {
    return { stored: false, duplicate: false };
  }

  // Reject if > 256 KB after stringify
  if (Buffer.byteLength(payloadJson, "utf8") > 256 * 1024) {
    return { stored: false, duplicate: false };
  }

  const id = randomUUID();
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const waMessageId = input.waMessageId?.trim() || null;

  const db = getDb();
  const res = db.prepare(`
    INSERT INTO wa_inbound_events (
      id,
      event_type,
      wa_message_id,
      payload_json,
      status,
      attempts,
      available_at,
      received_at
    ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
    ON CONFLICT(wa_message_id) DO NOTHING
  `).run(id, input.eventType, waMessageId, payloadJson, nowIso, nowIso);

  if (res.changes === 1) {
    return { stored: true, duplicate: false };
  }
  return { stored: false, duplicate: true };
}

export interface ClaimedInbound {
  id: string;
  eventType: string;
  payload: unknown;
  attempts: number;
  lease: string;
}

export function claimNextInboundEvent(now = new Date()): ClaimedInbound | null {
  const db = getDb();
  return db.transaction((): ClaimedInbound | null => {
    const nowIso = now.toISOString();
    const lease = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();

    const row = db.prepare(`
      UPDATE wa_inbound_events
      SET status = 'processing',
          lease = ?,
          attempts = attempts + 1,
          available_at = ?
      WHERE id = (
        SELECT id FROM wa_inbound_events
        WHERE status = 'pending' AND available_at <= ?
        ORDER BY available_at ASC, received_at ASC
        LIMIT 1
      )
      RETURNING id, event_type, payload_json, attempts
    `).get(lease, leaseExpiresAt, nowIso) as {
      id: string;
      event_type: string;
      payload_json: string;
      attempts: number;
    } | undefined;

    if (!row) return null;

    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = null;
    }

    return {
      id: row.id,
      eventType: row.event_type,
      payload,
      attempts: row.attempts,
      lease,
    };
  }).immediate();
}

export function markInboundDone(id: string, lease: string, now = new Date()): void {
  const db = getDb();
  const nowIso = now.toISOString();
  db.prepare(`
    UPDATE wa_inbound_events
    SET status = 'done',
        lease = NULL,
        processed_at = ?
    WHERE id = ? AND lease = ? AND status = 'processing'
  `).run(nowIso, id, lease);
}

export function markInboundIgnored(id: string, lease: string, reason: string, now = new Date()): void {
  const db = getDb();
  const nowIso = now.toISOString();
  const safeReason = redactText(reason).slice(0, 300);
  db.prepare(`
    UPDATE wa_inbound_events
    SET status = 'ignored',
        lease = NULL,
        processed_at = ?,
        last_error = ?
    WHERE id = ? AND lease = ? AND status = 'processing'
  `).run(nowIso, safeReason, id, lease);
}

export function markInboundRetry(id: string, lease: string, error: string, now = new Date()): void {
  const db = getDb();
  db.transaction(() => {
    const row = db.prepare(
      "SELECT attempts FROM wa_inbound_events WHERE id = ? AND lease = ? AND status = 'processing'"
    ).get(id, lease) as { attempts: number } | undefined;
    if (!row) return;

    const safeError = redactText(error).slice(0, 300);
    const nowIso = now.toISOString();

    if (row.attempts >= 8) {
      db.prepare(`
        UPDATE wa_inbound_events
        SET status = 'failed',
            lease = NULL,
            processed_at = ?,
            last_error = ?
        WHERE id = ? AND lease = ?
      `).run(nowIso, safeError, id, lease);
    } else {
      const delayMs = Math.min(10 * 60 * 1000, 5000 * Math.pow(2, row.attempts));
      const availableAt = new Date(now.getTime() + delayMs).toISOString();
      db.prepare(`
        UPDATE wa_inbound_events
        SET status = 'pending',
            lease = NULL,
            available_at = ?,
            last_error = ?
        WHERE id = ? AND lease = ?
      `).run(availableAt, safeError, id, lease);
    }
  }).immediate();
}

export function markInboundFailed(id: string, lease: string, error: string, now = new Date()): void {
  const db = getDb();
  const nowIso = now.toISOString();
  const safeError = redactText(error).slice(0, 300);
  db.prepare(`
    UPDATE wa_inbound_events
    SET status = 'failed',
        lease = NULL,
        processed_at = ?,
        last_error = ?
    WHERE id = ? AND lease = ? AND status = 'processing'
  `).run(nowIso, safeError, id, lease);
}

export function recoverStaleInbound(now = new Date()): number {
  const db = getDb();
  const nowIso = now.toISOString();
  const res = db.prepare(`
    UPDATE wa_inbound_events
    SET status = 'pending',
        lease = NULL,
        available_at = ?
    WHERE status = 'processing' AND available_at <= ?
  `).run(nowIso, nowIso);
  return res.changes;
}

export function purgeInboundEvents(now = new Date()): number {
  const db = getDb();
  const cutoffDone = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const cutoffFailed = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const res = db.prepare(`
    DELETE FROM wa_inbound_events
    WHERE (status IN ('done', 'ignored') AND COALESCE(processed_at, received_at) < ?)
       OR (status = 'failed' AND COALESCE(processed_at, received_at) < ?)
  `).run(cutoffDone, cutoffFailed);
  return res.changes;
}
