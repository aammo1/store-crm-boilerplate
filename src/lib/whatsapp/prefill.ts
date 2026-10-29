/**
 * Browser-safe WhatsApp message pre-fill generator for the thank-you page.
 * Keeps zero imports to avoid storefront bundle bloat.
 */

function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function waPrefill(locale: "fr" | "ar", ref: string, seed: string): string {
  const variants = locale === "ar" ? [
    `السلام عليكم، أؤكد طلبي رقم #${ref}`,
    `مرحباً، بخصوص طلبي رقم #${ref}`,
    `السلام عليكم، أريد تأكيد طلبيتي #${ref}`,
    `أهلاً، لقد قمت بالطلب للتو برقم #${ref}`,
  ] : [
    `Bonjour, je confirme ma commande #${ref}`,
    `Salam, c'est pour ma commande #${ref}`,
    `Bonjour ! Commande #${ref}, je voudrais confirmer`,
    `Salut, je viens de commander (#${ref})`,
  ];
  const idx = fnv1a(seed) % variants.length;
  return variants[idx];
}
