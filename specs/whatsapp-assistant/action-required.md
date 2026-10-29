# Action Required: WhatsApp Assistant

Manual steps that must be completed by a human. These cannot be automated.

## Before Implementation

- [ ] **Approve the AGENTS.md exception**: the permitted inbound Evolution webhook. Already approved in planning (2026-10-29); task 01 writes it.
- [ ] **Get a dedicated WhatsApp SIM** for each store. Never use the admin's personal number. Start warming it up (normal manual chats for about 2 weeks) before turning on automated sends.
- [ ] **Add 4 GB of swap on the VPS** and plan Coolify memory limits: CRM about 1 GB, Evolution 768 MB, Postgres 512 MB. Coolify runs the store CRM and Evolution side by side.

## During Implementation

- [ ] **Deploy Evolution API v2 on Coolify** (with Postgres and Redis) on the private network, following `docs/whatsapp.md` from task 01. Create one instance per store and pair it by scanning the QR code in the password-protected manager.
- [ ] **Set the runtime env** in Coolify:
  - `EVOLUTION_BASE_URL`, `EVOLUTION_INSTANCE`, `EVOLUTION_API_KEY`
  - `WHATSAPP_WEBHOOK_SECRET` (≥32 random characters)
  - `OPENROUTER_API_KEY`
  - optional model overrides: `WHATSAPP_CHAT_MODEL`, `WHATSAPP_CHAT_FALLBACK_MODEL`, `WHATSAPP_AUDIO_MODEL`, `WHATSAPP_AUDIO_FALLBACK_MODEL`
- [ ] **Configure the Evolution instance webhook**:
  - URL: `https://<crm-domain>/api/whatsapp/webhook/<WHATSAPP_WEBHOOK_SECRET>`
  - header `x-webhook-secret: <WHATSAPP_WEBHOOK_SECRET>`
  - events: `MESSAGES_UPSERT` and `CONNECTION_UPDATE` only
  - "webhook by events" OFF; base64 in webhook OFF
- [ ] **Record about 5 short Darija voice notes** with typical questions (e.g. "wach kayn livraison l Agadir", "bghit nbdel l'adresse", "fin wsal colis dyali"). Save them as OGG/Opus files in a local folder for the evaluation harness (task 26). Don't commit real customer audio.
- [ ] **Write the FAQ text** (delivery times, COD, return policy, sizes) and set the admin alert phone number(s) and assistant name in `/crm/parametres` → WhatsApp.

## After Implementation

- [ ] **Run the Darija evaluation** (task 26) against candidate models and pick the chat and audio models by reading the answers.
- [ ] **Turn features on gradually** in `/crm/parametres`, in this order:
  1. `enabled`
  2. notifications
  3. AI replies
  4. auto-block
  5. catalog suggestions
  6. order-edit proposals

  Keep the daily cap at about 40 during warm-up and raise it gradually.
- [ ] **Map courier raw statuses** in the CRM "Statuts transporteur" screen (task 19) as real parcels move, so out-for-delivery and delivery-issue messages turn on.
- [ ] **Add Evolution's Postgres to the Coolify backup schedule** and set up off-site backups (S3 or Backblaze) for both the CRM snapshot and Postgres.
- [ ] **Get Sendit API credentials and docs** (account, API key, endpoint documentation). Task 27 is blocked until then.
- [ ] **Add a consent line** at checkout or in `/confidentialite` mentioning WhatsApp order updates (Moroccan law 09-08). The storefront copy is in `store.config.ts`.

---

> These tasks are also referenced in context within the relevant task files.
