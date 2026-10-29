# Task 21: Inbound processor

## Status

complete

## Wave

4

## Description

This is the brain that turns one stored webhook event into stored messages, safety decisions and (optionally) an AI reply. For each claimed `wa_inbound_events` row, the worker (task 24) calls `processInboundEvent()`. It handles:
- connection updates
- parsing customer messages (text, voice note, image)
- linking the conversation to orders
- downloading and transcribing media
- spam and abuse detection, strikes and warnings
- language detection
- debouncing bursts of messages, then deciding between AI reply, handoff or silence
- enqueueing replies through the outbox

It's pure orchestration over services from earlier tasks.

## Dependencies

**Depends on:** task-07-outbox-service.md, task-08-conversations-service.md, task-09-strikes-autoblock.md, task-10-webhook-ingest.md, task-11-ai-models-budget.md, task-16-media-pipeline.md, task-17-ai-agent.md
**Blocks:** task-24-whatsapp-worker

**Context from dependencies:**
- **Task 10** (`src/lib/services/whatsapp-inbound-events.ts`): a claimed event is `{ id, eventType: "messages.upsert"|"connection.update", payload, attempts, lease }`. For `messages.upsert`, the payload is a single Evolution message object: `{ key: { remoteJid, fromMe, id, senderPn?, remoteJidAlt? }, pushName?, message: {...}, messageType?, messageTimestamp, instance? }`. Result functions: `markInboundDone`, `markInboundIgnored(id, lease, reason)`, `markInboundRetry(id, lease, err)`, `markInboundFailed`.
- **Task 05** (`src/lib/whatsapp/phone.ts`): `jidToPhone(jid)` returns null for groups, broadcast, `@lid` and non-Moroccan numbers. `maskPhone`. In `copy.ts`: `msgStrikeWarning({ locale, storeName, assistantName, seed, level })`, `msgHandoff(...)`, `msgAdminAutoBlocked({ maskedPhone, reason })`.
- **Task 08** (`src/lib/services/whatsapp-conversations.ts`):
  - `getOrCreateConversation(phone, jid, displayName)`
  - `insertInboundMessage({ conversationId, waMessageId, kind, body?, media…, createdAt })`, which returns `{ id, duplicate }`
  - `setMessageTranscript`, `linkOrdersFromMessage(conversationId, text)`, which returns `{ linked, failed, locked, newlyLocked }`
  - `setLanguage`, `flagHandoff`, `pauseAi(id, untilIso)`, `logOrderContact(orderId, null, note)`, `getConversation`
- **Task 09** (`src/lib/services/whatsapp-strikes.ts`): `addStrike({ phone, reason, detail?, messageId? })` returns `{action:"none"|"warn"(level 1|2)|"blocked"|"already_blocked"|"needs_human"}`. Reasons: `insult` 2, `severe` (instant), `spam_burst` 1, `manipulation` 1, `ref_guessing` 1. `isPhoneBlocked(phone)` is in `src/lib/services/customers.ts`.
- **Task 16** (`src/lib/whatsapp/media.ts`): `fetchInboundMedia({ waMessageId, remoteJid, expected: "audio"|"image" })` returns `{ relPath, mime, bytes, sha256 }`. It throws `MediaError(kind: "unsupported"|"too_large"|"download"|"permanent")`. Also `imageForVision(relPath)`, which returns `{ base64 }`.
- **Task 11** (`src/lib/whatsapp/ai/transcribe.ts`, `classify.ts`, `src/lib/services/whatsapp-ai-usage.ts`):
  - `transcribeAudio({ bytes, mimetype, sha256, conversationId })` returns `{ transcript, language }`
  - `classifyInbound(text, conversationId)` returns `{ category: ok|insult|severe|manipulation|troll, language, wantsHuman, isBotQuestion }` and never throws on AI failure
  - `aiBudgetAvailable()`, `AiBudgetExceededError`, `AiUnavailableError`
- **Task 17** (`src/lib/whatsapp/ai/agent.ts`): `runWhatsAppAgent({ conversationId, newMessages: [{ kind, text, imageBase64? }] })` returns `{ replies: string[], handedOff }`.
- **Task 07** (`src/lib/services/whatsapp-outbox.ts`): `enqueueOutbox({ dedupeKey, phone, purpose: "ai_reply"|"strike_warning"|"admin_alert", body, conversationId })`.
- **Task 04**: `getWhatsAppSettings()` (`enabled`, `aiEnabled`, `adminPhones`, `adminAlertsEnabled`), `setWhatsAppConnectionState({ state })` and `effectiveAssistantName`. Store name comes from `getStoreSettings().storeName`. Locale for store-initiated text: conversation language mapped to fr or ar, else `storeConfig.locale`.

## Files to Create

- `src/lib/whatsapp/inbound-processor.ts`: `processInboundEvent(ev): Promise<"done"|"ignored"|"retry">`. It calls the mark functions itself.
- `src/lib/whatsapp/parse.ts`: `parseEvolutionMessage(payload)`, pure.

## Files to Modify

- None.

## Technical Details

### parse.ts

```ts
export type ParsedMessage =
  | { type: "text"; waMessageId; jid; phoneJid; pushName; text; timestamp }
  | { type: "audio"; waMessageId; jid; phoneJid; pushName; seconds?: number; timestamp }
  | { type: "image"; waMessageId; jid; phoneJid; pushName; caption?: string; timestamp }
  | { type: "other"; waMessageId; jid; phoneJid; pushName; label: string; timestamp }
  | { type: "skip"; reason: string };
```

| Message field | Parsed type |
|---|---|
| `message.conversation` or `message.extendedTextMessage.text` | text, max 4000 characters |
| `message.audioMessage` | audio |
| `message.imageMessage` (caption) | image |
| `reactionMessage`, `protocolMessage`, `senderKeyDistributionMessage`, `messageContextInfo`-only, `pollUpdateMessage` | skip |
| `videoMessage`, `documentMessage`, `stickerMessage`, `locationMessage`, `contactMessage` | other, with a label like `vidéo` or `document` |

- `phoneJid`: if `key.remoteJid` ends with `@lid`, use `key.senderPn ?? key.remoteJidAlt ?? null`; otherwise `key.remoteJid`. If it's null, skip with `lid_unresolved`.
- `timestamp`: `messageTimestamp` (seconds) converted to ISO. Clamp it to now if it's in the future.

### processInboundEvent flow

**`connection.update`:**
- Read `payload.data?.state ?? payload.state` (`open`, `connecting` or `close`) and call `setWhatsAppConnectionState`.
- If the state went from `open` to `close`, log `wa.disconnected` (warn). The CRM banner (task 22) shows it. There's no WhatsApp alert, since the number is down.
- Mark done.

**`messages.upsert`:**
1. Parse. If the result is `skip`, mark ignored.
2. `phone = jidToPhone(phoneJid)`. If it's null, mark ignored (`non_ma`).
3. `conv = getOrCreateConversation(phone, jid, pushName)`. Insert the message (kind text, audio, image or other; body is the text, caption or `[label]`). If it's a duplicate, mark done.
4. **Blocked**: if `isPhoneBlocked(phone)`, mark done. The message is stored and visible in the inbox, but there's no AI and no reply.
5. **Spam burst**: count this conversation's inbound messages in the last 2 minutes.
   - If the count is above 15 and `ai_paused_until` isn't already in the future: `pauseAi(conv.id, now+30min)`, `addStrike({ phone, reason: "spam_burst" })`, then handle the decision (step 10).
   - Then mark done, with no AI.
6. **Media**:
   - audio: `fetchInboundMedia` and update the message media columns (a small SQL update or a helper in task 08's service; adding a helper in a new file is fine). If `aiBudgetAvailable()`, `transcribeAudio`, then `setMessageTranscript`, and if the conversation has no language yet, `setLanguage(result.language)`.
   - image: fetch and store.
   - `MediaError("download")` gives retry. `unsupported` or `too_large` set a note on the message and `flagHandoff("média non pris en charge")`.
   - A transcription failure isn't fatal: no transcript, hand off.
7. `text = body ?? transcript ?? caption ?? ""`.
8. **Identity**: if the text is non-empty, call `linkOrdersFromMessage`. If `newlyLocked`, call `addStrike({ reason: "ref_guessing" })` and handle the decision.
9. **Contact log**: for each full-access linked order, call `logOrderContact(orderId, null, "WhatsApp : message client")` at most once per Casablanca day. Check for an existing note that day.
10. **Classification**: if the text is non-empty and `settings.enabled && settings.aiEnabled`, call `classifyInbound`. Set the language when it differs and the confidence is implicit (always set it when the conversation language is null; otherwise only for text over 15 characters).

    | Category | Strike reason |
    |---|---|
    | `insult` | `insult` |
    | `severe` | `severe` |
    | `manipulation` or `troll` | `manipulation` |

    Handle the strike decision:

    | Decision | Action |
    |---|---|
    | `warn` | Enqueue `strike_warning` with `msgStrikeWarning({ level })`, dedupe `strike:${messageId}` |
    | `blocked` | No customer message. Enqueue `admin_alert` (`msgAdminAutoBlocked`) to each admin phone, dedupe `admin:autoblock:${phone}:${date}:${adminPhone}`. Then mark done. |
    | `needs_human` | `flagHandoff("seuil de sécurité atteint")`, then mark done |
    | `already_blocked` | Mark done |

    For a severe or insult message, don't run the agent on it after warning.
11. **Debounce**: if another `wa_inbound_events` row is `pending` or `processing` with `json_extract(payload_json,'$.key.remoteJid') = jid` and `received_at` later than this event's, mark done without replying. The later event replies to everything.
12. **Reply decision**: reply only if **all** of these hold:
    - `settings.enabled && settings.aiEnabled`
    - `conv.mode === "ai"`
    - `!conv.needsHuman`
    - not paused
    - not blocked
    - the current message kind isn't `other` (for `other`, send `msgHandoff` once and flag)
    - `classification.wantsHuman` is false. If it's true: `flagHandoff("client demande un conseiller")`, enqueue `msgHandoff` (dedupe `handoff:${conv.id}:${date}`), mark done.
13. **Agent**:
    - `newMessages` are all inbound messages after the latest outbound `ai` or `agent` message in this conversation (max 10). Images become `imageForVision` base64, last 2 images only.
    - Call `runWhatsAppAgent`.
    - Enqueue each reply as `ai_reply` with dedupe `msg:${currentMessageId}:reply:${i}`.
    - If `handedOff` and there are no replies, enqueue `msgHandoff`.
    - On `AiBudgetExceededError` or `AiUnavailableError`: `flagHandoff("IA indisponible")` and `msgHandoff` once per day (dedupe `handoff:${conv.id}:${date}`).
14. Mark done.
15. Any unexpected error: `markInboundRetry` with the redacted error. Never log the text.

**Ordering:** process events oldest first (the worker does this). Run the whole step 3 insert in a transaction. Outbox enqueues each run in their own small transaction.

## Acceptance Criteria

- [ ] Unit or integration test `scripts/unit/whatsapp-inbound.test.mjs` (temp DB, stubbed fetch for Evolution and OpenRouter) covers:
  - text from an order phone links the order and enqueues an AI reply
  - a duplicate event does nothing
  - a group or non-Moroccan number is ignored
  - a blocked phone is stored with no reply
  - 16 messages in 2 minutes pause the AI and add a strike
  - insult gives a warning level 1 enqueued, then repeats give level 2, then blocked with an admin alert (auto-block ON)
  - wants-human gives a handoff message
  - debounce: two quick events give one reply
  - an audio message is downloaded, transcribed, then replied to
  - a budget-exhausted path hands off
  - human mode gives no AI reply
- [ ] Lint and tsc pass.
