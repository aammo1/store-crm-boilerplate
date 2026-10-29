# Requirements: WhatsApp Assistant

## Summary

Moroccan COD customers often don't know where their parcel is. They also get confirmation calls they miss, and they want to ask questions in Darija, often by voice note. Today the CRM only has manual `wa.me` links (`src/lib/wa-templates.ts`).

This feature connects each store copy to its **own** WhatsApp number through a self-hosted **Evolution API** (Baileys). The goals:
- Customers hear about important order and parcel events.
- Customers can write, send voice notes and send images, and a cheap **OpenRouter** AI agent answers them 24/7, wired into the CRM.
- Humans keep control through a CRM inbox, and confirm, cancel or edit orders on top of what the AI prepares.

**Safety comes first** in every decision. The number must not get banned, so:
- The customer sends the first message.
- Outbound sending is slow and paced.
- Messages are plain text with no templates.
- An uncertain send is never resent automatically.
- Each order is only shown to its owner.
- The AI can never create, confirm or price an order on its own.

Every risky feature ships **OFF by default** behind toggles in `/crm/parametres`, plus a master kill switch.

The expected outcome:
- Fewer refused deliveries and missed confirmations.
- Faster answers to customers.
- An admin alert on every confirmed order.
- A strike system that warns or blocks abusive customers.
- AI cost under about $12 a month at 50–200 orders a day.

## Decisions (from the planning interview, 2026-10-29)

**First contact (option A).** The `/merci` page button opens WhatsApp with a pre-filled message that contains the order ref, with varied wording. The customer writes first. Customers who don't click get a WhatsApp message only after human contact:
- the "commande confirmée" message after an agent confirms, or
- **one** relance after **2** `no_answer` contact logs at least 2 h apart. It's a toggle, ON by default.

Nothing more is sent after that. Evolution's number check flags phones with no WhatsApp ("pas de WhatsApp").

**Volume.** 50–200 orders a day now, possibly 200+ later. One Evolution instance (one number) per store copy.

**Outbound pacing.** Applies only to messages the store initiates:
- Sending window 09:00–21:00 Africa/Casablanca (configurable). Anything outside the window is queued until it opens.
- Daily cap of new outbound messages, default 40 during warm-up.
- Random gap of 30–120 s between sends.
- "composing" presence before each send.

AI replies to a customer who just wrote go out 24/7, immediately, with a short human-like typing delay. Admin alerts go out 24/7 unless the "quiet hours" option is on.

**Customer events:**

| # | Event | Behaviour |
|---|---|---|
| 1 | Order confirmed | Ships now |
| 2 | Parcel created with tracking number | Ships now |
| 5 | Delivered | Ships now; agent-declared or tracking via `setDeliveryOutcome` |
| 3 | Out for delivery | Switches on once the owner maps courier raw statuses |
| 4 | Delivery issue / postponed | Switches on once the owner maps courier raw statuses |
| 6 | Refused | **Admin alert only**, plus a strike for the customer |
| 7 | Cancelled | OFF by default |

At most one message per event per order.

**Admin alert.** Sent on every confirmation (by anyone) to the admin number(s) in settings, plain text, **city only, no address**. Example:
`✅ Confirmée #A1B2C3 · 2× Produit X (42) · 398 DH · Casablanca · par Salma`

**Strike system:**

| Reason | Points |
|---|---|
| Insult | 2 |
| Severe (threat, sexual content) | Instant block |
| Spam burst (>15 messages in 2 min) | 1, plus a 30 min AI pause |
| Refused delivery | 2 |
| ≥3 cancelled after confirmation | 1 |
| Manipulation / prompt injection / trolling | 1 |
| Order-ref guessing (≥3 failed matches) | 1, plus a 24 h identity lock |

Escalation:
- 1 point: polite warning.
- 2 points: final warning.
- ≥3 points or a severe case: **automatic block** (`blocked_phones`, source `system`).

What a block does:
- The AI goes silent.
- New orders from the phone are flagged and held for agents. Checkout stays unchanged.
- The admin gets an alert.
- One-click unblock in the CRM.

Strikes expire after 90 days. Auto-block is a toggle, OFF by default. Warnings still apply while it's OFF.

**AI autonomy:**

| AI does alone | AI proposes, a human approves | Human only |
|---|---|---|
| Order status and tracking | Mark "prêt à confirmer" (agent clicks Confirm) | Complaints, damage, refunds |
| FAQ from admin-written text | Cancellation request | Angry customers |
| Collect address and city as a draft | Order edits before confirmation (later phase) | |
| Pre-sales answers | | |
| Send product links | | |
| Catalog suggestions (later phase) | | |

The AI hands off whenever it's unsure. It never discounts, beyond packs and upsell applied by the server. It never creates or confirms orders.

**No-order pre-sales.** The AI answers questions and sends the product link (`/produit/[slug]`), so the customer goes through normal checkout. If the customer refuses checkout, the AI collects name, items, city and address into a **"demande WhatsApp"**, and an agent turns it into a manual order. Conversations show as leads.

**Language.** The AI replies in the customer's language and script: Darija in Latin letters, Darija in Arabic script, French, or Arabic.
- Store-initiated messages use the store locale (`store.config.ts` fr/ar) until the customer's language is known.
- Tone is polite, short (≤3 lines) and uses "vous", with at most one emoji.
- The assistant name is a setting, defaulting to `Service client {storeName}`.
- If the customer asks, the AI says honestly that it's an assistant and offers a human.

**Models.** All via OpenRouter and env-configurable. Live prices checked 2026-10-29, per 1M tokens:

| Role | Model | Price (in/out) | Fallback |
|---|---|---|---|
| Chat + tools + abuse classification | `z-ai/glm-5.3-flash` | $0.046 / $0.074, sees images | `deepseek/deepseek-v4.1-flash` |
| Voice transcription | `google/gemini-2.5-flash-lite` | | `qwen/qwen3.8-omni-flash` |
| Images | Main chat model (vision) | | |

Requests send `provider.data_collection: "deny"`. A daily AI budget cap applies: when it's reached, the AI stops and conversations go to humans. Transcripts are cached by audio SHA-256. A Darija evaluation set (about 30 text and 5 voice notes recorded by the owner) runs before go-live.

**Identity and privacy:**

| Situation | Access |
|---|---|
| WhatsApp number = order phone | Full access |
| Other number + ref + last 4 digits of the order phone | Status and tracking only, no name or address; changes go to an agent |
| Ref only | Nothing revealed |
| Several orders | AI lists short ref, date and stage, then asks which one |

Media is stored under `data/uploads/wa/` and deleted after 90 days. Transcripts are kept.

**CRM inbox `/crm/whatsapp`:**
- Conversation list and chat view with an audio player, transcript and images.
- Badges: AI, needs human, strike, blocked, linked order.
- Filters: "à traiter", "mes conversations", all. Mobile-friendly.
- "Prendre la main" pauses the AI. "Rendre à l'IA" resumes it, and so does 12 h without an agent reply (configurable).
- Agents see conversations linked to their assigned orders plus unassigned ones. Admins see everything and can block, unblock, change settings and use the kill switch.
- Each order page gets a WhatsApp panel. Messages are logged in `order_contacts` (channel `whatsapp`).

**Catalog (later phase).** Uses the CRM catalog only, never the native WhatsApp catalog.
- Sends image, caption (name, MAD price, available options, packs) and link, max 3 products per message.
- Proposes only variants in stock, plus the closest alternative when something is out of stock.
- Matches customer photos without guessing.
- Order changes go to a proposal that an agent approves through `editOrder()`.
- Cross-sell is OFF by default and limited to one suggestion per conversation.

**Couriers:**
- One courier per store copy.
- Groundwork: a `provider` column on submissions and cities, plus an owner-maintained **raw-status mapping screen** that powers notifications 3 and 4. Owner mappings never change stock.
- Sendit adapter is the last phase, **blocked until API credentials and docs exist**.

**Hosting:**
- Coolify on a 4-core / 8 GB VPS running Coolify, the store CRM and Evolution (with Postgres and Redis) side by side.
- 4 GB swap and container memory limits: CRM about 1 GB, Evolution 768 MB, Postgres 512 MB.
- Evolution is reachable only on the private Docker network, except its password-protected manager used once for QR pairing.
- Off-site backups.

## Goals

- Customers get plain-text WhatsApp updates for confirmed, shipped and delivered orders. Out-for-delivery and delivery-issue updates follow once statuses are mapped.
- The admin gets a WhatsApp alert for every confirmed order.
- Inbound text, audio and images are stored, transcribed or understood, shown in a CRM inbox, and answered by an AI agent or a human.
- Abusive customers are warned, then blocked automatically (toggle), with an audit trail and one-click undo.
- The AI uses the CRM catalog to answer and propose, and humans approve every order mutation.
- Number ban risk is kept to a minimum through customer-first contact, pacing, a cap, a window, varied wording and no blind resend.
- The groundwork is in place for courier status mapping and a second courier (Sendit).

## Non-Goals

- No official WhatsApp Cloud API, no Meta message templates, no native WhatsApp Business catalog sync.
- No multi-number rotation or multi-tenant Evolution routing. One instance per store, though the code keeps the sender behind an interface.
- No AI-created orders, AI confirmations, AI cancellations or AI discounts.
- No unsolicited first message to a customer who hasn't had human contact or written first.
- No broadcast or marketing campaigns.
- No Google Sheets or other webhook automation. The **only** permitted webhook is the authenticated inbound Evolution webhook.
- No filling `src/lib/shipping/status-map.ts` `STATUS_MAP` with guessed values. Owner mappings feed notifications only, never stock.
- No Sendit implementation until credentials and docs are provided (task 27 is blocked).
- No vector database. The catalog is small, so search uses SQL and LLM matching.

## Acceptance Criteria

- [ ] With every WhatsApp env var unset, the app boots, builds and passes every existing test unchanged. All WhatsApp features are inert.
- [ ] With Evolution configured and `enabled` ON, these events each enqueue exactly one outbox row (dedupe key per order and event):
  - confirming an order: customer message plus admin alert
  - parcel submission: shipped message
  - delivered outcome: delivered message
- [ ] Notifications respect the window, cap and gaps. Admin alerts and AI replies bypass the window.
- [ ] A send whose result is unclear ends as `uncertain` and is never retried automatically. The CRM shows it for manual reconciliation.
- [ ] POSTs to the webhook without the correct secret get 401 or 404. Valid events are stored and acknowledged in under 100 ms of work, and the same WhatsApp message ID is processed only once.
- [ ] Inbound text, audio (with transcript) and images appear in `/crm/whatsapp` and on the linked order page.
- [ ] The AI answers status questions only for orders the phone owns, collects address drafts, flags "prêt à confirmer", hands off complaints, and never mutates prices or confirms.
- [ ] Strikes accumulate and expire. Warnings are sent. Auto-block (when ON) adds `blocked_phones` with source `system`, silences the AI and alerts the admin. Unblock works.
- [ ] Kill switch OFF stops all outbound sends and AI calls within one worker tick. The inbox still records inbound messages.
- [ ] Daily AI budget cap stops AI calls and routes conversations to humans.
- [ ] Unmapped courier raw statuses are listed for the owner to map. Mapped out-for-delivery and issue statuses trigger notifications 3 and 4. No stock change ever results from a mapping.
- [ ] `npm run lint`, `npx tsc --noEmit`, `npm run test:unit`, `npm run test:crm` and `DELIVERY_PROVIDER=mock npm run build` pass. `npm run perf-budget` stays within 122,880 B.

## Assumptions

- Evolution API v2 is self-hosted on the same Coolify VPS. The CRM reaches it at `EVOLUTION_BASE_URL` over the private network.
- Evolution's webhook can POST to a CRM URL that has a secret path segment, and can send a custom header. Implementers must check endpoint and payload shapes against the deployed Evolution v2 version.
- Customers mostly write from the phone used at checkout.
- The admin provides a dedicated WhatsApp SIM, warmed up over about 2 weeks.
- The OpenRouter model IDs listed above stay available. They're env-configurable if not.
- One long-lived Node process owns workers per DB (existing worker lease).

## Technical Constraints

- All `AGENTS.md` invariants stay in force:
  - prices recomputed on the server
  - inventory is the sole stock writer
  - parcel creation only by the submission worker, tracking only by the poller
  - CRM copy in French
  - integer MAD, Africa/Casablanca time
  - secrets only in runtime env
  - nothing personal or secret in logs or URLs
  - the build never opens SQLite
- Side effects follow the existing outbox pattern of `src/lib/services/meta.ts` and `src/lib/workers/meta.ts`: enqueue inside the business transaction, deliver from a leased worker, back off, purge.
- New migration `migrations/028_whatsapp.sql`. Never edit applied migrations. Triggers keep `END;` on one line.
- New worker `whatsapp` registered under the existing worker lease (`src/lib/workers/index.ts`).
- The webhook route lives at `/api/whatsapp/webhook/[secret]`, outside `/api/crm` (middleware browser-origin checks only cover `/api/admin*` and `/api/crm*`).
- WhatsApp settings live in `app_state` key `whatsapp_settings`, a strict zod schema with no secrets, separate from `store_settings`.
- OpenRouter access reuses `@ai-sdk/openai-compatible` and `ai` v7 (already dependencies), the same as `src/lib/assistant.ts`.
- Storefront bundles must not gain zod, libphonenumber, DB or service imports (perf budget ≤122,880 B gzip).
- Every verification uses `DELIVERY_PROVIDER=mock`, temporary DB and media, ephemeral secrets, mocked `fetch` for Evolution and OpenRouter, and `NODE_OPTIONS=--import=$PWD/scripts/block-external-network.mjs`.
