import crypto from "node:crypto";
import { getDb } from "@/lib/db";
import { normalizeMaPhoneCore } from "@/lib/phone-core";
import { extractLast4, extractOrderRefs, orderRefFromOrderId } from "@/lib/whatsapp/phone";

export type WaLanguage = "fr" | "ar" | "darija_latin" | "darija_arabic";

export interface WaConversation {
  id: string;
  phone: string;
  jid: string | null;
  displayName: string | null;
  language: WaLanguage | null;
  mode: "ai" | "human";
  needsHuman: boolean;
  handoffReason: string | null;
  takenOverBy: string | null;
  takenOverAt?: string | null;
  aiPausedUntil: string | null;
  identityLockedUntil: string | null;
  noWhatsapp: boolean;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastAgentReplyAt?: string | null;
  lastPreview: string | null;
  unreadCount: number;
  blocked: boolean;
  strikePoints?: number;
  orders: Array<{ orderId: string; ref: string; access: "full" | "status_only"; status: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface WaMessageView {
  id: string;
  conversationId: string;
  direction: "in" | "out";
  author: "customer" | "ai" | "agent" | "system";
  authorUserId: string | null;
  waMessageId: string | null;
  kind: "text" | "audio" | "image" | "other";
  body: string | null;
  transcript: string | null;
  mediaPath: string | null;
  mediaMime: string | null;
  mediaSha256: string | null;
  mediaBytes: number | null;
  mediaDeletedAt: string | null;
  outboxId: string | null;
  createdAt: string;
}

export type LinkResult = {
  linked: Array<{ orderId: string; access: "full" | "status_only" }>;
  failed: boolean;
  locked: boolean;
  newlyLocked: boolean;
};

export interface ListFilter {
  view: "todo" | "mine" | "all";
  userId: string;
  role: "admin" | "agent";
  q?: string;
  cursor?: string;
  limit?: number;
}

function samePhone(p1: string, p2: string): boolean {
  if (p1 === p2) return true;
  const n1 = normalizeMaPhoneCore(p1) ?? p1.replace(/\D/g, "");
  const n2 = normalizeMaPhoneCore(p2) ?? p2.replace(/\D/g, "");
  return n1 === n2;
}

interface ConversationRow {
  id: string;
  phone: string;
  jid: string | null;
  display_name: string | null;
  language: string | null;
  mode: "ai" | "human";
  needs_human: number;
  handoff_reason: string | null;
  taken_over_by: string | null;
  taken_over_at: string | null;
  ai_paused_until: string | null;
  identity_locked_until: string | null;
  no_whatsapp: number;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_agent_reply_at: string | null;
  last_preview: string | null;
  unread_count: number;
  created_at: string;
  updated_at: string;
  blocked: number;
  strike_points?: number | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  direction: "in" | "out";
  author: "customer" | "ai" | "agent" | "system";
  author_user_id: string | null;
  wa_message_id: string | null;
  kind: "text" | "audio" | "image" | "other";
  body: string | null;
  transcript: string | null;
  media_path: string | null;
  media_mime: string | null;
  media_sha256: string | null;
  media_bytes: number | null;
  media_deleted_at: string | null;
  outbox_id: string | null;
  created_at: string;
}

function rowToConversation(row: ConversationRow, orders: Array<{ orderId: string; ref: string; access: "full" | "status_only"; status: string }>): WaConversation {
  return {
    id: row.id,
    phone: row.phone,
    jid: row.jid ?? null,
    displayName: row.display_name ?? null,
    language: (row.language as WaLanguage | null) ?? null,
    mode: row.mode,
    needsHuman: Boolean(row.needs_human),
    handoffReason: row.handoff_reason ?? null,
    takenOverBy: row.taken_over_by ?? null,
    takenOverAt: row.taken_over_at ?? null,
    aiPausedUntil: row.ai_paused_until ?? null,
    identityLockedUntil: row.identity_locked_until ?? null,
    noWhatsapp: Boolean(row.no_whatsapp),
    lastInboundAt: row.last_inbound_at ?? null,
    lastOutboundAt: row.last_outbound_at ?? null,
    lastAgentReplyAt: row.last_agent_reply_at ?? null,
    lastPreview: row.last_preview ?? null,
    unreadCount: Number(row.unread_count ?? 0),
    blocked: Boolean(row.blocked),
    strikePoints: Number(row.strike_points ?? 0),
    orders,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Creates or loads a conversation for the given Moroccan phone number.
 * Automatically links every non-archived order belonging to this phone number with full access.
 */
export function getOrCreateConversation(
  phone: string,
  jid: string | null,
  displayName: string | null,
): WaConversation {
  const normPhone = normalizeMaPhoneCore(phone) || phone.trim();
  const db = getDb();
  const now = new Date().toISOString();

  const convId = db.transaction(() => {
    const existing = db
      .prepare("SELECT id FROM wa_conversations WHERE phone = ?")
      .get(normPhone) as { id: string } | undefined;

    let id: string;
    if (!existing) {
      id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO wa_conversations (
          id, phone, jid, display_name, mode, needs_human, unread_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'ai', 0, 0, ?, ?)
      `).run(id, normPhone, jid ?? null, displayName ?? null, now, now);
    } else {
      id = existing.id;
      if (jid !== undefined && jid !== null || displayName !== undefined && displayName !== null) {
        db.prepare(`
          UPDATE wa_conversations
          SET jid = COALESCE(?, jid),
              display_name = COALESCE(?, display_name)
          WHERE id = ?
        `).run(jid ?? null, displayName ?? null, id);
      }
    }

    // Auto-link every non-archived order where customer_phone matches phone
    const localPhone = normPhone.startsWith("+212") ? "0" + normPhone.slice(4) : normPhone;
    const strippedPhone = normPhone.replace(/\D/g, "");
    const strippedLocal = localPhone.replace(/\D/g, "");

    db.prepare(`
      INSERT OR IGNORE INTO wa_conversation_orders (conversation_id, order_id, access, linked_via, created_at)
      SELECT ?, id, 'full', 'phone', ?
      FROM orders
      WHERE archived_at IS NULL
        AND (
          customer_phone = ?
          OR customer_phone = ?
          OR replace(replace(replace(replace(customer_phone, ' ', ''), '-', ''), '(', ''), ')', '') = ?
          OR replace(replace(replace(replace(customer_phone, ' ', ''), '-', ''), '(', ''), ')', '') = ?
        )
    `).run(id, now, normPhone, localPhone, strippedPhone, strippedLocal);

    return id;
  })();

  const conv = getConversation(convId);
  if (!conv) {
    throw new Error("Impossible de charger la conversation créée.");
  }
  return conv;
}

/**
 * Returns the conversation by its primary UUID, including linked orders, blocked status, and strike points.
 */
export function getConversation(id: string): WaConversation | null {
  const db = getDb();
  const nowIso = new Date().toISOString();

  const row = db
    .prepare(`
      SELECT
        c.id, c.phone, c.jid, c.display_name, c.language, c.mode,
        c.needs_human, c.handoff_reason, c.taken_over_by, c.taken_over_at,
        c.ai_paused_until, c.identity_failures, c.identity_locked_until,
        c.no_whatsapp, c.last_inbound_at, c.last_outbound_at, c.last_agent_reply_at,
        c.last_preview, c.unread_count, c.created_at, c.updated_at,
        (bp.phone IS NOT NULL) AS blocked,
        (SELECT COALESCE(SUM(points), 0) FROM wa_strikes s WHERE s.phone = c.phone AND s.expires_at > ?) AS strike_points
      FROM wa_conversations c
      LEFT JOIN blocked_phones bp ON bp.phone = c.phone
      WHERE c.id = ?
    `)
    .get(nowIso, id) as ConversationRow | undefined;

  if (!row) return null;

  const orderRows = db
    .prepare(`
      SELECT co.order_id, co.access, o.confirmation_status
      FROM wa_conversation_orders co
      JOIN orders o ON o.id = co.order_id
      WHERE co.conversation_id = ?
      ORDER BY co.created_at ASC
    `)
    .all(id) as Array<{ order_id: string; access: "full" | "status_only"; confirmation_status: string }>;

  const orders = orderRows.map((o) => ({
    orderId: o.order_id,
    ref: orderRefFromOrderId(o.order_id),
    access: o.access,
    status: o.confirmation_status,
  }));

  return rowToConversation(row, orders);
}

/**
 * Returns the conversation matching the given phone number, or null.
 */
export function getConversationByPhone(phone: string): WaConversation | null {
  const normPhone = normalizeMaPhoneCore(phone) || phone.trim();
  const db = getDb();
  const row = db
    .prepare("SELECT id FROM wa_conversations WHERE phone = ?")
    .get(normPhone) as { id: string } | undefined;

  if (!row) return null;
  return getConversation(row.id);
}

/**
 * Inserts an inbound customer message into wa_messages.
 * Deduplicates by wa_message_id (returns { duplicate: true } without bumping unread count or preview).
 * On new message, increments unread_count, updates last_inbound_at and last_preview.
 */
export function insertInboundMessage(input: {
  conversationId: string;
  waMessageId: string | null;
  kind: "text" | "audio" | "image" | "other";
  body?: string | null;
  mediaPath?: string | null;
  mediaMime?: string | null;
  mediaSha256?: string | null;
  mediaBytes?: number | null;
  createdAt?: string;
}): { id: string; duplicate: boolean } {
  const db = getDb();
  return db.transaction(() => {
    if (input.waMessageId) {
      const existing = db
        .prepare("SELECT id FROM wa_messages WHERE wa_message_id = ?")
        .get(input.waMessageId) as { id: string } | undefined;
      if (existing) {
        return { id: existing.id, duplicate: true };
      }
    }

    const id = crypto.randomUUID();
    const now = input.createdAt ?? new Date().toISOString();

    let preview: string | null = null;
    if (input.body && input.body.trim().length > 0) {
      preview = input.body.trim().slice(0, 80);
    } else if (input.kind === "audio") {
      preview = "🎤 Audio";
    } else if (input.kind === "image") {
      preview = "📷 Image";
    } else if (input.kind === "other") {
      preview = "Autre message";
    }

    db.prepare(`
      INSERT INTO wa_messages (
        id, conversation_id, direction, author, author_user_id,
        wa_message_id, kind, body, transcript, media_path, media_mime,
        media_sha256, media_bytes, media_deleted_at, outbox_id, created_at
      ) VALUES (?, ?, 'in', 'customer', NULL, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?)
    `).run(
      id,
      input.conversationId,
      input.waMessageId ?? null,
      input.kind,
      input.body ?? null,
      input.mediaPath ?? null,
      input.mediaMime ?? null,
      input.mediaSha256 ?? null,
      input.mediaBytes ?? null,
      now,
    );

    db.prepare(`
      UPDATE wa_conversations
      SET unread_count = unread_count + 1,
          last_inbound_at = ?,
          last_preview = COALESCE(?, last_preview),
          updated_at = ?
      WHERE id = ?
    `).run(now, preview, now, input.conversationId);

    return { id, duplicate: false };
  })();
}

/**
 * Updates the transcript of a message (e.g. after speech-to-text processing).
 * Also updates last_preview on conversation if it was placeholder audio.
 */
export function setMessageTranscript(messageId: string, transcript: string): void {
  const db = getDb();
  db.transaction(() => {
    const msg = db
      .prepare("SELECT conversation_id FROM wa_messages WHERE id = ?")
      .get(messageId) as { conversation_id: string } | undefined;
    if (!msg) return;

    db.prepare("UPDATE wa_messages SET transcript = ? WHERE id = ?").run(transcript, messageId);

    const conv = db
      .prepare("SELECT last_preview FROM wa_conversations WHERE id = ?")
      .get(msg.conversation_id) as { last_preview: string | null } | undefined;

    if (conv && (conv.last_preview === "🎤 Audio" || !conv.last_preview)) {
      const preview = transcript.trim().slice(0, 80);
      if (preview) {
        db.prepare("UPDATE wa_conversations SET last_preview = ?, updated_at = ? WHERE id = ?").run(
          preview,
          new Date().toISOString(),
          msg.conversation_id,
        );
      }
    }
  })();
}

/**
 * Updates media storage columns on an existing message.
 */
export function updateMessageMedia(
  messageId: string,
  media: {
    mediaPath?: string | null;
    mediaMime?: string | null;
    mediaSha256?: string | null;
    mediaBytes?: number | null;
  },
): void {
  const db = getDb();
  db.prepare(`
    UPDATE wa_messages
    SET media_path = COALESCE(?, media_path),
        media_mime = COALESCE(?, media_mime),
        media_sha256 = COALESCE(?, media_sha256),
        media_bytes = COALESCE(?, media_bytes)
    WHERE id = ?
  `).run(
    media.mediaPath ?? null,
    media.mediaMime ?? null,
    media.mediaSha256 ?? null,
    media.mediaBytes ?? null,
    messageId,
  );
}

/**
 * Returns messages in chronological order (oldest first, newest last).
 * Limit defaults to 50, maximum 200.
 */
export function listMessages(
  conversationId: string,
  opts?: { before?: string; limit?: number },
): WaMessageView[] {
  const db = getDb();
  const limit = Math.min(Math.max(1, opts?.limit ?? 50), 200);

  let query: string;
  const params: unknown[] = [conversationId];

  if (opts?.before) {
    const beforeMsg = db
      .prepare("SELECT id, created_at FROM wa_messages WHERE id = ?")
      .get(opts.before) as { id: string; created_at: string } | undefined;

    if (beforeMsg) {
      query = `
        SELECT * FROM wa_messages
        WHERE conversation_id = ?
          AND (created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `;
      params.push(beforeMsg.created_at, beforeMsg.created_at, beforeMsg.id, limit);
    } else {
      query = `
        SELECT * FROM wa_messages
        WHERE conversation_id = ?
          AND created_at < ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `;
      params.push(opts.before, limit);
    }
  } else {
    query = `
      SELECT * FROM wa_messages
      WHERE conversation_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `;
    params.push(limit);
  }

  const rows = db.prepare(query).all(...params) as MessageRow[];
  rows.reverse();

  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    direction: r.direction,
    author: r.author,
    authorUserId: r.author_user_id ?? null,
    waMessageId: r.wa_message_id ?? null,
    kind: r.kind,
    body: r.body ?? null,
    transcript: r.transcript ?? null,
    mediaPath: r.media_path ?? null,
    mediaMime: r.media_mime ?? null,
    mediaSha256: r.media_sha256 ?? null,
    mediaBytes: r.media_bytes ?? null,
    mediaDeletedAt: r.media_deleted_at ?? null,
    outboxId: r.outbox_id ?? null,
    createdAt: r.created_at,
  }));
}

/**
 * Returns recent message context for the AI prompt in chronological order.
 * Maps customer messages to "user" and agent/ai/system to "assistant".
 */
export function recentContext(
  conversationId: string,
  maxMessages = 20,
): Array<{ role: "user" | "assistant"; text: string; at: string }> {
  const db = getDb();
  const limit = Math.max(1, maxMessages);

  const rows = db
    .prepare(`
      SELECT author, kind, body, transcript, created_at
      FROM wa_messages
      WHERE conversation_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `)
    .all(conversationId, limit) as Array<{
    author: "customer" | "ai" | "agent" | "system";
    kind: "text" | "audio" | "image" | "other";
    body: string | null;
    transcript: string | null;
    created_at: string;
  }>;

  rows.reverse();

  return rows.map((r) => {
    const role: "user" | "assistant" = r.author === "customer" ? "user" : "assistant";
    let text = r.body ?? r.transcript;
    if (!text) {
      if (r.kind === "image") text = "[image]";
      else if (r.kind === "audio") text = "[audio]";
      else text = "";
    }
    return {
      role,
      text,
      at: r.created_at,
    };
  });
}

/**
 * Sets the detected or selected language for the conversation.
 */
export function setLanguage(conversationId: string, language: WaLanguage): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE wa_conversations SET language = ?, updated_at = ? WHERE id = ?").run(
    language,
    now,
    conversationId,
  );
}

/**
 * Human agent takes over conversation.
 * Sets mode to 'human', records agent ID and timestamp, and clears needs_human.
 */
export function takeOver(conversationId: string, userId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE wa_conversations
    SET mode = 'human',
        taken_over_by = ?,
        taken_over_at = ?,
        needs_human = 0,
        handoff_reason = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(userId, now, now, conversationId);
}

/**
 * Releases a human-mode conversation back to the AI agent.
 */
export function releaseToAi(conversationId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE wa_conversations
    SET mode = 'ai',
        taken_over_by = NULL,
        taken_over_at = NULL,
        needs_human = 0,
        handoff_reason = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(now, conversationId);
}

/**
 * Flags a conversation as needing human intervention.
 * Keeps/sets mode='human' so the AI stops replying, and clears taken_over_by.
 */
export function flagHandoff(conversationId: string, reason: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE wa_conversations
    SET mode = 'human',
        needs_human = 1,
        handoff_reason = ?,
        taken_over_by = NULL,
        taken_over_at = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(reason, now, conversationId);
}

/**
 * Automatically releases stale human conversations back to AI if:
 * - mode is 'human'
 * - needs_human is 0 (i.e. not waiting for an unassigned agent escalation)
 * - last agent activity (last_agent_reply_at or taken_over_at) is older than `hours`
 */
export function autoReleaseStale(hours: number, now?: Date): number {
  const db = getDb();
  const currentDate = now ?? new Date();
  const cutoff = new Date(currentDate.getTime() - hours * 3600 * 1000).toISOString();
  const nowIso = currentDate.toISOString();

  const info = db.prepare(`
    UPDATE wa_conversations
    SET mode = 'ai',
        taken_over_by = NULL,
        taken_over_at = NULL,
        handoff_reason = NULL,
        updated_at = ?
    WHERE mode = 'human'
      AND needs_human = 0
      AND COALESCE(last_agent_reply_at, taken_over_at) < ?
  `).run(nowIso, cutoff);

  return info.changes;
}

/**
 * Pauses the AI for this conversation until the specified ISO timestamp.
 */
export function pauseAi(conversationId: string, untilIso: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE wa_conversations SET ai_paused_until = ?, updated_at = ? WHERE id = ?").run(
    untilIso,
    now,
    conversationId,
  );
}

/**
 * Marks all incoming messages in the conversation as read by clearing unread_count.
 */
export function markRead(conversationId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE wa_conversations SET unread_count = 0, updated_at = ? WHERE id = ?").run(
    now,
    conversationId,
  );
}

/**
 * Marks a phone number as not having WhatsApp (upserts row with no_whatsapp=1).
 */
export function markNoWhatsapp(phone: string): void {
  const normPhone = normalizeMaPhoneCore(phone) || phone.trim();
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO wa_conversations (
      id, phone, no_whatsapp, mode, needs_human, unread_count, created_at, updated_at
    ) VALUES (?, ?, 1, 'ai', 0, 0, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET no_whatsapp = 1, updated_at = excluded.updated_at
  `).run(crypto.randomUUID(), normPhone, now, now);
}

/**
 * Notes that an agent replied, recording timestamp and resetting unread count.
 */
export function noteAgentReply(conversationId: string, at: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE wa_conversations
    SET last_agent_reply_at = ?,
        last_outbound_at = ?,
        unread_count = 0,
        updated_at = ?
    WHERE id = ?
  `).run(at, at, at, conversationId);
}

/** Calendar day (YYYY-MM-DD) in Africa/Casablanca for an ISO timestamp. */
const CASABLANCA_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Casablanca",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function casablancaDay(iso: string): string {
  return CASABLANCA_DAY.format(new Date(iso));
}

/**
 * Logs a contact entry into order_contacts with channel='whatsapp' and outcome='note'.
 * Called once per inbound message per linked full-access order; deduplicated per
 * Casablanca calendar day so worker retries/replays never create duplicate rows
 * for the same conversation day.
 */
export function logOrderContact(orderId: string, agentId: string | null, note: string, at?: Date): void {
  const db = getDb();
  const when = (at ?? new Date()).toISOString();
  const cleanNote = note.trim().slice(0, 500);
  const day = casablancaDay(when);

  db.transaction(() => {
    const orderExists = db.prepare("SELECT 1 FROM orders WHERE id = ?").get(orderId);
    if (!orderExists) return;

    const sameDay = db
      .prepare(`
        SELECT created_at FROM order_contacts
        WHERE order_id = ? AND channel = 'whatsapp' AND outcome = 'note'
      `)
      .all(orderId) as Array<{ created_at: string }>;
    for (const row of sameDay) {
      if (casablancaDay(row.created_at) === day) return;
    }

    db.prepare(`
      INSERT INTO order_contacts (id, order_id, agent_id, channel, outcome, note, next_callback_at, created_at)
      VALUES (?, ?, ?, 'whatsapp', 'note', ?, NULL, ?)
    `).run(crypto.randomUUID(), orderId, agentId, cleanNote, when);
  })();
}

/**
 * Extracts order references from user message and attempts to link orders to the conversation.
 * Privacy rules:
 * - Order phone matches conversation phone -> full access ('ref_message')
 * - Different phone and last 4 digits match -> status_only access ('ref_last4')
 * - No match / invalid ref -> failure.
 * - 3 consecutive messages with refs and zero successful links lock identity checks for 24h.
 */
export function linkOrdersFromMessage(
  conversationId: string,
  text: string,
  now?: Date,
): LinkResult {
  const db = getDb();
  const currentDate = now ?? new Date();
  const nowIso = currentDate.toISOString();

  return db.transaction(() => {
    const conv = db
      .prepare("SELECT id, phone, identity_failures, identity_locked_until FROM wa_conversations WHERE id = ?")
      .get(conversationId) as
      | { id: string; phone: string; identity_failures: number; identity_locked_until: string | null }
      | undefined;

    if (!conv) {
      return { linked: [], failed: false, locked: false, newlyLocked: false };
    }

    // 1. If identity_locked_until > now, return without querying
    if (conv.identity_locked_until && conv.identity_locked_until > nowIso) {
      return { linked: [], failed: false, locked: true, newlyLocked: false };
    }

    // 2. Extract refs. If none, return
    const refs = extractOrderRefs(text);
    if (refs.length === 0) {
      return { linked: [], failed: false, locked: false, newlyLocked: false };
    }

    // 3. For each ref, match orders
    const last4 = extractLast4(text);
    const linked: Array<{ orderId: string; access: "full" | "status_only" }> = [];
    const convPhone = conv.phone;

    for (const ref of refs) {
      const orders = db
        .prepare("SELECT id, customer_phone FROM orders WHERE upper(id) LIKE ? || '%' AND archived_at IS NULL")
        .all(ref) as Array<{ id: string; customer_phone: string }>;

      if (orders.length === 0) {
        continue;
      }

      for (const order of orders) {
        let access: "full" | "status_only" | null = null;
        let linkedVia: "ref_message" | "ref_last4" | null = null;

        if (samePhone(order.customer_phone, convPhone)) {
          access = "full";
          linkedVia = "ref_message";
        } else if (last4) {
          const orderDigits = order.customer_phone.replace(/\D/g, "");
          const orderLast4 = orderDigits.slice(-4);
          if (last4 === orderLast4) {
            access = "status_only";
            linkedVia = "ref_last4";
          }
        }

        if (access && linkedVia) {
          // Access never downgrades: report the effective (highest) access.
          const existing = db
            .prepare("SELECT access FROM wa_conversation_orders WHERE conversation_id = ? AND order_id = ?")
            .get(conversationId, order.id) as { access: string } | undefined;
          const effective = existing?.access === "full" || access === "full" ? "full" : "status_only";

          db.prepare(`
            INSERT INTO wa_conversation_orders (conversation_id, order_id, access, linked_via, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(conversation_id, order_id) DO UPDATE SET
              access = CASE WHEN wa_conversation_orders.access = 'full' THEN 'full' ELSE excluded.access END,
              linked_via = CASE WHEN wa_conversation_orders.access = 'full' THEN wa_conversation_orders.linked_via ELSE excluded.linked_via END
          `).run(conversationId, order.id, access, linkedVia, nowIso);

          if (!linked.some((l) => l.orderId === order.id)) {
            linked.push({ orderId: order.id, access: effective });
          }
        }
      }
    }

    // 4. If message has refs but no successful link: increment failure counter
    if (linked.length === 0) {
      const failures = conv.identity_failures + 1;
      if (failures >= 3) {
        const lockedUntil = new Date(currentDate.getTime() + 24 * 3600 * 1000).toISOString();
        db.prepare(`
          UPDATE wa_conversations
          SET identity_failures = 0,
              identity_locked_until = ?,
              updated_at = ?
          WHERE id = ?
        `).run(lockedUntil, nowIso, conversationId);

        return { linked: [], failed: true, locked: true, newlyLocked: true };
      } else {
        db.prepare(`
          UPDATE wa_conversations
          SET identity_failures = ?,
              updated_at = ?
          WHERE id = ?
        `).run(failures, nowIso, conversationId);

        return { linked: [], failed: true, locked: false, newlyLocked: false };
      }
    }

    // Reset failure counter on success
    if (conv.identity_failures > 0) {
      db.prepare("UPDATE wa_conversations SET identity_failures = 0, updated_at = ? WHERE id = ?").run(
        nowIso,
        conversationId,
      );
    }

    return { linked, failed: false, locked: false, newlyLocked: false };
  })();
}

/**
 * Returns access level ("full" | "status_only") for an order in a conversation, or null if not linked.
 */
export function orderAccess(
  conversationId: string,
  orderId: string,
): "full" | "status_only" | null {
  const db = getDb();
  const row = db
    .prepare("SELECT access FROM wa_conversation_orders WHERE conversation_id = ? AND order_id = ?")
    .get(conversationId, orderId) as { access: "full" | "status_only" } | undefined;

  return row ? row.access : null;
}

/**
 * Explicit agent link: grants full access to the order.
 */
export function linkOrderByAgent(conversationId: string, orderId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.transaction(() => {
    const order = db.prepare("SELECT id FROM orders WHERE id = ?").get(orderId);
    if (!order) {
      throw new Error("Commande introuvable.");
    }
    db.prepare(`
      INSERT INTO wa_conversation_orders (conversation_id, order_id, access, linked_via, created_at)
      VALUES (?, ?, 'full', 'agent', ?)
      ON CONFLICT(conversation_id, order_id) DO UPDATE SET access = 'full', linked_via = 'agent'
    `).run(conversationId, orderId, now);

    db.prepare("UPDATE wa_conversations SET updated_at = ? WHERE id = ?").run(now, conversationId);
  })();
}

/**
 * Checks whether an agent or admin has permission to access a conversation.
 * - Admin sees everything.
 * - Agent sees conversation if any linked order is assigned to them, or no linked order is assigned to anyone.
 */
export function canAccessConversation(
  conversationId: string,
  userId: string,
  role: "admin" | "agent",
): boolean {
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM wa_conversations WHERE id = ?").get(conversationId);
  if (!exists) return false;
  if (role === "admin") return true;

  const accessible = db
    .prepare(`
      SELECT 1 FROM wa_conversations c
      WHERE c.id = ?
        AND (
          EXISTS (
            SELECT 1 FROM wa_conversation_orders co
            JOIN orders o ON o.id = co.order_id
            WHERE co.conversation_id = c.id AND o.assigned_to = ?
          )
          OR NOT EXISTS (
            SELECT 1 FROM wa_conversation_orders co
            JOIN orders o ON o.id = co.order_id
            WHERE co.conversation_id = c.id AND o.assigned_to IS NOT NULL
          )
        )
    `)
    .get(conversationId, userId);

  return Boolean(accessible);
}

/**
 * Lists conversations with filter, search, agent visibility scoping and cursor pagination.
 */
export function listConversations(filter: ListFilter): {
  items: WaConversation[];
  nextCursor: string | null;
} {
  const db = getDb();
  const nowIso = new Date().toISOString();
  const limit = Math.min(Math.max(1, filter.limit ?? 30), 100);

  const where: string[] = [];
  const whereParams: unknown[] = [];

  // View filter
  if (filter.view === "todo") {
    where.push("c.needs_human = 1");
  } else if (filter.view === "mine") {
    where.push(`(
      c.taken_over_by = ?
      OR EXISTS (
        SELECT 1 FROM wa_conversation_orders co
        JOIN orders o ON o.id = co.order_id
        WHERE co.conversation_id = c.id AND o.assigned_to = ?
      )
    )`);
    whereParams.push(filter.userId, filter.userId);
  }

  // Agent visibility scoping
  if (filter.role === "agent" && filter.view !== "mine") {
    where.push(`(
      EXISTS (
        SELECT 1 FROM wa_conversation_orders co
        JOIN orders o ON o.id = co.order_id
        WHERE co.conversation_id = c.id AND o.assigned_to = ?
      )
      OR NOT EXISTS (
        SELECT 1 FROM wa_conversation_orders co
        JOIN orders o ON o.id = co.order_id
        WHERE co.conversation_id = c.id AND o.assigned_to IS NOT NULL
      )
    )`);
    whereParams.push(filter.userId);
  }

  // Search query
  if (filter.q?.trim()) {
    const qTrim = filter.q.trim();
    const digits = qTrim.replace(/\D/g, "");
    if (digits.length >= 4) {
      const phoneCore = digits.startsWith("212") ? digits.slice(3) : digits.replace(/^0+/, "");
      const searchDigits = phoneCore.length >= 4 ? phoneCore : digits;
      where.push("(c.display_name LIKE ? OR c.phone LIKE ?)");
      whereParams.push(`%${qTrim}%`, `%${searchDigits}%`);
    } else {
      where.push("c.display_name LIKE ?");
      whereParams.push(`%${qTrim}%`);
    }
  }

  // Cursor pagination: updated_at|id
  if (filter.cursor) {
    const pipeIdx = filter.cursor.indexOf("|");
    if (pipeIdx !== -1) {
      const cursorUpdatedAt = filter.cursor.slice(0, pipeIdx);
      const cursorId = filter.cursor.slice(pipeIdx + 1);
      where.push("(c.updated_at < ? OR (c.updated_at = ? AND c.id < ?))");
      whereParams.push(cursorUpdatedAt, cursorUpdatedAt, cursorId);
    }
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const rows = db
    .prepare(`
      SELECT
        c.id, c.phone, c.jid, c.display_name, c.language, c.mode,
        c.needs_human, c.handoff_reason, c.taken_over_by, c.taken_over_at,
        c.ai_paused_until, c.identity_failures, c.identity_locked_until,
        c.no_whatsapp, c.last_inbound_at, c.last_outbound_at, c.last_agent_reply_at,
        c.last_preview, c.unread_count, c.created_at, c.updated_at,
        (bp.phone IS NOT NULL) AS blocked,
        (SELECT COALESCE(SUM(points), 0) FROM wa_strikes s WHERE s.phone = c.phone AND s.expires_at > ?) AS strike_points
      FROM wa_conversations c
      LEFT JOIN blocked_phones bp ON bp.phone = c.phone
      ${whereSql}
      ORDER BY c.updated_at DESC, c.id DESC
      LIMIT ?
    `)
    .all(nowIso, ...whereParams, limit + 1) as ConversationRow[];

  const hasMore = rows.length > limit;
  const pagedRows = hasMore ? rows.slice(0, limit) : rows;
  const lastRow = pagedRows.length > 0 ? pagedRows[pagedRows.length - 1] : null;
  const nextCursor = hasMore && lastRow ? `${lastRow.updated_at}|${lastRow.id}` : null;

  if (pagedRows.length === 0) {
    return { items: [], nextCursor: null };
  }

  const convIds = pagedRows.map((r) => r.id);
  const placeholders = convIds.map(() => "?").join(",");
  const orderRows = db
    .prepare(`
      SELECT co.conversation_id, co.order_id, co.access, o.confirmation_status
      FROM wa_conversation_orders co
      JOIN orders o ON o.id = co.order_id
      WHERE co.conversation_id IN (${placeholders})
      ORDER BY co.created_at ASC
    `)
    .all(...convIds) as Array<{
    conversation_id: string;
    order_id: string;
    access: "full" | "status_only";
    confirmation_status: string;
  }>;

  const ordersByConv = new Map<
    string,
    Array<{ orderId: string; ref: string; access: "full" | "status_only"; status: string }>
  >();

  for (const o of orderRows) {
    let list = ordersByConv.get(o.conversation_id);
    if (!list) {
      list = [];
      ordersByConv.set(o.conversation_id, list);
    }
    list.push({
      orderId: o.order_id,
      ref: orderRefFromOrderId(o.order_id),
      access: o.access,
      status: o.confirmation_status,
    });
  }

  const items = pagedRows.map((r) => rowToConversation(r, ordersByConv.get(r.id) ?? []));

  return { items, nextCursor };
}
