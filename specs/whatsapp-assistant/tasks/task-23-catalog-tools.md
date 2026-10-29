# Task 23: Catalog tools for the AI

## Status

complete

## Wave

4

## Description

This is the later-phase catalog feature, built on the **CRM catalog only**. There's no native WhatsApp catalog. When `catalogSuggestionsEnabled` is ON, the agent can:
- send **product cards**: image, short caption with name, MAD price, in-stock options and packs, plus the product link; at most 3 per turn
- propose the **closest in-stock alternative** when the requested option is out of stock
- **match a customer's product photo** against the catalog without guessing

When `orderEditProposalsEnabled` is ON, it can create an **order-edit proposal** (variant, size, quantity) for an unconfirmed order, which an agent approves. When `crossSellEnabled` is ON (OFF by default), it may suggest **one** cross-sell per conversation after answering a question.

## Dependencies

**Depends on:** task-17-ai-agent.md (task-07, task-12 indirectly)
**Blocks:** task-26-darija-eval

**Context from dependencies:**
- Task 17 created:
  - `src/lib/whatsapp/ai/agent.ts` `runWhatsAppAgent({ conversationId, newMessages })`, which builds tools with `createWhatsAppTools(ctx)` from `src/lib/whatsapp/ai/tools.ts` and the prompt from `src/lib/whatsapp/ai/prompt.ts` (`buildSystemPrompt({ …, catalogEnabled })`). It returns `{ replies, handedOff, model, toolCalls }`.
  - The core tools, including `findProducts({ query })`, which gives text-only results.
  - The `ctx` object holds `conversationId` and a tool-call counter (max 8).
- Task 07: `enqueueOutbox({ dedupeKey, phone, purpose: "product_card", kind: "image", body: caption, mediaRef: absoluteImageUrl, conversationId, respectWindow: false, countsTowardCap: false })`.
- Task 12: `createProposal({ orderId, conversationId, kind: "edit", lines: [{ variantId, qty }], summary })`. It requires the order to be editable and supersedes older pending edits. It throws `StagingError`.
- Task 08: `orderAccess(conversationId, orderId)`.
- Task 04: `getWhatsAppSettings()` (`catalogSuggestionsEnabled`, `crossSellEnabled`, `orderEditProposalsEnabled`).
- Existing catalog access:
  - `src/lib/services/catalog.ts`: `listStorefront()`, `getStorefrontProduct(slug)`, `getVariantById(id)`
  - `src/lib/storefront-catalog-dto.ts`: `toStorefrontCatalogProduct()`, which produces absolute media URLs
  - `src/lib/services/inventory.ts`: `availableFor(variantId)`
  - `src/lib/services/packs.ts`: `getActivePacksFor(productId)`
  - cross-sells: the logic behind `getCrossSells` in `src/lib/storefront/data.ts`. Don't import storefront loaders, which are `unstable_cache` and Next-only. Reimplement or reuse the underlying service query.
  - Option definitions are generic strings (`optionDefinitions`, `variant.options[]`).
  - `getOrderEditState(orderId).snapshot.items` gives the current lines (in `src/lib/services/order-edits.ts`).

## Files to Create

- `src/lib/whatsapp/ai/catalog-tools.ts`: `createCatalogTools(ctx)`.

## Files to Modify

- `src/lib/whatsapp/ai/agent.ts`: merge `createCatalogTools(ctx)` into the tool set only for the enabled flags. Pass `catalogEnabled` and `crossSellEnabled` into the prompt context. Collect `product_card` enqueues so they're sent before the text replies: enqueue them during tool execution and give the text reply a dedupe index after the cards.
- `src/lib/whatsapp/ai/prompt.ts`: add the catalog rules, shown only when enabled.

## Technical Details

### Tools

| Tool | Flag | Input | Behaviour |
|---|---|---|---|
| `sendProductCards` | catalog | `{ productSlugs: string[] (1..3), note?: string }` | For each active product: first image URL (absolute), then enqueue `product_card` with dedupe `card:${conversationId}:${slug}:${casablancaDate}`, so each product is sent once per day per conversation. Returns `{ sent: [...slugs], skipped: [...] }`. |
| `checkAvailability` | catalog | `{ productSlug, options: string[] }` | Exact variant match on option values (case- and accent-insensitive). Returns `{ available: boolean, alternatives: [{ options, variantId }] (max 3, in stock, closest first) }`. |
| `matchProductPhoto` | catalog | `{ description: string }` | See "Photo matching" below. |
| `proposeOrderEdit` | edit proposals | `{ ref, lines: [{ variantId, qty }], summary }` | See below. |
| `suggestCrossSell` | cross-sell | `{ productSlug }` | At most once per conversation: check `app_state` key `wa_crosssell:${conversationId}`, then set it. Returns one related in-stock product with name, price and link. |

**Card caption format** (French, or Arabic for an `ar`/`darija_arabic` conversation):

```
*{name}* — {price} DH
Disponible : {in-stock option values joined ", "}
{packs line if any: "2 pour {X} DH"}
{productUrl}
```

At most 1000 characters.

**Closest alternative ranking:** variants sharing the most option values with the request, ties broken by numeric distance when both values are numeric strings (e.g. "42" vs "41"/"43"), then by availability.

**Photo matching:** the model describes the photo itself from the image it received, then calls this tool with the description. Score active products by token overlap of the description against name, category and description (accent-insensitive, French/Arabic stopwords removed). Return the top 3 with scores. If the best score is below a threshold (0.35 normalized overlap), return `{ match: null }`. The prompt then requires the model to say it isn't sure and ask for the product name or link. **Never guess.**

**`proposeOrderEdit`:**
- The order must be linked with `full` access.
- Every variant must be in stock (`availableFor >= qty`), otherwise return `{ error: "out_of_stock", alternatives }`.
- Call `createProposal`. Don't call `flagHandoff`: the AI keeps the conversation and tells the customer an advisor will validate the change. The pending proposal appears on the order page (task 25).
- Returns `{ proposed: true }`.
- **Never compute or state a new total.** The prompt says: "Le nouveau total sera confirmé par un conseiller."

### Prompt additions (when enabled)

- Use `sendProductCards` when the customer asks about a product, with max 3 cards per turn, then one short text line.
- Only propose in-stock options. Offer the closest alternative if one is out of stock.
- For photos: describe them, call `matchProductPhoto`, and if `match` is null, say so honestly.
- Order changes go only through `proposeOrderEdit`, before confirmation. Don't announce prices or totals for edits.
- Cross-sell: at most one suggestion, only after the question is answered, and never pushy.

## Acceptance Criteria

- [ ] With the flags OFF (default), the agent tool set is unchanged from task 17.
- [ ] Unit test `scripts/unit/whatsapp-catalog-tools.test.mjs` covers:
  - cards are deduped per day and contain the price from the DB
  - an out-of-stock request returns the nearest numeric alternative ("42" gives "41"/"43")
  - low-score photo matching returns null
  - `proposeOrderEdit` on a confirmed order gives an error, and on an editable order creates a pending proposal
  - cross-sell happens at most once
- [ ] No tool output contains a computed total for an edit.
- [ ] Lint and tsc pass.
