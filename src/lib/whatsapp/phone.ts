import { normalizeMaPhoneCore } from "@/lib/phone-core";

/**
 * Converts a normalized Moroccan phone (+2126XXXXXXXX or +2127XXXXXXXX)
 * or raw phone string to a WhatsApp JID ("2126XXXXXXXX@s.whatsapp.net").
 * Returns null for non-Moroccan or invalid phone numbers.
 */
export function phoneToJid(phone: string): string | null {
  if (!phone) return null;
  const normalized = normalizeMaPhoneCore(phone);
  if (!normalized) return null;
  const digits = normalized.startsWith("+") ? normalized.slice(1) : normalized;
  return `${digits}@s.whatsapp.net`;
}

/**
 * Checks whether a WhatsApp JID corresponds to a group, broadcast list,
 * status broadcast, or newsletter/channel.
 */
export function isGroupOrBroadcastJid(jid: string): boolean {
  if (!jid) return false;
  const clean = jid.trim().toLowerCase();
  return (
    clean.endsWith("@g.us") ||
    clean.endsWith("@broadcast") ||
    clean === "status@broadcast" ||
    clean.endsWith("@newsletter")
  );
}

/**
 * Converts a WhatsApp JID to a normalized Moroccan mobile phone (+212[67]XXXXXXXX).
 * Accepts "...@s.whatsapp.net" or "...@c.us".
 * Rejects "@g.us" (groups), "@broadcast", "@lid", and non-Moroccan senders -> null.
 * Strips device suffixes such as "212612345678:12@s.whatsapp.net".
 */
export function jidToPhone(jid: string): string | null {
  if (!jid) return null;
  const clean = jid.trim().toLowerCase();
  if (isGroupOrBroadcastJid(clean) || clean.endsWith("@lid")) {
    return null;
  }
  const atIdx = clean.lastIndexOf("@");
  if (atIdx === -1) return null;
  const domain = clean.slice(atIdx + 1);
  if (domain !== "s.whatsapp.net" && domain !== "c.us") {
    return null;
  }
  const user = clean.slice(0, atIdx);
  const colonIdx = user.indexOf(":");
  const rawNumber = colonIdx === -1 ? user : user.slice(0, colonIdx);
  return normalizeMaPhoneCore(rawNumber);
}

/**
 * Derives the 8-character uppercase customer-facing reference from an order ID.
 */
export function orderRefFromOrderId(orderId: string): string {
  if (!orderId) return "";
  return orderId.slice(0, 8).toUpperCase();
}

/**
 * Finds up to 3 deduplicated 8-character alphanumeric order references
 * from user text (e.g. "salam #a1b2c3d4 merci" -> ["A1B2C3D4"]).
 */
export function extractOrderRefs(text: string): string[] {
  if (!text) return [];
  const upper = text.toUpperCase();
  const regex = /#?\b([A-Z0-9]{8})\b/g;
  const matches = upper.matchAll(regex);
  const seen = new Set<string>();
  const results: string[] = [];
  for (const m of matches) {
    const ref = m[1];
    if (!seen.has(ref)) {
      seen.add(ref);
      results.push(ref);
      if (results.length === 3) break;
    }
  }
  return results;
}

/**
 * Extracts a standalone 4-digit group (e.g. for customer identity verification)
 * not part of a longer number. Handles Arabic-Indic digits. Returns null otherwise.
 */
export function extractLast4(text: string): string | null {
  if (!text) return null;
  const ascii = text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  const m = ascii.match(/\b(\d{4})\b/);
  return m ? m[1] : null;
}

/**
 * Masks a Moroccan phone number for UI display and logs.
 * Example: "+212612345678" -> "+212 6•• •• •6 78"
 */
export function maskPhone(phone: string): string {
  const norm = normalizeMaPhoneCore(phone);
  if (!norm) return phone;
  const d = norm.slice(4);
  return `+212 ${d[0]}•• •• •${d[6]} ${d[7]}${d[8]}`;
}
