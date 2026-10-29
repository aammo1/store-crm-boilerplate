import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { normalizeMaPhone } from "@/lib/phone";
import { blockPhoneSystem, isPhoneBlocked } from "@/lib/services/customers";
import { getWhatsAppSettings } from "@/lib/services/whatsapp-settings";

export const STRIKE_POINTS = {
  insult: 2,
  severe: 3,
  spam_burst: 1,
  refused_delivery: 2,
  repeated_cancel: 1,
  manipulation: 1,
  ref_guessing: 1,
} as const;

export const STRIKE_TTL_DAYS = 90;
export const BLOCK_THRESHOLD = 3;

export type StrikeReason = keyof typeof STRIKE_POINTS;

/** French labels used in system block reasons and (later) warning messages. */
export const STRIKE_LABELS: Record<StrikeReason, string> = {
  insult: "insultes",
  severe: "menaces / contenu grave",
  spam_burst: "spam",
  refused_delivery: "colis refusé",
  repeated_cancel: "annulations répétées",
  manipulation: "manipulation de l'assistant",
  ref_guessing: "tentatives de référence",
};

export type StrikeDecision =
  | { action: "none"; points: number } // duplicate (same order+reason)
  | { action: "warn"; level: 1 | 2; points: number }
  | { action: "blocked"; points: number } // newly blocked by the system now
  | { action: "already_blocked"; points: number }
  | { action: "needs_human"; points: number }; // threshold reached but autoBlockEnabled=false

/** Sum of non-expired strike points for a phone. */
export function activePoints(phone: string, now?: Date): number {
  const normalized = normalizeMaPhone(phone) ?? phone;
  const row = getDb()
    .prepare(
      "SELECT COALESCE(SUM(points), 0) AS total FROM wa_strikes WHERE phone = ? AND expires_at > ?",
    )
    .get(normalized, (now ?? new Date()).toISOString()) as { total: number } | undefined;
  return row?.total ?? 0;
}

/** Active (non-expired) strikes, newest first. */
export function listStrikes(
  phone: string,
  now?: Date,
): Array<{
  id: string;
  reason: StrikeReason;
  points: number;
  detail: string | null;
  createdAt: string;
  expiresAt: string;
}> {
  const normalized = normalizeMaPhone(phone) ?? phone;
  const rows = getDb()
    .prepare(
      `SELECT id, reason_code, points, detail, created_at, expires_at
       FROM wa_strikes
       WHERE phone = ? AND expires_at > ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(normalized, (now ?? new Date()).toISOString()) as Array<{
      id: string;
      reason_code: StrikeReason;
      points: number;
      detail: string | null;
      created_at: string;
      expires_at: string;
    }>;

  return rows.map((r) => ({
    id: r.id,
    reason: r.reason_code,
    points: r.points,
    detail: r.detail,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));
}

/** Admin action (used when unblocking); returns the number of deleted strikes. */
export function clearStrikes(phone: string): number {
  const normalized = normalizeMaPhone(phone) ?? phone;
  return getDb().prepare("DELETE FROM wa_strikes WHERE phone = ?").run(normalized).changes;
}

/**
 * Records one strike and returns the escalation decision, computed inside a single
 * immediate transaction: blocked phones still accrue history but stay blocked,
 * duplicates (same order+reason) are ignored, severe or >= BLOCK_THRESHOLD triggers
 * the auto-block toggle (blocked vs needs_human), otherwise warn level 1 or 2.
 * `detail` is truncated to 300 chars: a short excerpt or classifier label, never
 * the full message body.
 */
export function addStrike(input: {
  phone: string;
  reason: StrikeReason;
  detail?: string;
  messageId?: string;
  orderId?: string;
  now?: Date;
}): StrikeDecision {
  const normalized = normalizeMaPhone(input.phone);
  if (!normalized) {
    throw new Error("Numéro de téléphone invalide.");
  }
  if (!(input.reason in STRIKE_POINTS)) {
    throw new Error("Motif de strike inconnu.");
  }
  const points = STRIKE_POINTS[input.reason];

  const strikeId = randomUUID();
  const detail = input.detail ? input.detail.slice(0, 300) : null;
  const nowDate = input.now ?? new Date();
  const createdAt = nowDate.toISOString();
  const expiresAt = new Date(nowDate.getTime() + STRIKE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  return getDb()
    .transaction((): StrikeDecision => {
      const db = getDb();
      const wasAlreadyBlocked = isPhoneBlocked(normalized);

      // Recorded even for already-blocked phones (history); ignored when the same
      // order+reason already has a strike.
      const inserted = db
        .prepare(
          `INSERT OR IGNORE INTO wa_strikes (id, phone, points, reason_code, detail, message_id, order_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          strikeId,
          normalized,
          points,
          input.reason,
          detail,
          input.messageId ?? null,
          input.orderId ?? null,
          createdAt,
          expiresAt,
        ).changes > 0;

      const total = activePoints(normalized, nowDate);

      if (wasAlreadyBlocked) return { action: "already_blocked", points: total };
      if (!inserted) return { action: "none", points: total };

      if (input.reason === "severe" || total >= BLOCK_THRESHOLD) {
        if (getWhatsAppSettings().autoBlockEnabled) {
          blockPhoneSystem(normalized, `Auto : ${STRIKE_LABELS[input.reason]} (${total} pts)`);
          return { action: "blocked", points: total };
        }
        return { action: "needs_human", points: total };
      }

      if (total >= 2) return { action: "warn", level: 2, points: total };
      if (total === 1) return { action: "warn", level: 1, points: total };
      return { action: "none", points: total };
    })
    .immediate();
}
