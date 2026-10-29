# Politique de soumission colis (Ozon)

## Création de colis — jamais de re-création automatique (règle normative)

Un colis Ozon créé deux fois pour la même commande est une erreur métier grave
(double livraison / double encaissement COD). Or, après un échec réseau ou un
timeout, `fetch` ne permet pas de distinguer de façon fiable « requête jamais
envoyée » de « requête peut-être reçue par Ozon ». Par conséquent :

- `permanent` → `failed` (terminal, sûr : la requête a été traitée et refusée).
- `retryable`, `unknown`, timeout → `needs_review` immédiatement.
  Jamais de re-soumission automatique.
- Les jobs `queued` sont retentés par le worker (ex. worker arrêté pendant le
  claim) ; une remise en `queued` manuelle n'est légitime qu'après vérification
  sur le portail Ozon que le colis n'existe pas.

## `declaredValueMad`

Laissé non défini : aucune formule de majoration n’est vérifiée. Si un jour
nécessaire, la décision documentée est d'utiliser le plancher `parcel-declared-value = 50`
(docs/operations.md, activation Ozon) — ne pas inventer d'autre formule.

## Format téléphone

Le snapshot stocke le format normalisé `+2126XXXXXXXX` ; l'adaptateur reçoit
`06XXXXXXXX` via `toLocalPhone()` et re-valide.
