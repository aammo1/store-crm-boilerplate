# Task 05: Phone/JID helpers and message copy

## Status

complete

## Wave

1

## Description

This task builds pure, dependency-free helpers that the rest of the feature uses:
- conversion between normalized Moroccan phones (`+2126XXXXXXXX`) and WhatsApp JIDs (`2126XXXXXXXX@s.whatsapp.net`)
- extraction of an order ref from the first customer message
- the **plain-text message copy** for every store-initiated message, in French and Arabic, with **wording variation** so consecutive messages aren't identical (identical texts raise ban risk)
- the admin alert format

The thank-you page pre-filled text variants also live here so the storefront can reuse them. That part must stay tiny and browser-safe.

## Dependencies

**Depends on:** None (Wave 1)
**Blocks:** task-07, task-08, task-13, task-15

**Context from dependencies:** None. Existing facts:
- `src/lib/phone-core.ts` `normalizeMaPhoneCore(raw)` is browser-safe and returns `+212[67]XXXXXXXX` or null. It accepts `+212`, `00212`, `212` and a leading `0`, and handles Arabic-Indic digits.
- Order IDs are long nanoid strings. The customer-facing ref is `orderId.slice(0, 8).toUpperCase()`, as used in `src/app/(storefront)/merci/thank-you.tsx`. `lookupOrderTracking` in `src/lib/services/order-tracking-lookup.ts` matches `upper(id) = ref OR (length(ref) >= 8 AND upper(id) LIKE ref || '%')`.
- Prices are integer MAD. Format them as `398 DH` in messages.

## Files to Create

- `src/lib/whatsapp/phone.ts`: JID helpers and ref extraction (browser-safe, imports only `phone-core`).
- `src/lib/whatsapp/copy.ts`: server-side message builders (fr and ar) plus the variation picker.
- `src/lib/whatsapp/prefill.ts`: browser-safe thank-you page pre-fill variants. No imports except types.

## Files to Modify

- None.

## Technical Details

### phone.ts

```ts
export function phoneToJid(phone: string): string | null;     // "+212612345678" -> "212612345678@s.whatsapp.net"
export function jidToPhone(jid: string): string | null;       // accepts "...@s.whatsapp.net" or "...@c.us"; rejects "@g.us" (groups), "@broadcast", "@lid" -> null
export function isGroupOrBroadcastJid(jid: string): boolean;
export function orderRefFromOrderId(orderId: string): string; // slice(0,8).toUpperCase()
export function extractOrderRefs(text: string): string[];     // finds tokens /#?\b([A-Z0-9]{8})\b/gi after uppercasing; dedupe; max 3
export function extractLast4(text: string): string | null;    // a standalone 4-digit group /\b(\d{4})\b/ not part of a longer number; null otherwise
export function maskPhone(phone: string): string;             // "+212612345678" -> "+212 6•• •• •5 78" style, for UI
```

`jidToPhone` strips the device suffix (`212612345678:12@s.whatsapp.net`) and runs `normalizeMaPhoneCore`. It returns null for non-Moroccan numbers. **Non-Moroccan senders are ignored** by the inbound processor.

### Variation picker

```ts
export function pickVariant<T>(variants: readonly T[], seed: string): T; // deterministic: fnv1a(seed) % variants.length
```

Seed it with `orderId + purpose`, so a retry reuses the same text and different orders get different texts.

### copy.ts message builders

Each returns a string of at most about 3 short lines and at most one emoji. Every builder takes `locale: "fr" | "ar"`, which is the store locale or the customer's detected language mapped to fr or ar. Darija conversations use `ar` for store-initiated messages unless the language is `darija_latin`, which uses `fr`. Provide **at least 3 variants per purpose per locale**.

```ts
type Ctx = { locale: "fr" | "ar"; storeName: string; assistantName: string; firstName?: string | null; ref: string; seed: string };
export function msgConfirmed(ctx: Ctx & { totalMad: number; itemsSummary: string; cityName?: string | null }): string;
export function msgShipped(ctx: Ctx & { trackingNumber: string; trackUrl: string }): string;
export function msgDelivered(ctx: Ctx): string;
export function msgOutForDelivery(ctx: Ctx & { totalMad: number }): string;  // "préparez {total} DH"
export function msgDeliveryIssue(ctx: Ctx): string;                          // invites reply with a new time slot
export function msgCancelled(ctx: Ctx): string;
export function msgRelanceNoAnswer(ctx: Ctx): string;
export function msgStrikeWarning(ctx: Omit<Ctx, "ref"> & { level: 1 | 2 }): string; // 1 polite, 2 final ("prochain manquement = blocage")
export function msgHandoff(ctx: Omit<Ctx, "ref">): string;                  // "un conseiller vous répond bientôt"
export function msgAdminConfirmed(input: { ref: string; itemsSummary: string; totalMad: number; cityName: string | null; actorName: string | null }): string;
// exactly: `✅ Confirmée #${ref} · ${itemsSummary} · ${totalMad} DH · ${cityName ?? "—"} · par ${actorName ?? "—"}` (French only, no address)
export function msgAdminRefused(input: { ref: string; totalMad: number; cityName: string | null }): string; // `↩️ Refusée #ref · total DH · ville`
export function msgAdminAutoBlocked(input: { maskedPhone: string; reason: string }): string;
export function msgAdminDisconnected(): string;
```

Example French variants for `msgConfirmed` (write similar ones for the other purposes and an Arabic set):
- `Bonjour {firstName}, votre commande #{ref} chez {storeName} est confirmée ✅\n{itemsSummary} — {total} DH à payer à la livraison.\nNous vous informons dès l'expédition.`
- `Merci {firstName} ! Commande #{ref} confirmée : {itemsSummary}, {total} DH (paiement à la livraison).\nVous recevrez le numéro de suivi ici.`
- `{storeName} : votre commande #{ref} est bien confirmée 👍\nTotal {total} DH à la livraison. On vous tient au courant.`

Rules:
- If `firstName` is missing, drop it cleanly ("Bonjour,").
- Never include the address.
- The `msgRelanceNoAnswer` French base text is: `Bonjour {prénom}, nous avons essayé de vous joindre pour votre commande #{ref} chez {store}. Répondez ici pour la confirmer 🙏`.
- Arabic texts are Modern Standard Arabic / soft Darija in Arabic script, polite.

### prefill.ts (storefront, browser-safe)

```ts
export function waPrefill(locale: "fr" | "ar", ref: string, seed: string): string;
```

Use at least 4 variants per locale, each containing `#REF`. French examples:
- `Bonjour, je confirme ma commande #{ref}`
- `Salam, c'est pour ma commande #{ref}`
- `Bonjour ! Commande #{ref}, je voudrais confirmer`
- `Salut, je viens de commander (#{ref})`

Arabic examples: `السلام عليكم، أؤكد طلبي رقم #{ref}` and similar. Include a tiny inline FNV-1a hash. **No imports** (bundle budget).

## Acceptance Criteria

- [ ] Unit test `scripts/unit/whatsapp-copy.test.mjs` covers:
  - JID round-trip; groups, broadcast and `@lid` return null; device suffix stripped
  - ref extraction from `"salam #a1b2c3d4 merci"` gives `["A1B2C3D4"]`
  - same seed gives the same text, and different seeds produce at least 2 distinct texts across 10 seeds
  - no builder output contains the word "adresse" or an address field
  - the admin format matches exactly
- [ ] `prefill.ts` has zero imports.
- [ ] Lint and tsc pass.
