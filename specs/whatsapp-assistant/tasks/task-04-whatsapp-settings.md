# Task 04: WhatsApp settings schema, service and API

## Status

pending

## Wave

1

## Description

Admin-editable, non-secret WhatsApp settings: the kill switch, feature toggles, admin alert phones, pacing, assistant name, FAQ text, the AI budget and retention. They are stored as one JSON blob in `app_state` under key `whatsapp_settings`, separate from `store_settings`, because store settings feed the storefront and trigger revalidation. Every risky feature defaults to OFF. The task also adds a small read helper for the WhatsApp connection state, which the worker writes to `app_state` key `whatsapp_connection`.

## Dependencies

**Depends on:** None (Wave 1)
**Blocks:** task-07, task-09, task-11, task-14, task-15, task-16, task-17 (anything that reads settings)

**Context from dependencies:** None. Existing patterns to copy:
- `src/lib/store-settings-schema.ts`: a strict zod object plus a partial update schema and frozen defaults. Import `z` from `./validation`.
- `src/lib/services/store-settings.ts`: `getStoreSettings()` / `updateStoreSettings()` merging inside a transaction.
- `src/lib/services/app-state.ts`: `getAppState(key)` / `setAppState(key, value)`.
- `src/app/api/crm/settings/route.ts`: GET/PUT with `requireAdmin()` from `src/lib/auth-guards.ts`, `browserMutationAllowed` (handled by middleware for `/api/crm`), and `readLimitedJson` from `src/lib/request-body.ts` with a 4096-byte cap. Errors are French JSON `{ error }`.
- `src/lib/phone.ts` `normalizeMaPhone(raw)` returns `+2126XXXXXXXX` or null.

## Files to Create

- `src/lib/whatsapp-settings-schema.ts`: schema, defaults and types. Browser-safe: zod only, so it's fine for CRM client components but **never import it from storefront code**.
- `src/lib/services/whatsapp-settings.ts`: `getWhatsAppSettings()`, `updateWhatsAppSettings(patch)`, `getWhatsAppConnectionState()`, `setWhatsAppConnectionState(state)`, `effectiveAssistantName(settings, storeName)`.
- `src/app/api/crm/whatsapp/settings/route.ts`: GET/PUT (admin only).

## Files to Modify

- None.

## Technical Details

```ts
export const whatsappSettingsSchema = z.object({
  enabled: z.boolean(),                       // master kill switch: false => no sends, no AI
  notificationsEnabled: z.boolean(),
  notifyConfirmed: z.boolean(),
  notifyShipped: z.boolean(),
  notifyDelivered: z.boolean(),
  notifyOutForDelivery: z.boolean(),
  notifyDeliveryIssue: z.boolean(),
  notifyCancelled: z.boolean(),
  relanceAfterNoAnswer: z.boolean(),
  relanceNoAnswerCount: z.number().int().min(1).max(5),
  adminAlertsEnabled: z.boolean(),
  adminPhones: z.array(z.string().regex(/^\+212[5-7]\d{8}$/)).max(5),
  adminQuietHours: z.boolean(),               // true => admin alerts also respect the window
  sendWindowStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  sendWindowEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  dailyOutboundCap: z.number().int().min(1).max(1000),
  minGapSeconds: z.number().int().min(5).max(600),
  maxGapSeconds: z.number().int().min(5).max(1800),
  aiEnabled: z.boolean(),
  assistantName: z.string().trim().max(60),   // "" => "Service client {storeName}"
  faqText: z.string().max(4000),
  aiDailyBudgetCents: z.number().int().min(0).max(10_000), // USD cents; 0 => AI never called
  aiResumeAfterHours: z.number().int().min(1).max(168),
  autoBlockEnabled: z.boolean(),
  catalogSuggestionsEnabled: z.boolean(),
  crossSellEnabled: z.boolean(),
  orderEditProposalsEnabled: z.boolean(),
  mediaRetentionDays: z.number().int().min(7).max(365),
}).strict().refine(s => s.minGapSeconds <= s.maxGapSeconds, { message: "Écart minimum supérieur au maximum.", path: ["minGapSeconds"] });

export const DEFAULT_WHATSAPP_SETTINGS = Object.freeze({
  enabled: false, notificationsEnabled: false,
  notifyConfirmed: true, notifyShipped: true, notifyDelivered: true,
  notifyOutForDelivery: true, notifyDeliveryIssue: true, notifyCancelled: false,
  relanceAfterNoAnswer: true, relanceNoAnswerCount: 2,
  adminAlertsEnabled: true, adminPhones: [], adminQuietHours: false,
  sendWindowStart: "09:00", sendWindowEnd: "21:00",
  dailyOutboundCap: 40, minGapSeconds: 30, maxGapSeconds: 120,
  aiEnabled: false, assistantName: "", faqText: "", aiDailyBudgetCents: 100, aiResumeAfterHours: 12,
  autoBlockEnabled: false, catalogSuggestionsEnabled: false, crossSellEnabled: false,
  orderEditProposalsEnabled: false, mediaRetentionDays: 90,
});
```

- The update schema is a partial, strict object. Because `.refine` blocks `.partial()`, define the base object first, then derive `.partial().strict()` from it. After merging the patch with the current settings, validate the full object again.
- `updateWhatsAppSettings` runs in `getDb().transaction(...).immediate()`: read, merge, validate, write.
- Before validating, `adminPhones` input is normalized with `normalizeMaPhone` on the server, inside the route or service. Reject invalid phones with `Numéro admin invalide.`
- `getWhatsAppSettings()` falls back to the defaults when the key is missing or the JSON is invalid. If the stored JSON parses but fails the schema, it uses defaults merged with the valid fields, and never throws.
- Connection state shape: `{ state: "open" | "connecting" | "close" | "unknown", updatedAt: string }`, stored in `app_state` key `whatsapp_connection`. `getWhatsAppConnectionState()` returns `{state:"unknown", updatedAt:null}` when it's missing.
- `effectiveAssistantName(settings, storeName)` returns `settings.assistantName || \`Service client ${storeName}\``.
- Don't call `revalidateStorefront()`, because nothing on the storefront depends on these settings.

### API Endpoints

- `GET /api/crm/whatsapp/settings` (admin): `{ settings, connection, configured: { evolution: boolean, ai: boolean } }`. Implement `configured` with an inline check: `!!(process.env.EVOLUTION_BASE_URL && process.env.EVOLUTION_INSTANCE && process.env.EVOLUTION_API_KEY && (process.env.WHATSAPP_WEBHOOK_SECRET?.length ?? 0) >= 32)`, and for AI the same plus `OPENROUTER_API_KEY`. Task 03 creates `whatsappConfigured()` in `src/lib/whatsapp/config.ts` in the same wave. If that file exists when you implement, import it instead.
- `PUT /api/crm/whatsapp/settings` (admin): body is a partial patch, capped at 8192 bytes. Returns 200 `{ settings }`. Returns 400 `{ error, field? }` on validation failure.

## Acceptance Criteria

- [ ] With nothing stored, defaults come back and every risky toggle is false.
- [ ] Unknown fields are rejected (strict). Admin phones are normalized. Min gap > max gap is rejected.
- [ ] Agents get 403 on both routes, and non-logged-in users get 401 or a redirect, consistent with existing routes.
- [ ] Unit test `scripts/unit/whatsapp-settings.test.mjs` covers defaults, merge, invalid JSON recovery and phone normalization.
- [ ] Lint and tsc pass.
