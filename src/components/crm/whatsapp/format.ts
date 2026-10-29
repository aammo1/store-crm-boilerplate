/**
 * Client-side display helpers for the WhatsApp inbox. Browser-safe: no server
 * or DB imports, so these modules can be shared by every inbox component.
 */

const casablancaDateTime = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Africa/Casablanca",
});

/** Formats an ISO timestamp in Africa/Casablanca, "dd/mm/yyyy hh:mm". */
export function formatCasablancaDateTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return "";
    return casablancaDateTime.format(date);
  } catch {
    return "";
  }
}

/** "il y a …" relative age; falls back to the absolute Casablanca date after a week. */
export function formatRelativeTime(isoString: string, now: number = Date.now()): string {
  const then = new Date(isoString).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "à l’instant";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `il y a ${days} j`;
  return formatCasablancaDateTime(isoString);
}

/**
 * Masks a Moroccan phone number for agents. Mirrors the server-side
 * `maskPhone` (src/lib/whatsapp/phone.ts) for valid numbers and degrades to a
 * generic partial mask for anything unnormalized, so a full number is never
 * shown to agents.
 */
export function maskPhoneDisplay(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const core = digits.startsWith("212") ? digits.slice(3) : digits.replace(/^0+/, "");
  if (core.length === 9) {
    return `+212 ${core[0]}•• •• •${core[6]} ${core[7]}${core[8]}`;
  }
  if (digits.length <= 4) return "••••";
  return `${digits.slice(0, 2)}•••••${digits.slice(-2)}`;
}

const PURPOSE_LABELS: Record<string, string> = {
  notify_confirmed: "Confirmation de commande",
  notify_shipped: "Colis expédié",
  notify_delivered: "Colis livré",
  notify_out_for_delivery: "Colis en cours de livraison",
  notify_delivery_issue: "Problème de livraison",
  notify_cancelled: "Commande annulée",
  relance_no_answer: "Relance sans réponse",
  admin_alert: "Alerte administrateur",
  ai_reply: "Réponse de l’IA",
  agent_reply: "Réponse d’un agent",
  strike_warning: "Avertissement",
  product_card: "Fiche produit",
};

/** French label of an outbox purpose, falling back to the raw value. */
export function purposeLabel(purpose: string): string {
  return PURPOSE_LABELS[purpose] ?? purpose;
}
