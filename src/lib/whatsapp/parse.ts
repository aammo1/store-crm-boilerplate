/**
 * Pure parsing of one Evolution API "messages.upsert" payload into the narrow
 * shape the inbound processor understands. No database, no network: everything
 * is decided from the payload alone so unit tests stay deterministic.
 */

/** Hard cap mirroring the WhatsApp text body bound; longer payloads are truncated. */
const MAX_TEXT_CHARS = 4000;

export type ParsedMessage =
  | { type: "text"; waMessageId: string; jid: string; phoneJid: string; pushName: string | null; text: string; timestamp: string }
  | { type: "audio"; waMessageId: string; jid: string; phoneJid: string; pushName: string | null; seconds?: number; timestamp: string }
  | { type: "image"; waMessageId: string; jid: string; phoneJid: string; pushName: string | null; caption?: string; timestamp: string }
  | { type: "other"; waMessageId: string; jid: string; phoneJid: string; pushName: string | null; label: string; timestamp: string }
  | { type: "skip"; reason: string };

interface KeyLike {
  remoteJid?: unknown;
  fromMe?: unknown;
  id?: unknown;
  senderPn?: unknown;
  remoteJidAlt?: unknown;
}

const skip = (reason: string): ParsedMessage => ({ type: "skip", reason });

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Resolves the phone-bearing JID for the sender. Newer WhatsApp versions may
 * only expose an opaque `@lid` remote JID; the real phone then arrives through
 * `key.senderPn` or `key.remoteJidAlt`. Without either, the message cannot be
 * attributed to a Moroccan phone and must be skipped.
 */
function resolvePhoneJid(key: KeyLike): string | null {
  const remoteJid = typeof key.remoteJid === "string" ? key.remoteJid : "";
  if (remoteJid.toLowerCase().endsWith("@lid")) {
    if (typeof key.senderPn === "string" && key.senderPn.trim()) return key.senderPn;
    if (typeof key.remoteJidAlt === "string" && key.remoteJidAlt.trim()) return key.remoteJidAlt;
    return null;
  }
  return remoteJid || null;
}

/**
 * Converts Evolution's `messageTimestamp` (seconds; a plain number, a digit
 * string or a serialized protobuf Long) to ISO. Missing or malformed values
 * fall back to `now`; a future timestamp is clamped to `now` so ordering and
 * the spam-burst window stay meaningful.
 */
function timestampToIso(value: unknown, now: Date): string {
  let ms: number | null = null;
  if (typeof value === "number" && Number.isFinite(value)) {
    ms = value * 1000;
  } else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    ms = Number(value.trim()) * 1000;
  } else if (asRecord(value)) {
    const long = value as { low?: unknown; high?: unknown };
    if (typeof long.low === "number" && Number.isFinite(long.low)) {
      const high = typeof long.high === "number" && Number.isFinite(long.high) ? long.high : 0;
      ms = (long.low + high * 0x1_0000_0000) * 1000;
    }
  }
  if (ms === null) return now.toISOString();
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return now.toISOString();
  return date > now ? now.toISOString() : date.toISOString();
}

/** Labels shown in the inbox for message kinds the store cannot answer automatically. */
const OTHER_LABELS: Array<[string, string]> = [
  ["videoMessage", "vidéo"],
  ["documentMessage", "document"],
  ["stickerMessage", "sticker"],
  ["locationMessage", "position"],
  ["contactMessage", "contact"],
];

/** Message wrapper kinds that carry no customer content and must never be stored or answered. */
const SKIP_FIELDS = ["reactionMessage", "protocolMessage", "senderKeyDistributionMessage", "pollUpdateMessage"] as const;

/**
 * Parses one stored webhook message payload. Returns `skip` for anything that
 * is not a processable customer message (reactions, protocol handshakes,
 * context-only wrappers, own messages, missing identifiers).
 */
export function parseEvolutionMessage(payload: unknown, now: Date = new Date()): ParsedMessage {
  const outer = asRecord(payload);
  if (!outer) return skip("payload_invalide");

  const key = asRecord(outer.key) as KeyLike | null;
  if (!key) return skip("cle_manquante");
  if (key.fromMe === true) return skip("from_me");

  const waMessageId = typeof key.id === "string" && key.id.trim() ? key.id.trim() : null;
  if (!waMessageId) return skip("sans_id");

  const jid = typeof key.remoteJid === "string" ? key.remoteJid : "";
  if (!jid) return skip("sans_jid");

  const phoneJid = resolvePhoneJid(key);
  if (!phoneJid) return skip("lid_unresolved");

  const pushName = typeof outer.pushName === "string" && outer.pushName.trim() ? outer.pushName.trim() : null;
  const timestamp = timestampToIso(outer.messageTimestamp, now);

  const message = asRecord(outer.message);
  if (!message) return skip("contenu_vide");

  // `messageContextInfo` is metadata riding along with real content; ignore it
  // when deciding whether anything processable remains.
  const contentKeys = Object.keys(message).filter((name) => name !== "messageContextInfo");
  if (contentKeys.length === 0) return skip("contexte_only");

  for (const field of SKIP_FIELDS) {
    if (message[field]) return skip(field.replace(/Message$/, "").toLowerCase());
  }

  const conversation = message.conversation;
  if (typeof conversation === "string") {
    return { type: "text", waMessageId, jid, phoneJid, pushName, text: conversation.trim().slice(0, MAX_TEXT_CHARS), timestamp };
  }

  const extended = asRecord(message.extendedTextMessage);
  const extendedText = extended?.text;
  if (typeof extendedText === "string") {
    return { type: "text", waMessageId, jid, phoneJid, pushName, text: extendedText.trim().slice(0, MAX_TEXT_CHARS), timestamp };
  }

  const audio = asRecord(message.audioMessage);
  if (audio) {
    const seconds = typeof audio.seconds === "number" && Number.isFinite(audio.seconds) ? audio.seconds : undefined;
    return { type: "audio", waMessageId, jid, phoneJid, pushName, seconds, timestamp };
  }

  const image = asRecord(message.imageMessage);
  if (image) {
    const caption = typeof image.caption === "string" ? image.caption.trim().slice(0, MAX_TEXT_CHARS) : undefined;
    return { type: "image", waMessageId, jid, phoneJid, pushName, caption, timestamp };
  }

  for (const [field, label] of OTHER_LABELS) {
    if (message[field]) return { type: "other", waMessageId, jid, phoneJid, pushName, label, timestamp };
  }

  return skip(`type_non_gere:${contentKeys[0]}`);
}
