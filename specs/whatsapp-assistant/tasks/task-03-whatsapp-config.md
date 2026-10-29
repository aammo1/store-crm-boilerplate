# Task 03: WhatsApp env config and boot validation

## Status

pending

## Wave

1

## Description

Add one server-only module that reads and validates every WhatsApp and AI env var, and reports whether the Evolution integration and the WhatsApp AI are configured. The integration must stay **inert when unconfigured**, which is a repo invariant: fresh empty startup needs no paid keys. Misconfiguration should produce boot **warnings**, not failures, unless a value is present but malformed in production, such as a short webhook secret or a non-HTTPS public URL.

## Dependencies

**Depends on:** None (Wave 1)
**Blocks:** task-06-evolution-client, task-10-webhook-ingest, task-11-ai-models-budget

**Context from dependencies:** None. Existing facts:
- `src/lib/env.ts` exports `validateRuntimeEnv()` (throws in production on problems) and `runtimeEnvWarnings()`. Both build arrays of French messages.
- `src/instrumentation.ts` calls `validateRuntimeEnv()` at boot.

## Files to Create

- `src/lib/whatsapp/config.ts`

## Files to Modify

- `src/lib/env.ts`: call into the WhatsApp validator, adding problems and warnings.

## Technical Details

```ts
// src/lib/whatsapp/config.ts
import "server-only"; // only if other server modules use this pattern; otherwise omit

export const WA_DEFAULT_MODELS = {
  chat: "z-ai/glm-5.3-flash",
  chatFallback: "deepseek/deepseek-v4.1-flash",
  audio: "google/gemini-2.5-flash-lite",
  audioFallback: "qwen/qwen3.8-omni-flash",
} as const;

export interface EvolutionConfig { baseUrl: string; instance: string; apiKey: string }

export function evolutionConfig(env = process.env): EvolutionConfig | null;
// Returns null unless EVOLUTION_BASE_URL, EVOLUTION_INSTANCE and EVOLUTION_API_KEY are all non-empty.
// baseUrl: strip trailing "/"; must parse as URL with protocol http: or https:, no username/password, no query/hash.

export function webhookSecret(env = process.env): string | null; // null unless length >= 32
export function whatsappConfigured(env = process.env): boolean;   // evolutionConfig && webhookSecret
export function whatsappAiConfigured(env = process.env): boolean; // whatsappConfigured && OPENROUTER_API_KEY non-empty
export function whatsappModels(env = process.env): { chat: string; chatFallback: string; audio: string; audioFallback: string };
// trimmed env overrides WHATSAPP_CHAT_MODEL, WHATSAPP_CHAT_FALLBACK_MODEL, WHATSAPP_AUDIO_MODEL, WHATSAPP_AUDIO_FALLBACK_MODEL,
// each validated with /^[a-z0-9._-]+\/[a-z0-9._:-]+$/i else default.

export function whatsappEnvIssues(env = process.env): { problems: string[]; warnings: string[] };
```

Rules for `whatsappEnvIssues`:
- No `EVOLUTION_*` var set at all: no problems, no warnings.
- Some but not all of the three `EVOLUTION_*` vars set: **warning** `WhatsApp désactivé : EVOLUTION_BASE_URL, EVOLUTION_INSTANCE et EVOLUTION_API_KEY doivent être tous définis.`
- `EVOLUTION_BASE_URL` malformed: **problem** (fails boot in production) `EVOLUTION_BASE_URL invalide`.
- `EVOLUTION_BASE_URL` uses `http:` and the host is a public FQDN (contains a dot and isn't localhost, a 127.x/10.x/172.16–31.x/192.168.x address or a `.internal`/`.local` name): **warning**, plain HTTP to a public host.
- Evolution configured but `WHATSAPP_WEBHOOK_SECRET` missing or shorter than 32 characters: **problem** `WHATSAPP_WEBHOOK_SECRET doit contenir au moins 32 caractères`.
- Evolution configured but `OPENROUTER_API_KEY` missing: **warning**, the AI stays disabled and only notifications and the inbox work.
- Never include secret values in messages.

In `src/lib/env.ts`, merge `whatsappEnvIssues().problems` into the problems list inside `validateRuntimeEnv`, and merge the warnings into `runtimeEnvWarnings`. Keep the existing behaviour otherwise.

### Environment Variables

- `EVOLUTION_BASE_URL`, `EVOLUTION_INSTANCE`, `EVOLUTION_API_KEY`, `WHATSAPP_WEBHOOK_SECRET`, `OPENROUTER_API_KEY`, `WHATSAPP_CHAT_MODEL`, `WHATSAPP_CHAT_FALLBACK_MODEL`, `WHATSAPP_AUDIO_MODEL`, `WHATSAPP_AUDIO_FALLBACK_MODEL`.

## Acceptance Criteria

- [ ] With no WhatsApp env set, `validateRuntimeEnv` and `runtimeEnvWarnings` return exactly what they return today.
- [ ] Unit test `scripts/unit/whatsapp-config.test.mjs` covers: partial config, a malformed URL, a short secret, a missing OpenRouter key, model override validation, and messages that never contain secret values.
- [ ] Lint and tsc pass.
