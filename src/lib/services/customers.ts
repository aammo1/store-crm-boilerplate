import { getDb } from "@/lib/db";
import { normalizeMaPhone } from "@/lib/phone";

export interface BlockedPhone {
  phone: string;
  reason: string;
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
  source: "agent" | "system";
}

export class BlocklistError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export const BLOCK_REASON_MAX = 500;

interface Row {
  phone: string;
  reason: string;
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
  source: "agent" | "system";
}

const SELECT = `SELECT bp.phone, bp.reason, bp.created_at, bp.created_by, bp.source, u.name AS created_by_name
  FROM blocked_phones bp LEFT JOIN users u ON u.id = bp.created_by`;

function map(row: Row): BlockedPhone {
  return {
    phone: row.phone,
    reason: row.reason,
    createdAt: row.created_at,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    source: row.source === "system" ? "system" : "agent",
  };
}

export function getBlockedPhone(phone: string): BlockedPhone | null {
  const normalized = normalizeMaPhone(phone);
  if (!normalized) return null;
  const row = getDb().prepare(`${SELECT} WHERE bp.phone = ?`).get(normalized) as Row | undefined;
  return row ? map(row) : null;
}

export function isPhoneBlocked(phone: string): boolean {
  return getBlockedPhone(phone) !== null;
}

export function listBlockedPhones(): BlockedPhone[] {
  return (getDb().prepare(`${SELECT} ORDER BY bp.created_at DESC, bp.phone`).all() as Row[]).map(map);
}

/** Adds a phone; an already blocked phone keeps its original reason (created: false). */
export function blockPhone(
  rawPhone: string,
  rawReason: string,
  userId: string,
): { phone: string; created: boolean } {
  const phone = normalizeMaPhone(rawPhone);
  if (!phone) throw new BlocklistError("Numéro invalide.", 400);
  const reason = rawReason.trim();
  if (reason.length < 1 || reason.length > BLOCK_REASON_MAX) {
    throw new BlocklistError("Motif requis (500 caractères maximum).", 400);
  }
  const result = getDb()
    .prepare("INSERT OR IGNORE INTO blocked_phones (phone, reason, created_by, created_at, source) VALUES (?, ?, ?, ?, 'agent')")
    .run(phone, reason, userId, new Date().toISOString());
  return { phone, created: result.changes > 0 };
}

/** Adds a phone via system automation; source='system' and created_by=NULL. Returns true if created, false if already blocked. */
export function blockPhoneSystem(rawPhone: string, rawReason: string): boolean {
  const phone = normalizeMaPhone(rawPhone);
  if (!phone) throw new BlocklistError("Numéro invalide.", 400);
  const reason = rawReason.trim();
  if (reason.length < 1 || reason.length > BLOCK_REASON_MAX) {
    throw new BlocklistError("Motif requis (500 caractères maximum).", 400);
  }
  const result = getDb()
    .prepare(
      "INSERT OR IGNORE INTO blocked_phones (phone, reason, created_by, created_at, source) VALUES (?, ?, NULL, ?, 'system')",
    )
    .run(phone, reason, new Date().toISOString());
  return result.changes > 0;
}

export function unblockPhone(rawPhone: string): boolean {
  const phone = normalizeMaPhone(rawPhone);
  if (!phone) throw new BlocklistError("Numéro invalide.", 400);
  return getDb().prepare("DELETE FROM blocked_phones WHERE phone = ?").run(phone).changes > 0;
}
