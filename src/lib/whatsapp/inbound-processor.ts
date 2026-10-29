/**
 * Inbound WhatsApp processor: turns one stored webhook event into stored
 * messages, safety decisions and (optionally) an AI reply. Pure orchestration
 * over the WhatsApp services — no direct outbox SQL, no model calls beyond the
 * classifier, the transcriber and the agent.
 *
 * The worker claims the oldest `wa_inbound_events` row and hands it here; this
 * module marks the event itself (done / ignored / retry) and never logs phone
 * numbers or message bodies.
 */
import { getDb } from "@/lib/db";
import rawStoreConfig from "../../../store.config";
import { log } from "@/lib/log";
import { isPhoneBlocked } from "@/lib/services/customers";
import { getStoreSettings } from "@/lib/services/store-settings";
import {
  flagHandoff,
  getOrCreateConversation,
  hasAiReplyForMessage,
  insertInboundMessage,
  linkOrdersFromMessage,
  logOrderContact,
  pauseAi,
  pendingOutboundReplies,
  setMessageTranscript,
  setLanguage,
  strikeRecordedForMessage,
  updateMessageMedia,
  type LinkResult,
  type WaConversation,
  type WaLanguage,
} from "@/lib/services/whatsapp-conversations";
import {
  markInboundDone,
  markInboundIgnored,
  markInboundRetry,
  type ClaimedInbound,
} from "@/lib/services/whatsapp-inbound-events";
import {
  effectiveAssistantName,
  getWhatsAppConnectionState,
  getWhatsAppSettings,
  setWhatsAppConnectionState,
} from "@/lib/services/whatsapp-settings";
import { enqueueOutbox, type EnqueueInput } from "@/lib/services/whatsapp-outbox";
import { addStrike, STRIKE_LABELS, type StrikeReason, type StrikeDecision } from "@/lib/services/whatsapp-strikes";
import { msgAdminAutoBlocked, msgHandoff, msgStrikeWarning } from "@/lib/whatsapp/copy";
import { MediaError, fetchInboundMedia, imageForVision, readMedia, type StoredMedia } from "@/lib/whatsapp/media";
import { jidToPhone, maskPhone } from "@/lib/whatsapp/phone";
import { casablancaParts } from "@/lib/whatsapp/pacing";
import { parseEvolutionMessage } from "@/lib/whatsapp/parse";
import { aiBudgetAvailable } from "@/lib/services/whatsapp-ai-usage";
import { classifyInbound, type Classification } from "@/lib/whatsapp/ai/classify";
import { transcribeAudio } from "@/lib/whatsapp/ai/transcribe";
import { AiBudgetExceededError, AiUnavailableError } from "@/lib/whatsapp/ai/provider";
import { runWhatsAppAgent } from "@/lib/whatsapp/ai/agent";

/** Spam burst window: strictly more than 15 inbound messages in 2 minutes. */
const SPAM_WINDOW_MS = 2 * 60 * 1000;
const SPAM_BURST_THRESHOLD = 15;
const SPAM_PAUSE_MS = 30 * 60 * 1000;

/** Agent turn bounds: at most 10 unreplied inbound messages, last 2 images as vision input. */
const AGENT_NEW_MESSAGES_MAX = 10;
const AGENT_IMAGES_MAX = 2;

const HANDOFF_UNSUPPORTED_MEDIA = "média non pris en charge";
const HANDOFF_SECURITY_THRESHOLD = "seuil de sécurité atteint";
const HANDOFF_HUMAN_REQUEST = "client demande un conseiller";
const HANDOFF_AI_DOWN = "IA indisponible";
const HANDOFF_TRANSCRIPTION_DOWN = "transcription indisponible";
const HANDOFF_OTHER_KIND = "type de message non pris en charge";
const CONTACT_LOG_NOTE = "WhatsApp : message client";

interface CopyCtx {
  locale: "fr" | "ar";
  storeName: string;
  assistantName: string;
  firstName: string | null;
}

/** Store locale from the raw config (the zod loader would drag server-only into tests). */
function storeLocale(): "fr" | "ar" {
  const locale: string = rawStoreConfig.locale;
  return locale === "ar" ? "ar" : "fr";
}

function localeForLanguage(language: WaLanguage | null): "fr" | "ar" {
  if (language === "ar" || language === "darija_arabic") return "ar";
  if (language === "fr" || language === "darija_latin") return "fr";
  return storeLocale();
}

/** First word of a display name, at most 30 characters. */
function firstNameOf(name: string | null): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return first ? first.slice(0, 30) : null;
}

/** enqueueOutbox must run inside a transaction; each enqueue gets its own small one. */
function enqueueAlone(input: EnqueueInput): boolean {
  return getDb().transaction(() => enqueueOutbox(input)).immediate();
}

/** Assistant-voiced handoff message, once per conversation and Casablanca day. */
function enqueueHandoffMessage(conv: WaConversation, ctx: CopyCtx, day: string): void {
  enqueueAlone({
    dedupeKey: `handoff:${conv.id}:${day}`,
    phone: conv.phone,
    purpose: "ai_reply",
    body: msgHandoff({
      locale: ctx.locale,
      storeName: ctx.storeName,
      assistantName: ctx.assistantName,
      firstName: ctx.firstName,
      seed: `handoff:${conv.id}:${day}`,
    }),
    conversationId: conv.id,
  });
}

/**
 * Applies one strike escalation decision. Warnings continue processing (unless
 * the caller decides otherwise); a block or a human-escalation stops it.
 */
function handleStrikeDecision(input: {
  decision: StrikeDecision;
  reasonLabel: string;
  phone: string;
  messageId: string;
  conv: WaConversation;
  ctx: CopyCtx;
  day: string;
}): "stop" | "continue" {
  const { decision } = input;
  if (decision.action === "none") return "continue";
  if (decision.action === "already_blocked") return "stop";

  if (decision.action === "warn") {
    enqueueAlone({
      dedupeKey: `strike:${input.messageId}`,
      phone: input.conv.phone,
      purpose: "strike_warning",
      body: msgStrikeWarning({
        locale: input.ctx.locale,
        storeName: input.ctx.storeName,
        assistantName: input.ctx.assistantName,
        firstName: input.ctx.firstName,
        seed: `strike:${input.messageId}:${decision.level}`,
        level: decision.level,
      }),
      conversationId: input.conv.id,
    });
    return "continue";
  }

  if (decision.action === "needs_human") {
    flagHandoff(input.conv.id, HANDOFF_SECURITY_THRESHOLD);
    return "stop";
  }

  // Newly blocked by the system: silent for the customer, one deduplicated
  // alert per admin phone and day. No conversation id: the alert must never
  // land inside the customer's own transcript.
  const body = msgAdminAutoBlocked({ maskedPhone: maskPhone(input.phone), reason: input.reasonLabel });
  for (const adminPhone of getWhatsAppSettings().adminPhones) {
    enqueueAlone({
      dedupeKey: `admin:autoblock:${input.phone}:${input.day}:${adminPhone}`,
      phone: adminPhone,
      purpose: "admin_alert",
      body,
    });
  }
  return "stop";
}

/** Leaves a short bracketed note on a message whose media could not be stored; never overwrites a caption. */
function setMessageNote(messageId: string, note: string): void {
  getDb()
    .prepare("UPDATE wa_messages SET body = ? WHERE id = ? AND (body IS NULL OR TRIM(body) = '')")
    .run(note, messageId);
}

interface NewMessageRow {
  id: string;
  kind: "text" | "audio" | "image" | "other";
  body: string | null;
  transcript: string | null;
  media_path: string | null;
}

/**
 * Inbound messages written after the latest outbound AI/agent message (the
 * unreplied tail, at most the last 10), chronological. Replies still queued in
 * the outbox count as outbound: a second customer message during a pacing gap
 * must not re-answer what is already answered. The current message is always
 * part of the result even if its WhatsApp timestamp predates the last
 * outbound send (delayed delivery).
 */
function collectAgentNewMessages(conversationId: string, currentMessageId: string): NewMessageRow[] {
  const db = getDb();
  const lastOut = db
    .prepare(
      `SELECT created_at FROM wa_messages
       WHERE conversation_id = ? AND direction = 'out' AND author IN ('ai','agent')
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(conversationId) as { created_at: string } | undefined;
  const queued = pendingOutboundReplies(conversationId);
  const lastQueued = queued.length > 0 ? queued[queued.length - 1]!.created_at : "";
  const cutoff = (lastOut?.created_at ?? "") > lastQueued ? (lastOut?.created_at ?? "") : lastQueued;
  const rows = db
    .prepare(
      `SELECT id, kind, body, transcript, media_path FROM wa_messages
       WHERE conversation_id = ? AND direction = 'in' AND created_at > ?
       ORDER BY created_at DESC, id DESC LIMIT ${AGENT_NEW_MESSAGES_MAX}`,
    )
    .all(conversationId, cutoff) as NewMessageRow[];
  rows.reverse();
  if (!rows.some((row) => row.id === currentMessageId)) {
    const current = db
      .prepare("SELECT id, kind, body, transcript, media_path FROM wa_messages WHERE id = ?")
      .get(currentMessageId) as NewMessageRow | undefined;
    if (current) rows.push(current);
  }
  return rows;
}

/** Maps stored message rows to agent turns; only the last 2 images carry vision payload. */
async function buildAgentNewMessages(rows: NewMessageRow[]): Promise<Array<{ kind: "text" | "audio" | "image"; text: string; imageBase64?: string }>> {
  const visionIndexes: number[] = [];
  rows.forEach((row, index) => {
    if (row.kind === "image" && row.media_path) visionIndexes.push(index);
  });
  const withVision = new Set(visionIndexes.slice(-AGENT_IMAGES_MAX));

  const newMessages: Array<{ kind: "text" | "audio" | "image"; text: string; imageBase64?: string }> = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const text = (row.body ?? row.transcript ?? "").trim();
    if (row.kind === "image" && withVision.has(index)) {
      try {
        const vision = await imageForVision(row.media_path!);
        newMessages.push({ kind: "image", text, imageBase64: vision.base64 });
        continue;
      } catch {
        // Unreadable image: fall through to the caption-only variant.
      }
    }
    newMessages.push({ kind: row.kind === "other" ? "text" : row.kind, text });
  }
  return newMessages;
}

/** Connection updates only maintain the banner state; there is no WhatsApp alert when the number goes down. */
function processConnectionUpdate(ev: ClaimedInbound): "done" | "ignored" {
  const payload = (ev.payload ?? {}) as Record<string, unknown>;
  const data = payload.data;
  const fromData = data !== null && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>).state
    : undefined;
  const rawState = fromData ?? payload.state;
  const state = typeof rawState === "string" ? rawState.trim().toLowerCase() : "";
  if (state !== "open" && state !== "connecting" && state !== "close") {
    markInboundIgnored(ev.id, ev.lease, "etat_connexion_inconnu");
    return "ignored";
  }

  const previous = getWhatsAppConnectionState();
  setWhatsAppConnectionState({ state });
  if (previous.state === "open" && state === "close") {
    log.warn("wa.disconnected", {});
  }
  markInboundDone(ev.id, ev.lease);
  return "done";
}

async function processCustomerMessage(ev: ClaimedInbound): Promise<"done" | "ignored" | "retry"> {
  const parsed = parseEvolutionMessage(ev.payload);
  if (parsed.type === "skip") {
    markInboundIgnored(ev.id, ev.lease, `skip:${parsed.reason}`);
    return "ignored";
  }

  const phone = jidToPhone(parsed.phoneJid);
  if (!phone) {
    markInboundIgnored(ev.id, ev.lease, "non_ma");
    return "ignored";
  }

  const settings = getWhatsAppSettings();
  const storeName = getStoreSettings().storeName;
  const now = new Date();
  const nowIso = now.toISOString();
  const day = casablancaParts(now).date;
  const isOther = parsed.type === "other";

  const kind = parsed.type;
  const body =
    parsed.type === "text"
      ? parsed.text
      : parsed.type === "image"
        ? (parsed.caption ?? null)
        : parsed.type === "other"
          ? `[${parsed.label}]`
          : null;

  // Conversation + message insert in one transaction so a crash never leaves a
  // conversation without its message or the other way around.
  const { conv, messageId, duplicate } = getDb()
    .transaction(() => {
      const created = getOrCreateConversation(phone, parsed.phoneJid, parsed.pushName);
      const inserted = insertInboundMessage({
        conversationId: created.id,
        waMessageId: parsed.waMessageId,
        kind,
        body,
        createdAt: parsed.timestamp,
      });
      return { conv: created, messageId: inserted.id, duplicate: inserted.duplicate };
    })
    .immediate();

  // First attempt on an already stored message: a genuine redelivery, everything
  // below already ran. A later attempt is the retry of an unfinished event (the
  // message row is written before media, transcription and reply), so it
  // continues; every step below is idempotent or guarded against repeating.
  const isRetry = duplicate && ev.attempts > 1;
  if (duplicate && !isRetry) {
    markInboundDone(ev.id, ev.lease);
    return "done";
  }
  const stored = duplicate
    ? (getDb()
        .prepare("SELECT media_path, media_mime, media_sha256, media_bytes, transcript FROM wa_messages WHERE id = ?")
        .get(messageId) as
        | {
            media_path: string | null;
            media_mime: string | null;
            media_sha256: string | null;
            media_bytes: number | null;
            transcript: string | null;
          }
        | undefined)
    : undefined;
  const recordStrike = (reason: StrikeReason): StrikeDecision =>
    isRetry && strikeRecordedForMessage(messageId, reason)
      ? { action: "none", points: 0 }
      : addStrike({ phone, reason, messageId, now });

  const ctx: CopyCtx = {
    locale: localeForLanguage(conv.language),
    storeName,
    assistantName: effectiveAssistantName(settings, storeName),
    firstName: firstNameOf(conv.displayName),
  };
  // Tracks the conversation language as of each decision point: transcription
  // and classification may both refine it while processing this event.
  let currentLanguage = conv.language;

  // Blocked phone: the message stays visible in the inbox, the AI stays silent.
  if (isPhoneBlocked(phone)) {
    markInboundDone(ev.id, ev.lease);
    return "done";
  }

  // Spam burst: more than 15 inbound messages in 2 minutes pauses the AI for
  // 30 minutes and adds one strike. The burst stays silent either way.
  const burstCount = (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM wa_messages
         WHERE conversation_id = ? AND direction = 'in' AND created_at >= ?`,
      )
      .get(conv.id, new Date(now.getTime() - SPAM_WINDOW_MS).toISOString()) as { n: number }
  ).n;
  if (burstCount > SPAM_BURST_THRESHOLD) {
    const alreadyPaused = Boolean(conv.aiPausedUntil && conv.aiPausedUntil > nowIso);
    if (!alreadyPaused) {
      pauseAi(conv.id, new Date(now.getTime() + SPAM_PAUSE_MS).toISOString());
      const decision = recordStrike("spam_burst");
      const outcome = handleStrikeDecision({
        decision,
        reasonLabel: STRIKE_LABELS.spam_burst,
        phone,
        messageId,
        conv,
        ctx,
        day,
      });
      if (outcome === "stop") {
        markInboundDone(ev.id, ev.lease);
        return "done";
      }
    }
    markInboundDone(ev.id, ev.lease);
    return "done";
  }

  // Media: download and store voice notes and images. A retryable download
  // failure replays the whole event; an unusable media hands off to a human.
  let transcript: string | null = stored?.transcript ?? null;
  if (parsed.type === "audio" || parsed.type === "image") {
    let media: StoredMedia;
    if (stored?.media_path) {
      media = {
        relPath: stored.media_path,
        mime: stored.media_mime ?? "application/octet-stream",
        sha256: stored.media_sha256 ?? "",
        bytes: stored.media_bytes ?? 0,
        kind: parsed.type,
      };
    } else {
      try {
        // Evolution's getBase64FromMediaMessage receives the webhook message key
        // echoed back, so `remoteJid` must be the chat JID exactly as Evolution
        // delivered it: `parsed.jid` (the raw `key.remoteJid`, which stays an
        // `@lid` value for LID chats — those chats are stored under that JID;
        // current Evolution resolves the message by `key.id` alone, making the
        // JID moot there, but echoing the delivered JID is the documented
        // contract). Re-verify `@lid` chats live during the Darija eval (task 26)
        // before relying on voice notes from such conversations.
        media = await fetchInboundMedia({
          waMessageId: parsed.waMessageId,
          remoteJid: parsed.jid,
          expected: parsed.type,
        });
      } catch (error) {
        if (error instanceof MediaError && error.kind === "download") {
          markInboundRetry(ev.id, ev.lease, error.message);
          return "retry";
        }
        if (error instanceof MediaError) {
          setMessageNote(messageId, error.kind === "too_large" ? "[média trop volumineux]" : "[média non pris en charge]");
          flagHandoff(conv.id, HANDOFF_UNSUPPORTED_MEDIA);
          markInboundDone(ev.id, ev.lease);
          return "done";
        }
        throw error;
      }
      updateMessageMedia(messageId, {
        mediaPath: media.relPath,
        mediaMime: media.mime,
        mediaSha256: media.sha256,
        mediaBytes: media.bytes,
      });
    }

    if (parsed.type === "audio" && transcript === null && aiBudgetAvailable(now)) {
      try {
        const result = await transcribeAudio({
          bytes: await readMedia(media.relPath),
          mimetype: media.mime,
          sha256: media.sha256,
          conversationId: conv.id,
        });
        setMessageTranscript(messageId, result.transcript);
        transcript = result.transcript;
        if (!conv.language && result.language) {
          setLanguage(conv.id, result.language);
          currentLanguage = result.language;
        }
      } catch (error) {
        // A transcription failure is never fatal: no transcript, hand off. The
        // reason distinguishes a transcription-only failure (the chat model may
        // still be fine) from an AI-wide outage, so agents see the real problem.
        flagHandoff(
          conv.id,
          error instanceof AiBudgetExceededError || error instanceof AiUnavailableError
            ? HANDOFF_AI_DOWN
            : HANDOFF_TRANSCRIPTION_DOWN,
        );
        enqueueHandoffMessage(conv, ctx, day);
        markInboundDone(ev.id, ev.lease);
        return "done";
      }
    }
  }

  // Customer text (or the transcript / caption standing in for it). The
  // bracketed label of an "other" message is not customer content: identity
  // matching and abuse classification skip it.
  const text = (body ?? transcript ?? "").trim();

  // Identity: link orders referenced in the message; a fresh 24h identity lock
  // (three failed reference attempts) is also a strike.
  let linkResult: LinkResult | null = null;
  if (text && !isOther) {
    linkResult = linkOrdersFromMessage(conv.id, text, now, { countFailures: !isRetry });
    if (linkResult.newlyLocked) {
      const decision = recordStrike("ref_guessing");
      const outcome = handleStrikeDecision({
        decision,
        reasonLabel: STRIKE_LABELS.ref_guessing,
        phone,
        messageId,
        conv,
        ctx,
        day,
      });
      if (outcome === "stop") {
        markInboundDone(ev.id, ev.lease);
        return "done";
      }
    }
  }

  // Contact log: one note per full-access order and Casablanca day, deduped by
  // the service so worker retries never duplicate rows. `conv.orders` was
  // loaded before `linkOrdersFromMessage` ran, so full-access orders the
  // message just linked are unioned in here (normally identical, since
  // same-phone orders are auto-linked while loading the conversation — the
  // union keeps this correct even if that invariant ever changes).
  const fullAccessOrderIds = new Set<string>();
  for (const linked of conv.orders) {
    if (linked.access === "full") fullAccessOrderIds.add(linked.orderId);
  }
  if (linkResult) {
    for (const linked of linkResult.linked) {
      if (linked.access === "full") fullAccessOrderIds.add(linked.orderId);
    }
  }
  for (const orderId of fullAccessOrderIds) {
    logOrderContact(orderId, null, CONTACT_LOG_NOTE, now);
  }

  // Safety classification and language detection run for every non-empty
  // customer text while the AI feature is on — even in human mode, so strikes
  // still accumulate when an agent is chatting.
  let classification: Classification | null = null;
  if (text && !isOther && settings.enabled && settings.aiEnabled) {
    classification = await classifyInbound(text, conv.id);
    if (classification.language !== currentLanguage && (currentLanguage === null || text.length > 15)) {
      setLanguage(conv.id, classification.language);
    }

    const strikeReason: StrikeReason | null =
      classification.category === "insult"
        ? "insult"
        : classification.category === "severe"
          ? "severe"
          : classification.category === "manipulation" || classification.category === "troll"
            ? "manipulation"
            : null;

    if (strikeReason) {
      const decision = recordStrike(strikeReason);
      const outcome = handleStrikeDecision({
        decision,
        reasonLabel: STRIKE_LABELS[strikeReason],
        phone,
        messageId,
        conv,
        ctx,
        day,
      });
      // Insults and severe content never reach the agent, even after a warning.
      const isSevereAbuse = strikeReason === "insult" || strikeReason === "severe";
      if (outcome === "stop" || isSevereAbuse) {
        markInboundDone(ev.id, ev.lease);
        return "done";
      }
    }
  }

  // Debounce: when a newer event for the same JID is still waiting, let it
  // answer the whole burst; this event stays silent.
  const receivedAt = (
    getDb().prepare("SELECT received_at FROM wa_inbound_events WHERE id = ?").get(ev.id) as
      | { received_at: string }
      | undefined
  )?.received_at ?? nowIso;
  // Only events that parse to an answerable message count: reactions, protocol
  // messages and the store's own sent messages never get a reply of their own.
  const laterEvents = getDb()
    .prepare(
      `SELECT payload_json FROM wa_inbound_events
       WHERE status IN ('pending','processing')
         AND event_type = 'messages.upsert'
         AND (received_at > ? OR (received_at = ? AND id > ?))
         AND json_extract(payload_json, '$.key.remoteJid') = ?
       LIMIT 200`,
    )
    .all(receivedAt, receivedAt, ev.id, parsed.jid) as Array<{ payload_json: string }>;
  const hasLaterEvent = laterEvents.some((row) => {
    try {
      return parseEvolutionMessage(JSON.parse(row.payload_json)).type !== "skip";
    } catch {
      return false;
    }
  });
  if (hasLaterEvent) {
    markInboundDone(ev.id, ev.lease);
    return "done";
  }

  // Reply decision: every condition must hold before any automated message.
  const aiAllowed =
    settings.enabled &&
    settings.aiEnabled &&
    conv.mode === "ai" &&
    !conv.needsHuman &&
    !(conv.aiPausedUntil && conv.aiPausedUntil > nowIso) &&
    !conv.blocked;

  if (aiAllowed) {
    if (isOther) {
      // Unsupported kinds get a single handoff message per day and a flag.
      flagHandoff(conv.id, HANDOFF_OTHER_KIND);
      enqueueHandoffMessage(conv, ctx, day);
      markInboundDone(ev.id, ev.lease);
      return "done";
    }

    if (classification?.wantsHuman) {
      flagHandoff(conv.id, HANDOFF_HUMAN_REQUEST);
      enqueueHandoffMessage(conv, ctx, day);
      markInboundDone(ev.id, ev.lease);
      return "done";
    }

    // A retried event whose reply is already queued must not answer twice.
    if (isRetry && hasAiReplyForMessage(messageId)) {
      markInboundDone(ev.id, ev.lease);
      return "done";
    }

    // Agent turn over the unreplied tail of the conversation.
    try {
      const rows = collectAgentNewMessages(conv.id, messageId);
      const newMessages = await buildAgentNewMessages(rows);
      const result = await runWhatsAppAgent({ conversationId: conv.id, newMessages });
      // The catalog tools may already have enqueued product cards this turn;
      // their count offsets the reply index so dedupe keys never collide.
      let replyIndex = result.productCardsQueued;
      for (const reply of result.replies) {
        enqueueAlone({
          dedupeKey: `msg:${messageId}:reply:${replyIndex}`,
          phone: conv.phone,
          purpose: "ai_reply",
          body: reply,
          conversationId: conv.id,
        });
        replyIndex += 1;
      }
      if (result.handedOff && result.replies.length === 0) {
        enqueueHandoffMessage(conv, ctx, day);
      }
    } catch (error) {
      if (error instanceof AiBudgetExceededError || error instanceof AiUnavailableError) {
        flagHandoff(conv.id, HANDOFF_AI_DOWN);
        enqueueHandoffMessage(conv, ctx, day);
      } else {
        throw error;
      }
    }
  }

  markInboundDone(ev.id, ev.lease);
  return "done";
}

/**
 * Processes one claimed inbound event and marks it. Returns the outcome for the
 * worker's tick log; any unexpected error is retried with backoff through
 * markInboundRetry (redacted), never silently dropped.
 */
export async function processInboundEvent(ev: ClaimedInbound): Promise<"done" | "ignored" | "retry"> {
  try {
    if (ev.eventType === "connection.update") {
      return processConnectionUpdate(ev);
    }
    if (ev.eventType === "messages.upsert") {
      return await processCustomerMessage(ev);
    }
    markInboundIgnored(ev.id, ev.lease, "type_evenement_inconnu");
    return "ignored";
  } catch (error) {
    markInboundRetry(ev.id, ev.lease, error instanceof Error ? error.message : "erreur inconnue");
    return "retry";
  }
}
