import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { normalizeMaPhone } from "@/lib/phone";
import { getAppState, setAppState } from "@/lib/services/app-state";
import { getWhatsAppSettings } from "@/lib/services/whatsapp-settings";
import {
  casablancaDateTimeToDate,
  casablancaParts,
  inWindow,
  nextWindowOpen,
  randomGapMs,
  tomorrowWindowOpen,
} from "@/lib/whatsapp/pacing";

export type OutboxPurpose =
  | "notify_confirmed"
  | "notify_shipped"
  | "notify_delivered"
  | "notify_out_for_delivery"
  | "notify_delivery_issue"
  | "notify_cancelled"
  | "relance_no_answer"
  | "admin_alert"
  | "ai_reply"
  | "agent_reply"
  | "strike_warning"
  | "product_card";

export interface EnqueueInput {
  dedupeKey: string;
  phone: string;
  purpose: OutboxPurpose;
  body: string;
  kind?: "text" | "image";
  mediaRef?: string | null;
  orderId?: string | null;
  conversationId?: string | null;
  availableAt?: string;
  respectWindow?: boolean;
  countsTowardCap?: boolean;
  authorUserId?: string | null;
}

export interface ClaimedOutbox {
  id: string;
  phone: string;
  purpose: OutboxPurpose;
  kind: "text" | "image";
  body: string;
  mediaRef: string | null;
  conversationId: string | null;
  orderId: string | null;
  lease: string;
  attempts: number;
}

interface OutboxRow {
  id: string;
  dedupe_key: string;
  conversation_id: string | null;
  order_id: string | null;
  phone: string;
  purpose: OutboxPurpose;
  kind: "text" | "image";
  body: string;
  media_ref: string | null;
  respect_window: number;
  counts_toward_cap: number;
  status: string;
  attempts: number;
  available_at: string;
  lease: string | null;
  wa_message_id: string | null;
  last_error: string | null;
  author_user_id: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  sent_at: string | null;
  updated_at: string;
}

/**
 * Enqueues a row in wa_outbox. Must be called INSIDE the caller's db.transaction
 * so the message is only queued when the business change commits (Meta outbox pattern).
 * Skips and returns false when:
 * - settings.enabled is false
 * - purpose is notify_* or relance_no_answer and notificationsEnabled is false
 * - phone in blocked_phones, unless purpose is admin_alert
 * - matching wa_conversations.no_whatsapp = 1
 * Otherwise INSERT OR IGNORE on dedupe_key (returns false if deduped).
 */
export function enqueueOutbox(input: EnqueueInput): boolean {
  const db = getDb();
  const settings = getWhatsAppSettings();

  if (!settings.enabled) return false;

  if (
    (input.purpose.startsWith("notify_") || input.purpose === "relance_no_answer") &&
    !settings.notificationsEnabled
  ) {
    return false;
  }

  const normPhone = normalizeMaPhone(input.phone);
  if (!normPhone) return false;

  if (input.purpose !== "admin_alert") {
    const blocked = db
      .prepare("SELECT 1 FROM blocked_phones WHERE phone = ? OR phone = ?")
      .get(normPhone, input.phone);
    if (blocked) return false;
  }

  let conv: { id: string; no_whatsapp: number } | undefined;
  if (input.conversationId) {
    conv = db
      .prepare("SELECT id, no_whatsapp FROM wa_conversations WHERE id = ?")
      .get(input.conversationId) as { id: string; no_whatsapp: number } | undefined;
  } else {
    conv = db
      .prepare("SELECT id, no_whatsapp FROM wa_conversations WHERE phone = ? OR phone = ?")
      .get(normPhone, input.phone) as { id: string; no_whatsapp: number } | undefined;
  }

  if (conv && conv.no_whatsapp === 1) {
    return false;
  }

  let respectWindow: number;
  if (input.respectWindow !== undefined) {
    respectWindow = input.respectWindow ? 1 : 0;
  } else if (
    input.purpose.startsWith("notify_") ||
    input.purpose === "relance_no_answer" ||
    input.purpose === "product_card"
  ) {
    respectWindow = 1;
  } else if (input.purpose === "admin_alert") {
    respectWindow = settings.adminQuietHours ? 1 : 0;
  } else {
    respectWindow = 0;
  }

  let countsTowardCap: number;
  if (input.countsTowardCap !== undefined) {
    countsTowardCap = input.countsTowardCap ? 1 : 0;
  } else if (
    input.purpose.startsWith("notify_") ||
    input.purpose === "relance_no_answer" ||
    input.purpose === "product_card"
  ) {
    countsTowardCap = 1;
  } else {
    countsTowardCap = 0;
  }

  const id = randomUUID();
  const nowIso = new Date().toISOString();
  const availableAt = input.availableAt ?? nowIso;
  const conversationId = input.conversationId ?? conv?.id ?? null;
  const kind = input.kind ?? "text";
  const mediaRef = input.mediaRef ?? null;
  const orderId = input.orderId ?? null;
  const authorUserId = input.authorUserId ?? null;

  const result = db
    .prepare(`
      INSERT OR IGNORE INTO wa_outbox (
        id, dedupe_key, conversation_id, order_id, phone,
        purpose, kind, body, media_ref, respect_window,
        counts_toward_cap, status, attempts, available_at,
        author_user_id, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, 'queued', 0, ?,
        ?, ?, ?
      )
    `)
    .run(
      id,
      input.dedupeKey,
      conversationId,
      orderId,
      normPhone,
      input.purpose,
      kind,
      input.body,
      mediaRef,
      respectWindow,
      countsTowardCap,
      availableAt,
      authorUserId,
      nowIso,
      nowIso,
    );

  return result.changes > 0;
}

/**
 * Atomically claims at most one due row, honoring pacing:
 * - settings.enabled
 * - global gap in app_state (wa_next_send_at)
 * - send window (Africa/Casablanca [start, end)) for respect_window=1 rows
 * - dailyOutboundCap for counts_toward_cap=1 rows (Casablanca day)
 * - replies (counts_toward_cap=0) jump the queue
 * Returns null when nothing may be sent now.
 */
export function claimNextOutbox(now: Date = new Date()): ClaimedOutbox | null {
  const db = getDb();
  return db
    .transaction(() => {
      const settings = getWhatsAppSettings();
      if (!settings.enabled) return null;

      const nowIso = now.toISOString();

      const nextSendAt = getAppState("wa_next_send_at");
      if (nextSendAt && now.getTime() < new Date(nextSendAt).getTime()) {
        return null;
      }

      const candidates = db
        .prepare(`
          SELECT * FROM wa_outbox
          WHERE status = 'queued' AND available_at <= ?
          ORDER BY counts_toward_cap ASC, available_at ASC
          LIMIT 50
        `)
        .all(nowIso) as OutboxRow[];

      if (candidates.length === 0) {
        return null;
      }

      const { date: todayDate } = casablancaParts(now);
      const startOfDay = casablancaDateTimeToDate(todayDate, "00:00").toISOString();
      const endOfDay = tomorrowWindowOpen(now, "00:00").toISOString();

      const sentToday = (
        db
          .prepare(
            "SELECT COUNT(*) as count FROM wa_outbox WHERE status = 'sent' AND counts_toward_cap = 1 AND sent_at >= ? AND sent_at < ?",
          )
          .get(startOfDay, endOfDay) as { count: number }
      ).count;

      for (const candidate of candidates) {
        if (candidate.respect_window === 1) {
          if (!inWindow(now, settings.sendWindowStart, settings.sendWindowEnd)) {
            const nextOpen = nextWindowOpen(now, settings.sendWindowStart);
            db.prepare(
              "UPDATE wa_outbox SET available_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
            ).run(nextOpen.toISOString(), nowIso, candidate.id);
            continue;
          }
          if (candidate.counts_toward_cap === 1 && sentToday >= settings.dailyOutboundCap) {
            const tomorrowOpen = tomorrowWindowOpen(now, settings.sendWindowStart);
            db.prepare(
              "UPDATE wa_outbox SET available_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
            ).run(tomorrowOpen.toISOString(), nowIso, candidate.id);
            continue;
          }
        } else if (candidate.counts_toward_cap === 1 && sentToday >= settings.dailyOutboundCap) {
          const tomorrowOpen = tomorrowWindowOpen(now, settings.sendWindowStart);
          db.prepare(
            "UPDATE wa_outbox SET available_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
          ).run(tomorrowOpen.toISOString(), nowIso, candidate.id);
          continue;
        }

        const lease = randomUUID();
        const updateRes = db
          .prepare(
            "UPDATE wa_outbox SET status = 'sending', lease = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'",
          )
          .run(lease, nowIso, candidate.id);

        if (updateRes.changes === 0) {
          continue;
        }

        let gapMs: number;
        if (candidate.counts_toward_cap === 1) {
          gapMs = randomGapMs(settings.minGapSeconds, settings.maxGapSeconds);
        } else {
          gapMs = randomGapMs(2, 5);
        }
        const nextSendAtIso = new Date(now.getTime() + gapMs).toISOString();
        setAppState("wa_next_send_at", nextSendAtIso);

        return {
          id: candidate.id,
          phone: candidate.phone,
          purpose: candidate.purpose,
          kind: candidate.kind,
          body: candidate.body,
          mediaRef: candidate.media_ref,
          conversationId: candidate.conversation_id,
          orderId: candidate.order_id,
          lease,
          attempts: candidate.attempts + 1,
        };
      }

      return null;
    })
    .immediate();
}

/**
 * Internal helper to insert a message into wa_messages and update the conversation
 * when an outbox message has been sent.
 */
function recordSentMessage(
  db: ReturnType<typeof getDb>,
  row: OutboxRow,
  waMessageId: string | null,
  nowIso: string,
): void {
  let conversationId = row.conversation_id;
  if (!conversationId) {
    const conv = db
      .prepare("SELECT id FROM wa_conversations WHERE phone = ?")
      .get(row.phone) as { id: string } | undefined;
    if (conv) {
      conversationId = conv.id;
      db.prepare("UPDATE wa_outbox SET conversation_id = ? WHERE id = ?").run(conversationId, row.id);
    }
  }

  if (conversationId) {
    const existing = db
      .prepare("SELECT 1 FROM wa_messages WHERE outbox_id = ?")
      .get(row.id);

    let author: "ai" | "agent" | "system";
    if (row.purpose === "ai_reply" || row.purpose === "product_card") {
      author = "ai";
    } else if (row.purpose === "agent_reply") {
      author = "agent";
    } else {
      author = "system";
    }

    if (!existing) {
      const msgId = randomUUID();
      const finalWaMsgId = waMessageId ?? row.wa_message_id ?? null;
      db.prepare(`
        INSERT INTO wa_messages (
          id, conversation_id, direction, author, author_user_id,
          wa_message_id, kind, body, media_path, outbox_id, created_at
        ) VALUES (
          ?, ?, 'out', ?, ?,
          ?, ?, ?, ?, ?, ?
        )
      `).run(
        msgId,
        conversationId,
        author,
        row.author_user_id ?? null,
        finalWaMsgId,
        row.kind,
        row.body,
        row.media_ref ?? null,
        row.id,
        nowIso,
      );
    }

    db.prepare(`
      UPDATE wa_conversations
      SET last_outbound_at = ?,
          last_preview = ?,
          last_agent_reply_at = CASE WHEN ? = 'agent' THEN ? ELSE last_agent_reply_at END,
          updated_at = ?
      WHERE id = ?
    `).run(
      nowIso,
      row.body.slice(0, 200),
      author,
      nowIso,
      nowIso,
      conversationId,
    );
  }
}

/**
 * Marks a claimed outbox row as sent, records wa_message_id, clears lease,
 * inserts into wa_messages (if conversation_id) and updates conversation.last_outbound_at.
 */
export function markOutboxSent(id: string, lease: string, waMessageId: string | null): void {
  const db = getDb();
  db.transaction(() => {
    const row = db
      .prepare("SELECT * FROM wa_outbox WHERE id = ? AND lease = ?")
      .get(id, lease) as OutboxRow | undefined;
    if (!row) return;

    const nowIso = new Date().toISOString();
    db.prepare(`
      UPDATE wa_outbox
      SET status = 'sent',
          wa_message_id = COALESCE(?, wa_message_id),
          lease = NULL,
          sent_at = ?,
          updated_at = ?
      WHERE id = ? AND lease = ?
    `).run(waMessageId, nowIso, nowIso, id, lease);

    recordSentMessage(db, row, waMessageId, nowIso);
  }).immediate();
}

/**
 * Puts a message back to queued with exponential backoff:
 * available_at = now + min(1h, 15s * 2^attempts); after 10 attempts -> failed.
 */
export function markOutboxRetry(id: string, lease: string, error: string): void {
  const db = getDb();
  db.transaction(() => {
    const row = db
      .prepare("SELECT attempts FROM wa_outbox WHERE id = ? AND lease = ?")
      .get(id, lease) as { attempts: number } | undefined;
    if (!row) return;

    const nowIso = new Date().toISOString();
    if (row.attempts >= 10) {
      db.prepare(`
        UPDATE wa_outbox
        SET status = 'failed',
            lease = NULL,
            last_error = ?,
            updated_at = ?
        WHERE id = ? AND lease = ?
      `).run(error, nowIso, id, lease);
    } else {
      const backoffMs = Math.min(3600_000, 15_000 * Math.pow(2, row.attempts));
      const nextAvailable = new Date(Date.now() + backoffMs).toISOString();
      db.prepare(`
        UPDATE wa_outbox
        SET status = 'queued',
            lease = NULL,
            last_error = ?,
            available_at = ?,
            updated_at = ?
        WHERE id = ? AND lease = ?
      `).run(error, nextAvailable, nowIso, id, lease);
    }
  }).immediate();
}

/**
 * Marks outbox row as permanently failed.
 */
export function markOutboxFailed(id: string, lease: string, error: string): void {
  const nowIso = new Date().toISOString();
  getDb()
    .prepare(`
      UPDATE wa_outbox
      SET status = 'failed',
          lease = NULL,
          last_error = ?,
          updated_at = ?
      WHERE id = ? AND lease = ?
    `)
    .run(error, nowIso, id, lease);
}

/**
 * Marks outbox row as uncertain (never auto-retried).
 */
export function markOutboxUncertain(id: string, lease: string, error: string): void {
  const nowIso = new Date().toISOString();
  getDb()
    .prepare(`
      UPDATE wa_outbox
      SET status = 'uncertain',
          lease = NULL,
          last_error = ?,
          updated_at = ?
      WHERE id = ? AND lease = ?
    `)
    .run(error, nowIso, id, lease);
}

/**
 * Manually resolves an uncertain outbox row:
 * - "sent": marks sent, records wa_messages row, updates conversation
 * - "not_sent_requeue": marks queued, clears lease, resets available_at to now
 * - "cancel": marks cancelled, clears lease
 */
export function resolveUncertain(
  id: string,
  userId: string,
  resolution: "sent" | "not_sent_requeue" | "cancel",
): boolean {
  const db = getDb();
  return db
    .transaction(() => {
      const row = db
        .prepare("SELECT * FROM wa_outbox WHERE id = ?")
        .get(id) as OutboxRow | undefined;
      if (!row || row.status !== "uncertain") return false;

      const nowIso = new Date().toISOString();
      if (resolution === "sent") {
        db.prepare(`
          UPDATE wa_outbox
          SET status = 'sent',
              resolved_by = ?,
              resolved_at = ?,
              sent_at = COALESCE(sent_at, ?),
              lease = NULL,
              updated_at = ?
          WHERE id = ?
        `).run(userId, nowIso, nowIso, nowIso, id);
        recordSentMessage(db, row, null, nowIso);
        return true;
      }

      if (resolution === "not_sent_requeue") {
        db.prepare(`
          UPDATE wa_outbox
          SET status = 'queued',
              resolved_by = ?,
              resolved_at = ?,
              available_at = ?,
              lease = NULL,
              updated_at = ?
          WHERE id = ?
        `).run(userId, nowIso, nowIso, nowIso, id);
        return true;
      }

      if (resolution === "cancel") {
        db.prepare(`
          UPDATE wa_outbox
          SET status = 'cancelled',
              resolved_by = ?,
              resolved_at = ?,
              lease = NULL,
              updated_at = ?
          WHERE id = ?
        `).run(userId, nowIso, nowIso, id);
        return true;
      }

      return false;
    })
    .immediate();
}

/**
 * Cancels queued outbox messages for an order.
 * If purposes is provided, only cancels rows with matching purposes.
 */
export function cancelQueuedForOrder(orderId: string, purposes?: OutboxPurpose[]): number {
  const db = getDb();
  const nowIso = new Date().toISOString();
  if (purposes && purposes.length > 0) {
    const placeholders = purposes.map(() => "?").join(", ");
    const result = db
      .prepare(`
        UPDATE wa_outbox
        SET status = 'cancelled',
            updated_at = ?
        WHERE order_id = ?
          AND status = 'queued'
          AND purpose IN (${placeholders})
      `)
      .run(nowIso, orderId, ...purposes);
    return result.changes;
  }

  const result = db
    .prepare(`
      UPDATE wa_outbox
      SET status = 'cancelled',
          updated_at = ?
      WHERE order_id = ?
        AND status = 'queued'
    `)
    .run(nowIso, orderId);
  return result.changes;
}

/**
 * Transitions stuck 'sending' rows with lease older than 5 minutes to 'uncertain'.
 */
export function recoverStaleSending(now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - 5 * 60_000).toISOString();
  const nowIso = now.toISOString();
  const result = getDb()
    .prepare(`
      UPDATE wa_outbox
      SET status = 'uncertain',
          lease = NULL,
          last_error = COALESCE(last_error, 'Délai d''envoi dépassé'),
          updated_at = ?
      WHERE status = 'sending' AND updated_at < ?
    `)
    .run(nowIso, cutoff);
  return result.changes;
}

/**
 * Deletes sent, failed and cancelled outbox rows older than 30 days.
 */
export function purgeOutbox(now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - 30 * 86400_000).toISOString();
  const result = getDb()
    .prepare(`
      DELETE FROM wa_outbox
      WHERE status IN ('sent', 'failed', 'cancelled')
        AND updated_at < ?
    `)
    .run(cutoff);
  return result.changes;
}

/**
 * Computes live outbox statistics.
 */
export function outboxStats(now: Date = new Date()): {
  queued: number;
  uncertain: number;
  failed24h: number;
  sentToday: number;
  capRemaining: number;
} {
  const db = getDb();
  const settings = getWhatsAppSettings();
  const { date: todayDate } = casablancaParts(now);
  const startOfDay = casablancaDateTimeToDate(todayDate, "00:00").toISOString();
  const endOfDay = tomorrowWindowOpen(now, "00:00").toISOString();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 3600_000).toISOString();

  const queued = (
    db.prepare("SELECT COUNT(*) as count FROM wa_outbox WHERE status = 'queued'").get() as { count: number }
  ).count;

  const uncertain = (
    db.prepare("SELECT COUNT(*) as count FROM wa_outbox WHERE status = 'uncertain'").get() as { count: number }
  ).count;

  const failed24h = (
    db.prepare("SELECT COUNT(*) as count FROM wa_outbox WHERE status = 'failed' AND updated_at >= ?").get(
      twentyFourHoursAgo,
    ) as { count: number }
  ).count;

  const sentToday = (
    db
      .prepare(
        "SELECT COUNT(*) as count FROM wa_outbox WHERE status = 'sent' AND counts_toward_cap = 1 AND sent_at >= ? AND sent_at < ?",
      )
      .get(startOfDay, endOfDay) as { count: number }
  ).count;

  const capRemaining = Math.max(0, settings.dailyOutboundCap - sentToday);

  return {
    queued,
    uncertain,
    failed24h,
    sentToday,
    capRemaining,
  };
}
