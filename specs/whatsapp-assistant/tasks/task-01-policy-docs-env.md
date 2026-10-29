# Task 01: Policy exception, docs and env examples

## Status

complete

## Wave

1

## Description

`AGENTS.md` currently forbids webhook automation ("Never reintroduce Google Sheets or webhook automation"), and the existing specs list new couriers as non-goals. The owner approved a **narrow exception** for one thing only: the authenticated inbound Evolution API WhatsApp webhook, which stores the event and processes it later. This task writes that exception and documents the WhatsApp feature for operators:
- deploying Evolution on Coolify
- env vars
- pairing the number
- warm-up
- VPS sizing
- backups

It also adds the new env vars to `.env.example`. No runtime code changes.

## Dependencies

**Depends on:** None (Wave 1)
**Blocks:** None (documentation only; other tasks reference the names defined here)

**Context from dependencies:** None.

## Files to Create

- `docs/whatsapp.md`: operator guide for the WhatsApp assistant.

## Files to Modify

- `AGENTS.md`: add the webhook exception, the WhatsApp ownership boundaries and the WhatsApp invariants.
- `docs/operations.md`: a short "WhatsApp (optional)" section linking to `docs/whatsapp.md`, plus VPS sizing, swap and memory limits.
- `.env.example`: the new optional env vars, commented, with empty values.

## Technical Details

### AGENTS.md changes

1. Replace the line `- Never reintroduce Google Sheets or webhook automation.` with:
   `- Never reintroduce Google Sheets or webhook automation. Sole exception: the authenticated inbound Evolution WhatsApp webhook at /api/whatsapp/webhook/[secret], which only stores raw events (store-then-process) for the whatsapp worker.`
2. Add to "Ownership and integration boundaries":
   - `src/lib/whatsapp/`: Evolution client, phone/JID helpers, copy, media, AI (OpenRouter) agent and tools.
   - `src/lib/services/whatsapp-*.ts`: settings, outbox (sole writer of `wa_outbox`), conversations, strikes, drafts/proposals/requests, inbound events, AI usage.
   - `src/lib/workers/whatsapp.ts`: sole sender of WhatsApp messages and sole processor of inbound events.
3. Add these invariants:
   - WhatsApp is optional and inert unless `EVOLUTION_*` env and the `whatsapp_settings.enabled` toggle are set. Every risky sub-feature is OFF by default.
   - The customer writes first. The store never sends an unsolicited first message to a customer without prior human contact (confirmation or `no_answer`×2 relance). Plain text only, no templates.
   - Store-initiated messages respect the sending window, the daily cap and random gaps. AI replies and admin alerts are exempt from the window.
   - An uncertain send becomes `uncertain` and is never retried automatically.
   - The AI never creates, confirms, cancels or prices orders. It writes drafts and proposals that a human applies through existing services (`confirmOrder`, `cancelOrder`, `editOrder`).
   - Order details go only to the matching phone. Other numbers get status only, with ref plus the phone's last 4 digits.
   - Owner courier raw-status mappings feed notifications only and never stock.
   - Never log phone numbers or message bodies. Media retention defaults to 90 days.

### docs/whatsapp.md outline

1. **Overview**: what the feature does, the safety principles, and that everything is OFF by default.
2. **Hosting on Coolify (4 cores / 8 GB)**:
   - Steady RAM for one store is about 2–2.5 GB. Next.js builds spike to 1.5–2 GB.
   - Add 4 GB of swap: `fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`, plus an fstab entry.
   - Memory limits: CRM about 1 GB, Evolution 768 MB, Postgres 512 MB.
   - One Evolution server can host several instances, one per store.
3. **Deploy Evolution API v2**:
   - Coolify service with Postgres and Redis, private Docker network.
   - Expose only the manager UI behind a password, used once to scan the QR code.
   - Example compose env keys: `AUTHENTICATION_API_KEY`, `DATABASE_PROVIDER=postgresql`, `DATABASE_CONNECTION_URI`, `CACHE_REDIS_ENABLED=true`, `CACHE_REDIS_URI`.
   - Check the variable names against the deployed Evolution v2 version.
4. **Instance and webhook**:
   - Create an instance named after the store slug and pair it by QR.
   - Webhook URL: `https://<crm-domain>/api/whatsapp/webhook/<WHATSAPP_WEBHOOK_SECRET>`.
   - Header: `x-webhook-secret: <WHATSAPP_WEBHOOK_SECRET>`.
   - Events: `MESSAGES_UPSERT` and `CONNECTION_UPDATE` only.
   - "webhook by events" OFF; base64 OFF (media is fetched on demand).
5. **CRM env vars** (table, see below).
6. **Number warm-up**:
   - Dedicated SIM. Normal manual chats for about 2 weeks.
   - Start with the daily cap at 40 and raise it gradually.
   - Never use the admin's personal number.
   - Why: unofficial clients get banned for unsolicited bursts and identical texts, and customer "Report" taps are the main cause.
7. **Turning features on**: enabled, then notifications, then AI, then auto-block, then catalog, then edit proposals. Explain the kill switch.
8. **Costs**: model table with prices checked 2026-10-29; the daily budget cap.
9. **Backups**: CRM `npm run backup` includes the WhatsApp tables. Add Evolution Postgres to the Coolify backups. Off-site copy. Losing the Evolution DB only means re-pairing by QR.
10. **Privacy**: consent line, 90-day media retention, no phone numbers or bodies in logs.
11. **Troubleshooting**:
    - Number disconnected: the CRM banner shows it. Re-scan the QR code.
    - `uncertain` sends: check on the phone, then mark them in the inbox.
    - Budget cap reached.

### Environment Variables (add to `.env.example`, commented and empty)

- `EVOLUTION_BASE_URL`: e.g. `http://evolution:8080`, the private network URL. HTTPS required unless the host is loopback or a private hostname.
- `EVOLUTION_INSTANCE`: instance name, e.g. `mystore`.
- `EVOLUTION_API_KEY`: instance or global API key (secret).
- `WHATSAPP_WEBHOOK_SECRET`: ≥32 random characters, used in the webhook path and the `x-webhook-secret` header.
- `OPENROUTER_API_KEY`: already exists for the CRM assistant; reused.
- `WHATSAPP_CHAT_MODEL`: default `z-ai/glm-5.3-flash`.
- `WHATSAPP_CHAT_FALLBACK_MODEL`: default `deepseek/deepseek-v4.1-flash`.
- `WHATSAPP_AUDIO_MODEL`: default `google/gemini-2.5-flash-lite`.
- `WHATSAPP_AUDIO_FALLBACK_MODEL`: default `qwen/qwen3.8-omni-flash`.

## Acceptance Criteria

- [ ] `AGENTS.md` contains the exact exception sentence and the new invariants, and every other line is unchanged.
- [ ] `docs/whatsapp.md` covers all 11 sections and contains no real secrets or phone numbers.
- [ ] `.env.example` lists the new vars, commented and empty.
- [ ] `npm run test:release-tree` still passes. If it checks the docs list, add `docs/whatsapp.md` to the allowed public files.

## Notes

Don't modify the other spec folders. Their non-goals are historical; this spec supersedes them for WhatsApp and Sendit.
