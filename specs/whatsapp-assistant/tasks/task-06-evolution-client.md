# Task 06: Evolution API client

## Status

complete

## Wave

2

## Description

A small, typed, server-only HTTP client for the self-hosted Evolution API v2. It covers:
- sending text and image messages
- showing the "composing" presence
- checking whether numbers are on WhatsApp
- downloading inbound media as base64
- reading the connection state

Every call has a timeout, refuses redirects, never logs the API key or bodies, and classifies failures as `retryable`, `permanent` or `unknown`. `unknown` means the send may have happened, and the outbox must not retry it blindly. The client sits behind a `WhatsAppSender` interface so a second number or the official Cloud API can be added later without touching callers.

## Dependencies

**Depends on:** task-03-whatsapp-config.md
**Blocks:** task-16-media-pipeline, task-24-whatsapp-worker

**Context from dependencies:** Task 03 created `src/lib/whatsapp/config.ts`, which exports:
- `evolutionConfig(): { baseUrl, instance, apiKey } | null`, null when not configured; `baseUrl` has no trailing slash.
- `whatsappConfigured()`.

## Files to Create

- `src/lib/whatsapp/evolution.ts`: client plus the `WhatsAppSender` interface and `WhatsAppError`.

## Files to Modify

- None.

## Technical Details

### Interface

```ts
export type WaErrorKind = "retryable" | "permanent" | "unknown";
export class WhatsAppError extends Error { constructor(public kind: WaErrorKind, message: string, public status?: number) { super(message); } }

export interface SendResult { waMessageId: string | null }
export interface NumberCheck { phone: string; exists: boolean; jid: string | null }
export type ConnectionState = "open" | "connecting" | "close" | "unknown";

export interface WhatsAppSender {
  sendText(jidOrNumber: string, text: string): Promise<SendResult>;
  sendImage(jidOrNumber: string, image: { url?: string; base64?: string; mimetype: string; fileName: string }, caption: string): Promise<SendResult>;
  sendPresence(jidOrNumber: string, presence: "composing" | "paused", delayMs: number): Promise<void>;
  checkNumbers(numbers: string[]): Promise<NumberCheck[]>;
  getMediaBase64(waMessageId: string, remoteJid: string, fromMe: boolean): Promise<{ base64: string; mimetype: string }>;
  connectionState(): Promise<ConnectionState>;
}

export function getWhatsAppSender(): WhatsAppSender | null; // null when evolutionConfig() is null
```

### Evolution v2 endpoints

These are the expected shapes. **Check them against the deployed Evolution v2 version** (Swagger at `<base>/docs` or the source) and adjust the field names if they differ. Keep the adjustments inside this file.

| Method | Endpoint | Body | Response |
|---|---|---|---|
| sendText | `POST {base}/message/sendText/{instance}` | `{ number: "2126XXXXXXXX", text }` | `{ key: { id } }` |
| sendImage | `POST {base}/message/sendMedia/{instance}` | `{ number, mediatype: "image", mimetype, caption, media: <url or base64>, fileName }` | `{ key: { id } }` |
| sendPresence | `POST {base}/chat/sendPresence/{instance}` | `{ number, presence: "composing", delay: <ms> }` | |
| checkNumbers | `POST {base}/chat/whatsappNumbers/{instance}` | `{ numbers: ["2126…"] }` | `[{ exists, jid, number }]` |
| getMediaBase64 | `POST {base}/chat/getBase64FromMediaMessage/{instance}` | `{ message: { key: { id, remoteJid, fromMe } }, convertToMp4: false }` | `{ base64, mimetype }` |
| connectionState | `GET {base}/instance/connectionState/{instance}` | | `{ instance: { state } }` |

- Every request sends the headers `apikey: <apiKey>` and `content-type: application/json`.
- The `number` sent is digits only (`212…`), derived by stripping `+` or `@…`.

### Fetch rules

- Use `AbortSignal.timeout(ms)`: 15 s for sends, 10 s for presence and state, 30 s for media download.
- Use `redirect: "error"` and `cache: "no-store"`.
- Cap the response size:
  - Media responses: 25 MB of base64 at most. Abort and throw `permanent` if larger. Read the body as text with a manual length check.
  - JSON responses: 256 KB.

### Error classification (sends)

| Situation | Kind |
|---|---|
| Network error *before* the request was written (DNS failure, ECONNREFUSED) | `retryable` |
| Timeout or abort *after* sending, socket reset mid-response, 5xx, unparseable 2xx body | `unknown`: the message may have gone out |
| 429 | `retryable` |
| 400, 401, 403, 404 | `permanent` (bad number, bad key, instance missing) |
| Error body mentions not on WhatsApp / `exists: false` | `permanent`, with message `not_on_whatsapp` |

- **Non-send calls** (presence, checkNumbers, media, state) never produce `unknown`. Their failures are `retryable` or `permanent`.
- Error messages are short French or English codes. **Never** include the URL with key, the apiKey, the phone number or the text. Use `redactText` from `src/lib/shipping/redact.ts` on any upstream error text before storing it, and truncate to 300 characters.

### Testing hook

The module reads `globalThis.fetch` at call time, so tests can stub it. Export nothing test-specific.

## Acceptance Criteria

- [ ] `getWhatsAppSender()` returns null when unconfigured.
- [ ] Unit test `scripts/unit/whatsapp-evolution.test.mjs` with a stubbed `fetch` covers:
  - correct URL, headers and body for each method
  - timeout during a send gives `unknown`, ECONNREFUSED gives `retryable`, 401 gives `permanent`, 500 gives `unknown`
  - an oversize media response is rejected
  - the apiKey never appears in thrown error messages
- [ ] Lint and tsc pass.
