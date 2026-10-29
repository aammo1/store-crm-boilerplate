# Task 13: Thank-you page WhatsApp button

## Status

complete

## Wave

2

## Description

**First contact** comes from the customer (option A): right after checkout, the `/merci` page invites the customer to confirm their order on WhatsApp. The pre-filled message contains the order ref (`#XXXXXXXX`), which the inbound processor uses to link the conversation to the order. The wording varies per order, so many customers don't send identical first messages. The page already renders a WhatsApp link; this task makes it the main call to action, with clearer copy and varied pre-fill. The storefront bundle budget is strict (≤122,880 B gzip on product and landing pages), so use only the zero-import helper.

## Dependencies

**Depends on:** task-05-phone-and-copy.md
**Blocks:** None

**Context from dependencies:**
- Task 05 created `src/lib/whatsapp/prefill.ts` with `waPrefill(locale: "fr"|"ar", ref: string, seed: string): string`. It has zero imports and returns one of at least 4 variants per locale, each containing `#REF`.
- Existing `src/app/(storefront)/merci/thank-you.tsx` (client component):
  - reads `readPendingOrder(storeSlug)` from `@/stores/funnel`
  - computes `number = order?.orderId.slice(0, 8).toUpperCase()`
  - builds `message = \`${t(locale, "orderNumber")} ${number}\`` and the link `https://wa.me/${whatsapp}?text=…`
- `src/config/i18n.ts` holds the fixed fr and ar UI strings. Keys are listed in an array around line 52, including `contactWhatsapp`. Add new keys in both locales.

## Files to Create

- None.

## Files to Modify

- `src/app/(storefront)/merci/thank-you.tsx`: use `waPrefill(locale, number, order.orderId)` for the text. Show a prominent primary button "Confirmer sur WhatsApp" with a WhatsApp icon (inline SVG, no new dependency), plus a one-line explanation. Keep the existing tracking and home links.
- `src/config/i18n.ts`: add these keys:
  - `confirmOnWhatsapp`: fr "Confirmer ma commande sur WhatsApp", ar "أكّد طلبك عبر واتساب"
  - `confirmOnWhatsappHint`: fr "Recevez la confirmation et le suivi de votre colis directement sur WhatsApp.", ar "توصل بالتأكيد وتتبع طردك مباشرة على واتساب."

## Technical Details

- Only render the button when `order` exists, since a ref is needed. Without an order, keep the current generic contact link.
- Link: `https://wa.me/${whatsapp}?text=${encodeURIComponent(waPrefill(locale, number, order.orderId))}`, with `target="_blank" rel="noopener noreferrer"`.
- Button style: use the existing storefront classes (`rounded-store`, `bg-store-accent` or the existing primary button classes in this file). Keep `dir="ltr"` on the ref.
- Don't send any network request and don't log anything.
- Run `DELIVERY_PROVIDER=mock npm run build && npm run perf-budget` afterwards.

## Acceptance Criteria

- [ ] After a test checkout, `/merci` shows the WhatsApp button. The `wa.me` link text contains `#<REF>` and differs across order IDs.
- [ ] Both fr and ar strings exist, and the ar layout stays RTL-correct.
- [ ] `npm run perf-budget` passes. The storefront bundle gains no zod, libphonenumber or service imports.
- [ ] Lint and tsc pass.
