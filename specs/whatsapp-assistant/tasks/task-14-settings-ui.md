# Task 14: WhatsApp settings UI

## Status

complete

## Wave

2

## Description

This task adds a "WhatsApp" section to `/crm/parametres` (admin only) where the owner:
- sees whether Evolution and the AI are configured and connected
- flips the **kill switch** and every feature toggle (all OFF by default)
- sets admin alert phones, the sending window, the daily cap and gaps
- sets the assistant name, FAQ text, the AI daily budget, the auto-release delay and media retention

The UI is French and mobile-friendly, and it follows the existing settings form pattern.

## Dependencies

**Depends on:** task-04-whatsapp-settings.md
**Blocks:** task-19-courier-status-mapping (both modify `parametres/page.tsx`; this one goes first)

**Context from dependencies:**
- Task 04 created:
  - `GET /api/crm/whatsapp/settings` returning `{ settings, connection: { state: "open"|"connecting"|"close"|"unknown", updatedAt }, configured: { evolution: boolean, ai: boolean } }`
  - `PUT /api/crm/whatsapp/settings` taking a partial patch and returning `{ settings }` or `400 { error, field? }`
  - types and defaults in `src/lib/whatsapp-settings-schema.ts` (`WhatsAppSettings`, `DEFAULT_WHATSAPP_SETTINGS`)
  - `getWhatsAppSettings()` and `getWhatsAppConnectionState()` in `src/lib/services/whatsapp-settings.ts`

  Fields: `enabled`, `notificationsEnabled`, `notifyConfirmed`, `notifyShipped`, `notifyDelivered`, `notifyOutForDelivery`, `notifyDeliveryIssue`, `notifyCancelled`, `relanceAfterNoAnswer`, `relanceNoAnswerCount`, `adminAlertsEnabled`, `adminPhones[]`, `adminQuietHours`, `sendWindowStart`, `sendWindowEnd`, `dailyOutboundCap`, `minGapSeconds`, `maxGapSeconds`, `aiEnabled`, `assistantName`, `faqText`, `aiDailyBudgetCents`, `aiResumeAfterHours`, `autoBlockEnabled`, `catalogSuggestionsEnabled`, `crossSellEnabled`, `orderEditProposalsEnabled`, `mediaRetentionDays`.
- Existing page `src/app/(admin)/crm/parametres/page.tsx`: server component, `requireAdmin()`. It renders `StoreSettingsForm`, `BlocklistManager` and `CityTariffsManager`. Follow `src/components/crm/store-settings-form.tsx` for client form conventions (fetch PUT, `sonner` toasts, radix/shadcn-like components in `src/components/ui`).

## Files to Create

- `src/components/crm/whatsapp-settings-form.tsx`: client form.

## Files to Modify

- `src/app/(admin)/crm/parametres/page.tsx`: load settings, connection state and configured flags on the server (call the service functions directly). Mount a `WhatsApp` section with the form.

## Technical Details

### Layout (French)

1. **Statut**:
   - Badges: "Evolution configuré / non configuré", "IA configurée / non configurée", "Connexion : connecté / déconnecté / inconnu (mis à jour il y a …)".
   - If not configured, show a note pointing to `docs/whatsapp.md` and the env var names (names only).
2. **Interrupteur principal**: `enabled`, as a large switch labelled "WhatsApp actif (arrêt d'urgence si désactivé)". Turning it OFF needs no confirmation. Turning it ON shows a confirm dialog: "Le numéro est-il chauffé (≈2 semaines d'usage normal) ?"
3. **Notifications clients**:
   - `notificationsEnabled`, then one checkbox per event.
   - Events 3 and 4 carry a hint: "s'active uniquement pour les statuts transporteur mappés".
   - `relanceAfterNoAnswer` plus `relanceNoAnswerCount`.
4. **Alertes admin**:
   - `adminAlertsEnabled`.
   - Phone list (add and remove, max 5). Enter `06…` or `+212…`; the server normalizes it.
   - `adminQuietHours`.
5. **Rythme d'envoi (sécurité anti-blocage)**:
   - window start and end (time inputs)
   - daily cap
   - min and max gap in seconds
   - help text: "Les réponses de l'IA à un client qui écrit partent 24h/24 ; seules les notifications respectent la plage."
6. **Assistant IA**:
   - `aiEnabled`, which is disabled when `configured.ai` is false
   - `assistantName` (placeholder: `Service client {storeName}`)
   - `faqText` (textarea, 4000 characters max, with a counter)
   - `aiDailyBudgetCents`, shown and entered in USD with 2 decimals and converted to cents
   - `aiResumeAfterHours`
7. **Sécurité clients**: `autoBlockEnabled`, with the hint "3 points = blocage auto ; avertissements envoyés même si désactivé".
8. **Fonctions avancées (phase ultérieure)**: `catalogSuggestionsEnabled`, `crossSellEnabled`, `orderEditProposalsEnabled`.
9. **Médias**: `mediaRetentionDays`.

### Behaviour

- Save sends only the changed fields with PUT.
- On a `400 { field }`, show the error next to the field.
- Validate on the client too (gap min ≤ max, time format), but the server is the authority.
- Import only types and defaults from the schema module, and avoid importing server services into the client component.
- Accessible labels. Mobile: one column.

## Acceptance Criteria

- [ ] An admin sees the section, and agents can't reach the page (existing guard).
- [ ] Toggling and saving persists after reload. Invalid input shows a French error.
- [ ] The AI toggle is disabled with an explanation when `OPENROUTER_API_KEY` or Evolution isn't configured.
- [ ] Lint and tsc pass. `DELIVERY_PROVIDER=mock npm run build` passes.
