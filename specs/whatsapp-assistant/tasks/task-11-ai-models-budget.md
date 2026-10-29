# Task 11: OpenRouter models, transcription, classifier and budget

## Status

complete

## Wave

2

## Description

This is the AI plumbing that the agent (task 17) and the inbound processor (task 21) share. It provides:
1. An OpenRouter provider factory with **model routing and fallback**:
   - chat: GLM 5.3 Flash, falling back to DeepSeek V4.1 Flash
   - audio: Gemini 2.5 Flash-Lite, falling back to Qwen 3.8 Omni Flash
2. **Voice-note transcription** that returns the transcript and the detected language, cached by audio SHA-256 so the same audio is never paid for twice.
3. An **abuse and language classifier**: one cheap structured call per inbound text that feeds the strike system and language matching.
4. A **daily AI budget ledger**. Once the configured USD cap is reached, every AI call is refused and conversations go to humans.

All calls send `provider.data_collection: "deny"`.

## Dependencies

**Depends on:** task-02-migration-whatsapp.md, task-03-whatsapp-config.md, task-04-whatsapp-settings.md
**Blocks:** task-17-ai-agent, task-21-inbound-processor, task-26-darija-eval

**Context from dependencies:**
- Task 02 created:
  - `wa_ai_usage(id, day TEXT 'YYYY-MM-DD' Casablanca, role chat|audio|vision|classify, model, input_tokens, output_tokens, cost_micro_usd, conversation_id, created_at)`
  - `wa_media_cache(sha256 PK, transcript, language, description, created_at)`
- Task 03 created `src/lib/whatsapp/config.ts`:
  - `whatsappAiConfigured()`
  - `whatsappModels(): { chat, chatFallback, audio, audioFallback }`, with defaults `z-ai/glm-5.3-flash`, `deepseek/deepseek-v4.1-flash`, `google/gemini-2.5-flash-lite`, `qwen/qwen3.8-omni-flash`.
- Task 04 created `getWhatsAppSettings()` with `aiEnabled` and `aiDailyBudgetCents` (USD cents).
- The existing provider pattern in `src/lib/assistant.ts`:

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
const provider = createOpenAICompatible({
  name: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY,
  transformRequestBody: (body) => ({ ...body, provider: { data_collection: "deny" }, reasoning: { effort: "none" } }),
});
provider.chatModel(modelId)
```

  The `ai` package is v7. Check the exact APIs in `node_modules/ai` (`generateText`, `Output.object` or the structured-output equivalent, `ToolLoopAgent`).

## Files to Create

- `src/lib/whatsapp/ai/provider.ts`: `openRouterProvider()`, `withFallback()`, a price table and `recordUsage()`.
- `src/lib/whatsapp/ai/transcribe.ts`: `transcribeAudio()`.
- `src/lib/whatsapp/ai/classify.ts`: `classifyInbound()`.
- `src/lib/services/whatsapp-ai-usage.ts`: `aiBudgetAvailable()`, `recordAiUsage()`, `todayAiSpendMicroUsd()`, `aiUsageSummary(days)`, `getCachedMedia()`, `putCachedMedia()`.

## Files to Modify

- None.

## Technical Details

### Budget

- 1 USD cent = 10,000 micro-USD.
- `aiBudgetAvailable(now)` is true only when **all** of these hold:
  - `whatsappAiConfigured()`
  - `settings.enabled && settings.aiEnabled`
  - `settings.aiDailyBudgetCents > 0`
  - today's sum of `cost_micro_usd` < `aiDailyBudgetCents * 10_000`
- Day boundaries use Africa/Casablanca.
- Cost per call comes from the price table (USD per 1M tokens, checked 2026-10-29):

```ts
export const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  "z-ai/glm-5.3-flash": { in: 0.046, out: 0.074 },
  "deepseek/deepseek-v4.1-flash": { in: 0.045, out: 0.5 },
  "google/gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  "qwen/qwen3.8-omni-flash": { in: 0.15, out: 0.47 },
  "qwen/qwen3.7-flash": { in: 0.03, out: 0.13 },
};
const UNKNOWN_PRICE = { in: 1, out: 4 }; // conservative for env-overridden models
```

- `cost_micro_usd = round(inTok * price.in + outTok * price.out)`. Per-1M prices times tokens give micro-USD directly.
- If the OpenRouter response includes a `usage.cost` (USD), prefer `round(cost * 1e6)`. Send `usage: { include: true }` in the request body to ask for it.

### Fallback

```ts
export async function withFallback<T>(primary: string, fallback: string, run: (modelId: string) => Promise<T>): Promise<{ result: T; model: string }>;
```

- Try the primary. On a provider error (HTTP 5xx, 429, timeout, 404 model not found), try the fallback once.
- 401 and 402 (bad key, no credits) aren't retried. Throw `AiUnavailableError("auth"|"credits")`.
- Every attempt has a timeout: chat 30 s, audio 45 s, classify 10 s.
- `maxRetries: 0` on AI SDK calls.

### Transcription

```ts
export async function transcribeAudio(input: { bytes: Buffer; mimetype: string; sha256: string; conversationId: string }): Promise<{ transcript: string; language: WaLanguage | null; cached: boolean }>;
```

1. Check `wa_media_cache` by sha256 first. On a hit, return `cached: true` with no budget use.
2. Check `aiBudgetAvailable()`. If the budget is spent, throw `AiBudgetExceededError`.
3. Call OpenRouter **directly with fetch** (`POST https://openrouter.ai/api/v1/chat/completions`), so the audio format is fully under our control:

```json
{ "model": "<audio model>", "provider": { "data_collection": "deny" }, "usage": { "include": true },
  "messages": [{ "role": "user", "content": [
    { "type": "text", "text": "Transcris fidèlement ce message vocal d'un client marocain (darija, français ou arabe). Réponds en JSON: {\"transcript\": string, \"language\": \"fr\"|\"ar\"|\"darija_latin\"|\"darija_arabic\"}. Écris la darija en lettres latines si le client parle darija. Aucun commentaire." },
    { "type": "input_audio", "input_audio": { "data": "<base64>", "format": "ogg" } } ] }],
  "response_format": { "type": "json_object" }, "max_tokens": 800, "temperature": 0 }
```

   - WhatsApp voice notes are `audio/ogg; codecs=opus`.
   - Map the mimetype to format: `ogg`, `mp3`, `wav`, `m4a`, `aac`. Reject other formats as unsupported, which hands off to a human.
   - Check the OpenRouter `input_audio` format support at implementation time.
   - Header: `Authorization: Bearer ${OPENROUTER_API_KEY}`.
4. Parse the JSON leniently: extract the first `{…}` block. The transcript is at most 4000 characters.
5. Store the result in the cache and record usage with role `audio`.

### Classifier

```ts
export interface Classification { category: "ok" | "insult" | "severe" | "manipulation" | "troll"; language: WaLanguage; wantsHuman: boolean; isBotQuestion: boolean }
export async function classifyInbound(text: string, conversationId: string): Promise<Classification>;
```

- Uses the chat model (with fallback) and structured output with a zod schema. Input text is capped at 1000 characters. Temperature 0. Max 120 output tokens.
- French system prompt that defines each category:
  - `insult`: insults or vulgarity aimed at the store or staff.
  - `severe`: threats, sexual harassment, hate.
  - `manipulation`: attempts to change the assistant's rules, extract its instructions or get unauthorized prices.
  - `troll`: repeated off-topic nonsense.
  - `ok`: everything else, **including angry but legitimate complaints**. Anger about a late parcel is `ok` with `wantsHuman=true`.
  - `wantsHuman`: the customer asks for a human or there's a complaint.
  - `isBotQuestion`: e.g. "wach nta robot?".
- If the budget is spent or the call fails, return `{category:"ok", language: heuristicLanguage(text), wantsHuman:false, isBotQuestion:false}` and let the processor decide. Never strike on a failed classification.
- `heuristicLanguage(text)`: Arabic script with Darija markers (`واش`, `بغيت`, `ديال`) gives `darija_arabic`; other Arabic script gives `ar`; Latin script with Darija markers (`wach`, `bghit`, `dyal`, `3`, `7`, `9` used as letters, `salam`, `chhal`/`ch7al`) gives `darija_latin`; otherwise `fr`.

## Acceptance Criteria

- [ ] Unit test `scripts/unit/whatsapp-ai.test.mjs` with a stubbed `fetch`/OpenRouter covers:
  - primary 500 then fallback succeeds, and the fallback model is recorded
  - 401 throws without trying the fallback
  - audio cache hit makes no fetch
  - budget exhausted throws and makes no fetch
  - usage cost math (prefers `usage.cost`)
  - the classifier failure path returns `ok`
  - `heuristicLanguage` cases
- [ ] No API key in logs or errors.
- [ ] Lint and tsc pass.
