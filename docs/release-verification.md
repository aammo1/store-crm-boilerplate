# Vérification de l’intégration de livraison — tâche 20

## Portée et environnement

Vérification locale du starter assemblé, le 21 octobre 2026, depuis la base
`572936e`. Linux, Node **26.7.0**, npm **11.19.0**, Next **15.5.27** ; Chromium
système **`/usr/bin/chromium`**. La cible Docker reste Node 22 Alpine : les preuves
hôte ci-dessous ne valent pas une exécution Alpine/musl.

Tous les parcours utilisent `DELIVERY_PROVIDER=mock`, SQLite/médias temporaires,
comptes fictifs et secrets éphémères. Aucun appel Ozon/Meta/IA réel. Le préchargement
`scripts/block-external-network.mjs` interdit les sockets réelles hors loopback ;
les transports Meta/IA des suites sont des mocks explicites. Les navigateurs
interdisent les requêtes de page hors origine locale. Aucun env/donnée de la
boutique source n’a été chargé. Les chemins ci-dessous sont relatifs au starter.

## Commandes et résultats finaux

Préfixe utilisé pour les commandes Node/npm de vérification :

```bash
export DELIVERY_PROVIDER=mock
export NODE_OPTIONS="--import=$PWD/scripts/block-external-network.mjs"
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
```

| Commande | Résultat |
| --- | --- |
| `npm run lint` | Réussi, aucune erreur ni avertissement ESLint |
| `npx tsc --noEmit` | Réussi |
| `NEXT_TELEMETRY_DISABLED=1 DB_PATH=/tmp/opencode/crm-release-build-forbidden/crm.db UPLOAD_DIR=/tmp/opencode/crm-release-build-forbidden/uploads npm run build` | Réussi ; standalone produit, répertoire DB/médias sentinelle inexistant après build |
| `npm run test:crm` | **121/121** ; inclut désormais les neuf cas de commandes manuelles |
| `npm run test:catalog-agent` | **8/8** |
| `npm run test:security` | **8/8** |
| `npm run test:meta` | **8/8**, transport mock |
| `npm run test:assistant` | **8/8**, modèle/transport mock |
| `node --test examples/nextjs/verify.test.mjs` | **6/6**, client typé et proxy public vérifiés séparément |
| `npm run test:bootstrap` | **1/1**, 16 migrations, tables opérationnelles vides, workers/mock/auth/health |
| `npm run test:integration` | **1/1**, parcours HTTP standalone décrit ci-dessous |
| `npm run test:order-edits-browser` | **1/1**, parcours agent mobile puis bureau |
| `npm run test:e2e-crm` | Réussi, sept groupes : connexion, thème, navigation mobile, archives BL, équipe, permissions, détail/contact |
| `npm run test:release-tree` | Réussi ; arbre public suivi + nouveaux fichiers destinés à livraison, hors fichiers supprimés/ignorés |
| `npm run test:fresh-install` | **1/1** ; copie allowlistée sans `.git`, `npm ci --offline --ignore-scripts --include=dev --no-audit --no-fund` : **783 paquets**, SQLite/sharp natifs hôte et build standalone réussis, aucun DB/média au build |
| `git diff --check` | Réussi |

La vérification Compose utilise un environnement vide complété seulement par
PATH/HOME et des valeurs jetables pour `AUTH_SECRET`, `CRM_PUBLIC_URL`,
`SECURITY_ALLOWED_ORIGINS`, `DELIVERY_PROVIDER=mock` :
`docker compose config --quiet` **réussit**. La première tentative omettait
`CRM_PUBLIC_URL` : elle a correctement échoué sur la variable obligatoire ;
la commande corrigée ci-dessus a réussi sans afficher de secrets résolus.

## Matrice d’intégration et preuves

| Sujet | Preuve exécutée |
| --- | --- |
| Installation vide | Bootstrap et standalone : zéro utilisateurs/produits/variantes/commandes/réservations/mouvements/soumissions ; 16 migrations, FK/intégrité valides ; premier admin CLI explicite |
| Produit Standard | Adaptateur sans options ; création/admin, stock `MAIN`, modification, archivage/restauration et catalogue v1 ; checkout, confirmation, colis, BL, retour par ID |
| Option non numérique | Sérum `Contenance=500 ml`, même parcours complet ; retour endommagé vers quarantaine |
| Deux axes | Lampe `Alimentation=USB-C`, `Finition=Mat`, même parcours ; options conservées dans snapshot et retour vendable |
| Identités historiques | IDs/SKUs conservés sur édition/archive/restore ; suites mock/catalog-agent/inventory/returns : renommages et variantes archivées n’altèrent ni snapshots ni retour |
| Prix et défauts | Catalogue public en MAD avec disponibilité booléenne ; checkout sans prix, prix injecté rejeté ; 29 MAD, seuil 400, offre 20 s à −30 % |
| Paramètres personnalisés | Nom boutique, frais 47, seuil 650, remise 50 %, upsell désactivé puis fenêtre 1 s ; uniquement nouveaux checkouts/offres affectés |
| Reprise durable | HTTP checkout 201 puis replay 200 identique après arrêt/redémarrage réel du standalone, paramètres/prix modifiés et produits archivés ; même token HMAC/offre/deadline ; clé/contenu différent 409 |
| Upsell | Acceptation à prix/frais capturés, exactement une unité ; replay immuable après redémarrage/retour ; action opposée 409 ; refus et expiration testés |
| Confirmation | Deux HTTP concurrents : un 201 et un replay 200, un seul job, quatre réservations ; manque de stock et courses interprocessus/crash couverts par CRM |
| Stock nul | Accepté au checkout, bloqué atomiquement à confirmation si manque ; suites orders/inventory/meta et navigateur |
| Fulfillment | Worker réel du standalone crée un colis mock ; BL explicite sauvegardé, PDF mock valide, remise livreur ; un débit ledger par variante |
| Suivi | Poller avec provider mock ; `MOCK_CREATED` reste `unknown`, aucun mapping live inventé. Régressions de suivi couvrent livré/refusé/observations anciennes et inconnues avec mappings uniquement de test |
| Retour archivé | Après archivage des quatre produits, retour déclaré manuellement, réception HTTP puis deux inspections concurrentes : 200/409 ; une seule restitution/quarantaine par ID, aucune double écriture |
| Atomicité/recovery | Courses deux processus checkout/upsell/confirmation/stock/retour/BL, mort avant commit, crash après effet BL externe simulé, claims et réconciliation incertaine conservés dans les 121 cas |
| Conversion facultative | Meta outbox/achat capturé et dédupliqué ; original attribution, retry, pas de transport CRM inféré ; désactivé au démarrage vide |
| Frontières | Bearer v1, token commande seul insuffisant, clés séparées catalogue/admin, schémas stricts, origines exactes, limites de corps/IP/téléphone, Auth.js/révocation et permissions agent/admin |
| Français | Erreurs Zod héritées normalisées ; invalid type et champs catalogue legacy vérifiés via HTTP construit, labels de retour en unités et variantes génériques |
| Navigateur | Commandes manuelles trois formes, éditions/historique/révisions, callbacks, remplacement, confirmation/shortages, annulation/contacts terminaux, archive/listes, origines/rôles, pas de débordement mobile ; thème/équipe/navigation conservés |
| Client Next | Six cas indépendants : origines/médias/pagination, tentative stable après perte réponse, timeouts/backoff/secrets, session chiffrée liée à commande, expiration absolue et cookies, limites publiques |
| Packaging natif | Copie `.next/standalone` + static/public/migrations et package SQLite complet comme Docker ; lancement `node server.js` en dehors du repo, SQLite natif/sharp, médias upload/lecture, redémarrages persistants, admin et backup CLI |
| Backup | Snapshot CLI ouvert séparément, intégrité/FK et nombres de commandes/mouvements comparés à l’original temporaire |

Dans le parcours standalone, les trois lignes de panier valent 290 MAD ; l’offre
Pochette vaut 70 MAD. Total initial 319 MAD puis **389 MAD** après acceptation,
même après modification du prix catalogue Pochette à 900 et des règles courantes.
Le retour final rétablit 5 unités physiques par variante, aucune réservation,
avec une unité de quarantaine pour le sérum. Les lignes de checkout sont triées
canoniquement par identité : la vérification n’assimile pas leur index à l’ordre
du panier entrant.

Le standalone est arrêté avant toute simulation de suivi/retour par les services
du processus de test, puis relancé pour la réception/inspection HTTP. Aucun
worker concurrent d’un deuxième propriétaire de base n’est créé. Le DB ouvert
par le test pour les assertions HTTP est en lecture seule.

## Audit de l’arbre public et provenance

`scripts/release-tree.mjs` inspecte l’ensemble des fichiers suivis et nouveaux
non ignorés qui existent réellement, avec allowlist des racines/extensions,
interdiction des symlinks, DB/WAL/SHM, env réels, exports/images/captures/archives,
clés privées et signatures de tokens reconnaissables. Recherche également les
chemins source/branding/adaptateurs transitoires dans tout `src/`. L’inspection
finale portait sur **301 fichiers**, ce rapport inclus ; relancer la commande
donne le total courant. Seuls trois fichiers binaires sont autorisés :
les fonts locales documentées dans le manifeste. `public/` contient `.gitkeep`.
Les tests/catalogue contiennent des valeurs fictives ou des rejets volontaires
du format legacy ; aucune photographie ou donnée source n’est nécessaire.

Ignorés constatés : `.next/`, `node_modules/`, `next-env.d.ts`,
`tsconfig.tsbuildinfo`, `data/` (DB et sidecars préexistants). Les données locales
préexistantes ont été laissées intactes et ne font pas partie de la copie publique.
Pas de `.env.local`, d’uploads/backups/export/capture dans l’arbre destiné à
publication. L’installateur de vérification ne copie pas `.git` ni aucun ignoré.
La sentinelle de build dans `/tmp/opencode` est restée absente.

`git log --reverse` montre les sept commits locaux des vagues 1–7, sans historique
source hérité ; `git remote -v` est vide. Ni commit, staging, push, PR, publication,
modification GitHub/template ni changement de statut de spec dans cette tâche.
La publication/fresh release history relève de la tâche 21. Aucun fichier de
l’application source ou skill global n’a été modifié.

## Résultats PageSpeed Insights (mobile)

À remplir par le propriétaire après déploiement (avec ou sans Cloudflare) (cible : LCP
mobile < 2,5 s). Mesurer `/`, un `/produit/<slug>` et un `/l/<slug>` ; le budget JS
automatique (`npm run perf-budget`) est décrit dans [les opérations](operations.md#cache--performance).

| Route | LCP mobile | TBT | CLS | Date |
| --- | --- | --- | --- | --- |
| `/` |  |  |  |  |
| `/produit/<slug>` |  |  |  |  |
| `/l/<slug>` |  |  |  |  |

## Limites factuelles

- **Docker build/run non vérifié** : accès au daemon précédemment refusé ; aucune
  escalade ni nouvelle tentative d’accès privilégié. Compose validé et inspection
  Dockerfile (Node22 Alpine, nonroot 1001, volume `/app/data`, static/public/
  migrations, package SQLite complet, healthcheck) ne prouvent pas l’exécution
  musl, les permissions du volume ou la persistance d’un conteneur. Faire ce
  smoke test sur un hôte autorisé avant de revendiquer une validation Docker.
- Le build frais signale les avertissements jose/Auth.js Edge sur
  CompressionStream/DecompressionStream ; build et sessions navigateur réussis.
  `next start` signale la configuration standalone : les anciens tests navigateur
  l’utilisent en mode local ; le parcours release lance bien `node server.js`.
- La suite équipe produit le diagnostic Auth.js `CredentialsSignin` attendu lors
  du refus d’un agent désactivé. Ce n’est pas un échec de la suite.
- Première tentative de build sous forte concurrence arrêtée par timeout outil
  120 s avec EPIPE ; relance autorisée à 300 s puis builds finaux réussis. Les
  premiers échecs de fixtures/assertions génériques et du harness e2e ont été
  corrigés ; aucune assertion de sûreté supprimée pour masquer un échec.
- Aucun audit distant de dépendances ni statut Ozon réel vérifié. Le fresh install
  offline démontre le lockfile/arbre sur le cache local, pas la disponibilité
  future du registre ni la compatibilité native de toutes les plateformes.
- Aucun blocage fonctionnel local restant constaté ; les preuves Docker/live et
  la publication ne sont pas revendiquées par cette intégration.

## Manifeste exact des changements tâche 20

### Créés

```text
docs/release-verification.md
scripts/block-external-network.mjs
scripts/fresh-install.test.mjs
scripts/fulfillment-fixtures.mjs
scripts/release-integration.test.mjs
scripts/release-tree.mjs
src/lib/validation.ts
```

### Ajouts ultérieurs (spec `sendit-courier`, hors tâche 20)

Fichiers créés par le transporteur Sendit, non couverts par le manifeste ci-dessus :

```text
scripts/sendit-verify.mjs
src/lib/shipping/city-sync.ts
src/lib/shipping/couriers.ts
src/lib/shipping/sendit.ts
```

### Supprimés après recherche des consommateurs

```text
src/lib/categories.ts
src/lib/products-server.ts
src/lib/slug.ts
src/lib/types.ts
```

### Modifiés

```text
AGENTS.md
README.md
docs/extraction-manifest.md
package.json
scripts/bl-workflow.test.mjs
scripts/bootstrap.test.mjs
scripts/catalog-agent.test.mjs
scripts/dashboard-accuracy.test.mjs
scripts/e2e-crm.mjs
scripts/manual-order.test.mjs
scripts/mock-flow.test.mjs
scripts/order-edits-browser.test.mjs
scripts/order-edits.test.mjs
scripts/order-lifecycle.test.mjs
scripts/order-workflow.test.mjs
scripts/ozon-verify.mjs
scripts/returns-workflow.test.mjs
scripts/submission-resolution.test.mjs
scripts/tracking-workflow.test.mjs
src/app/(admin)/crm/equipe/page.tsx
src/app/api/catalog-agent/route.ts
src/app/api/crm/bl/[id]/pdf/route.ts
src/app/api/crm/orders/lifecycle/route.ts
src/app/api/crm/returns/[id]/inspect/route.ts
src/app/api/pixel/route.ts
src/components/admin/quantities-grid.tsx
src/components/crm/crm-assistant.tsx
src/components/crm/crm-theme-provider.tsx
src/components/crm/team-workspace.tsx
src/components/ui/sonner.tsx
src/lib/api-schemas.ts
src/lib/assistant-contract.ts
src/lib/assistant-tools.ts
src/lib/db.ts
src/lib/manual-order-schema.ts
src/lib/meta-client.ts
src/lib/meta-shared.ts
src/lib/order-edit-schema.ts
src/lib/phone.ts
src/lib/pricing.ts
src/lib/services/catalog-agent.ts
src/lib/services/catalog-schemas.ts
src/lib/services/catalog.ts
src/lib/services/expeditions.ts
src/lib/services/inventory-schemas.ts
src/lib/services/inventory.ts
src/lib/services/meta.ts
src/lib/services/storefront-orders.ts
src/lib/services/submission-resolution.ts
src/lib/services/tracking.ts
src/lib/shipping/POLICY.md
src/lib/shipping/index.ts
src/lib/shipping/ozon.ts
src/lib/shipping/provider.ts
src/lib/shipping/redact.ts
src/lib/shipping/status-map.ts
src/lib/store-settings-schema.ts
src/lib/storefront-api-schemas.ts
src/lib/team-schemas.ts
src/lib/wa-templates.ts
src/lib/workers/index.ts
src/lib/workers/meta.ts
src/lib/workers/submission.ts
src/lib/workers/tracking.ts
src/stores/assistant-context.ts
```

Aucune dépendance modifiée ; `package-lock.json` ne change pas. Les scripts npm
ajoutés sont des vérifications exécutables et les cas manuels rejoignent CRM.
Migrations et statuts des tâches conservés tels que reçus.
