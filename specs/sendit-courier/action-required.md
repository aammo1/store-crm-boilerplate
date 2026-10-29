# Action Required: Sendit Courier

Manual steps that must be completed by a human. These cannot be automated.

## Before Implementation

- [ ] **Nothing blocking.** Everything is built and tested against a fake Sendit API; no keys are needed to implement.

## During Implementation

- [ ] **Do not paste real Sendit keys into tests, specs or chat.** Agents use ephemeral fake values only.

## After Implementation (per Sendit store, at go-live)

- [ ] **Get the store's API keys** — app.sendit.ma → "Intégration API": copy the public and secret keys into the store's runtime env (Coolify) as `SENDIT_PUBLIC_KEY` / `SENDIT_SECRET_KEY`, set `DELIVERY_PROVIDER=sendit`. Never `NEXT_PUBLIC_*`.
- [ ] **Run the live read-only check once** — from the store repo with its `.env.local` filled: `npm run sendit:verify -- --live --yes` (optionally `--code <existing parcel code>`). Confirms login, district list and status shape. Report any status code not in the mapping table.
- [ ] **Choose the pickup district** — CRM → Paramètres → "Transporteur Sendit" after cities have synced. No parcel is sent until this is set.
- [ ] **Set opening/try-on defaults** — same screen ("Autoriser l'ouverture", "Autoriser l'essayage").
- [ ] **Review pre-filled tariffs** — CRM → Paramètres → "Tarifs par ville": Sendit prices were filled only where no tariff existed.
- [ ] **First real parcel** — confirm one real order, check it appears on app.sendit.ma with reference `<store-slug>-<orderId>`, print its label, hand off, and watch the status update after the next poll.
- [ ] **Shared Sendit account** — if several stores use the same account, expect other stores' parcels in COD statements; they are listed as ignored.

---

> These tasks are also referenced in context within the relevant task files (task-11, task-16, task-17).
