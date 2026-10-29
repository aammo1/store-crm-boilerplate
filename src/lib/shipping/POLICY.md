# Politique de soumission et suivi colis (Ozon et Sendit)

## Création de colis — jamais de re-création automatique (règle normative)

Un colis créé deux fois chez le transporteur (Ozon ou Sendit) pour la même commande
est une erreur métier grave (double livraison / double encaissement COD). Or, après un
échec réseau ou un timeout, `fetch` ne permet pas de distinguer de façon fiable « requête
jamais envoyée » de « requête peut-être reçue par le transporteur ». Par conséquent :

- `permanent` → `failed` (terminal, sûr : la requête a été traitée et refusée par l'API).
- `throttled` → `requeue` automatique avec délai sécurisé (HTTP 429 Sendit). Le transporteur
  a explicitement refusé de traiter la requête et garantit qu'aucun colis n'a été créé.
  Seuls les adaptateurs pouvant apporter cette certitude peuvent émettre ce type d'erreur.
  La soumission est replacée en `queued` avec délai d'attente (`retryAfterSec` ou backoff
  sécurisé) sans intervention humaine.
- `retryable`, `unknown`, timeout → `needs_review` immédiatement.
  Jamais de re-soumission automatique.
- Les jobs `queued` sont retentés par le worker (ex. worker arrêté pendant le
  claim) ; une remise en `queued` manuelle n'est légitime qu'après vérification
  sur le portail transporteur (ou via le helper de recherche) que le colis n'existe pas.

## Recherche transporteur (lookup helper) — strictement en lecture seule

Pour Sendit, un helper de recherche par référence (`<slug>-<orderId>`) et téléphone client
est disponible sur les soumissions en `needs_review` ou `failed` (`lookupSubmissionAtCourier`).

- **Lecture seule absolue** : l'appel à l'API transporteur ne modifie jamais la base de données,
  n'altère aucun statut et ne crée aucun colis.
- **Résolution humaine explicite** : l'agent consulte le résultat (colis trouvé avec son
  numéro de suivi, ou absence de colis) et choisit manuellement de lier le numéro de suivi
  existant ou de relancer une nouvelle soumission.

## Sources des correspondances de statut (status maps)

Le vocabulaire normalisé (`TRACKING_STATUSES`) harmonise les statuts transporteurs :
`delivered`, `refused`, `cancelled`, `return_in_transit`, `in_transit`, `at_facility`,
`out_for_delivery`, `awaiting_pickup`, `delivery_issue`, `unknown`.

- **Ozon** : la table `OZON_STATUS_MAP` reste **volontairement vide** (`{}`). Le schéma et
  les libellés réels d'Ozon ne sont pas vérifiés par une documentation officielle. Tout
  statut Ozon normalise en `unknown` et aucun changement de stock ni outcome de livraison
  n'est automatisé tant que des statuts réels n'ont pas été observés sous accord du propriétaire.
- **Sendit** : la table `SENDIT_STATUS_MAP` est issue de la liste officielle publiée par le
  plugin WooCommerce de Sendit (`sendit-ma-integration` v2.2.x, endpoint `GET /all-status-deliveries`).
  - `PENDING`, `TO_PREPARE`, `TOPICKUP` → `awaiting_pickup`
  - `PICKEDUP`, `TRANSIT` → `in_transit`
  - `WAREHOUSE`, `DISTRIBUTED` → `at_facility`
  - `DELIVERING` → `out_for_delivery`
  - `UNREACHABLE`, `POSTPONED`, `NEW_DESTINATION` → `delivery_issue`
  - `DELIVERED` → `delivered` (déclenche l'enregistrement automatique de l'outcome livré)
  - `REJECTED` → `refused` (déclenche l'enregistrement automatique de l'outcome refusé)
  - `RETURNED` → `return_in_transit`
  - `CANCELED` → `cancelled`
  - Tout statut non documenté normalise en `unknown`. Aucun mapping n'est inventé.

## `declaredValueMad`

Laissé non défini : aucune formule de majoration n’est vérifiée. Si un jour
nécessaire, la décision documentée est d'utiliser le plancher `parcel-declared-value = 50`
(docs/operations.md, activation Ozon) — ne pas inventer d'autre formule.

## Format téléphone

Le snapshot stocke le format normalisé `+2126XXXXXXXX` ; l'adaptateur reçoit
`06XXXXXXXX` via `toLocalPhone()` et re-valide.
