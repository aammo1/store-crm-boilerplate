# Mettre à niveau une copie du template

Une copie créée avec **Use this template** est indépendante : dépôt, historique,
déploiement, SQLite, médias et secrets. Modifier le template ne modifie pas vos
boutiques. Il n’y a ni mise à jour automatique, ni schéma partagé, ni remplacement
global des fichiers d’une copie. La destination publique du template est
`https://github.com/aammo1/store-crm-boilerplate` ; vérifier sa publication et choisir une
révision/tag précis avant de planifier une mise à niveau.

## Procédure délibérée

1. Enregistrer la révision upstream utilisée lors de la création et les adaptations
   locales (métier, provider, UI, intégrations). Conserver un inventaire par boutique.
2. Lire les changements entre cette révision et la cible : dépendances/lockfile,
   env, sécurité, contrat v1, client et exemples, migrations, workers et Docker.
   Ajouter éventuellement upstream comme remote de lecture dans votre copie ;
   cela ne fusionne ni ne déploie rien.
3. Créer une branche de mise à niveau, transférer les correctifs sélectionnés par
   cherry-pick si l’historique le permet, sinon appliquer un patch relu. Les copies
   GitHub template peuvent ne pas partager l’ascendance nécessaire au merge.
   Résoudre explicitement les conflits et relire chaque modification ; ne pas
   écraser `.env*`, données ou adaptations locales avec les fichiers upstream.
4. Sauvegarder et vérifier la restauration DB/uploads/secrets avant tout démarrage
   du nouveau code : l’ouverture DB applique immédiatement les migrations absentes.
   Ne jamais réécrire une migration déjà appliquée ; ajouter une migration nouvelle,
   sans seed, en vérifiant son ordre et son nom dans `_migrations` de chaque copie.
5. Tester sur une restauration **isolée**, mock, sans credentials externes ni trafic
   client. Vérifier nouvelle base vide **et** ancienne base migrée, IDs/SKUs et
   historiques, stock/réservations, reçus/retries, confirmation, BL/réconciliation,
   retours, permissions, médias et connexion storefront. Ne pas supprimer de reçus
   durables pour « réparer » un retry.
6. Exécuter les checks ci-dessous. Revoir la compatibilité des consommateurs v1 ;
   reporter volontairement le client et les exemples dans chaque dépôt storefront,
   sans exposer leurs secrets. Aucun client externe ne se met à jour tout seul.
7. Préparer une fenêtre de maintenance, arrêter le trafic de création et l’ancien
   owner DB/workers, prendre la sauvegarde finale, déployer **une** instance, puis
   vérifier santé/heartbeats/files/médias et le parcours avant reprise du trafic.
   Garder les secrets stables pendant la mise à niveau sauf rotation planifiée.

```sh
npm run lint
npx tsc --noEmit
npm run test:unit
DELIVERY_PROVIDER=mock npm run build
npm run test:bootstrap
npm run test:crm
npm run test:catalog-agent
npm run test:security
npm run test:meta
npm run test:assistant
node --test examples/nextjs/verify.test.mjs
```

Ces commandes de régression utilisent leurs fixtures isolées ; toute vérification
manuelle doit aussi utiliser DB/médias temporaires et secrets éphémères. Faire un
smoke Docker avec un projet/volume neuf lorsque le daemon est accessible.

## Appliquer la spec « hardening and growth » à une copie existante

Une copie créée avant cette spec est à niveau `019` : elle reçoit les migrations
`020`–`027` dans l’ordre, au premier démarrage du nouveau code (sauvegarde vérifiée
avant, voir [les opérations](operations.md)). Ne jamais renommer ni éditer ces
fichiers ; leurs checksums sont maintenant enregistrés dans `_migrations`.

| Migration | Ajout |
| --- | --- |
| `020_delivery_outcomes` | Outcomes Livré/Refusé par commande |
| `021_customer_blocklist` | Blocklist téléphone |
| `022_variant_cost` | Coût par variante |
| `023_ad_spend` | Dépenses publicitaires |
| `024_order_attribution` | Attribution UTM des commandes |
| `025_cod_remittances` | Remises COD et lignes importées |
| `026_city_tariffs` | Tarifs/frais par ville |
| `027_checkout_leads` | Paniers abandonnés (opt-in) |

Changements d’environnement à reporter dans le `.env`/Compose privé de la copie
(comparer avec `.env.example`, sans écraser les valeurs locales) :

- `DELIVERY_PROVIDER` devient **obligatoire** en production (`mock`, `ozon` ou `sendit`).
- `SECURITY_TRUSTED_IP_HEADER` **ou** `SECURITY_ACCEPT_GLOBAL_BUDGETS=1` obligatoire
  en production ; sinon le boot échoue (`src/lib/env.ts`).
- Nouveaux, facultatifs : `HEALTH_DETAILS_TOKEN`, `LOG_FORMAT`, `LOG_LEVEL`,
  `BACKUP_DIR`, `BACKUP_RETENTION`, `BACKUP_RCLONE_REMOTE`, variables TikTok.
  `MIGRATIONS_ALLOW_CHECKSUM_MISMATCH` est réservé à la récupération.
- Le `docker-compose.yml` passe ces variables au conteneur ; reporter les lignes
  manquantes dans le Compose local.
- Si le `store.config.ts` de la copie a été adapté : ajouter `leads` (désactivé par
  défaut) et éventuellement `colors.accentForeground` ; la copie fonctionne sans.
- Un seul processus par DB : le bail de workers (90 s) empêche un double owner.
  Arrêter l’ancien processus et attendre l’expiration du bail si besoin.
- Planifier les sauvegardes avec `deploy/backup/` et tester `npm run backup:verify`.

`npm run new-store` écrit désormais `.template-version` (JSON : modèle, commit
upstream, date de création). Pour une copie plus ancienne, créer ce fichier à la
main avec la révision upstream réellement utilisée, afin de cadrer les prochaines
revues. Le contrat v1 est inchangé : les storefronts externes n’ont rien à migrer.

## Appliquer la spec « Transporteur Sendit » (migration 029)

Cette mise à niveau introduit le registre des transporteurs (`src/lib/shipping/couriers.ts`)
avec capacités distinctes (Ozon : BL obligatoires ; Sendit : étiquettes 10×10, sans BL,
lookup par référence), la migration `029_courier_providers.sql` et le support complet de Sendit.

| Migration | Ajout |
| --- | --- |
| `029_courier_providers` | Colonnes `provider` sur `courier_submissions` et `cities`, colonnes `arabic_name` et `is_pickup` sur `cities`, index de performance |

### Si la boutique reste sur Ozon

- **Comportement strictement inchangé** : la boutique conserve le circuit Ozon (création de colis,
  BL, PDF de BL, remise livreur, statuts inchangés).
- **Migration 029 transparente** : appliquée automatiquement au premier boot. Les soumissions
  et villes existantes sont rétro-remplies avec `provider = 'ozon'`.
- **Variables d’environnement** : le renommage vers les variables génériques `COURIER_*` est
  **optionnel**. Les anciennes variables `OZON_SUBMIT_INTERVAL_SEC`, `OZON_POLL_INTERVAL_MIN` et
  `OZON_TRACK_BATCH` sont conservées comme valeurs de repli automatiques.

### Changer de transporteur sur une boutique en production

Chaque boutique utilise **un seul transporteur actif**. Le CRM n'est pas un routeur
multi-transporteurs simultané et il n'y a **aucune migration automatique** des colis en cours
ou des associations de villes. La bascule d'un transporteur à un autre (ex. d'Ozon vers Sendit)
sur une boutique vivante est une opération délibérée, manuelle et sous revue marchande :

1. **Finaliser ou solder tous les colis en cours** :
   - Aucun colis ne doit rester en statut `queued`, `submitting` ou `needs_review`.
   - Tous les colis expédiés avec l'ancien transporteur doivent avoir été remis (BL enregistré pour
     Ozon, remise confirmée pour Sendit) et suivis jusqu'à leur terme (livré, refusé ou annulé), car
     le poller de suivi ne synchronise que les colis du transporteur actif (`provider = deliveryProviderName()`).
2. **Sauvegarder et vérifier la base de données** :
   - Exécuter `npm run backup` et `npm run backup:verify` avant toute modification.
3. **Mettre à jour les variables d’environnement** :
   - Définir `DELIVERY_PROVIDER=sendit` (ou `ozon`).
   - Renseigner les identifiants requis (`SENDIT_PUBLIC_KEY` et `SENDIT_SECRET_KEY` pour Sendit ;
     `OZON_CLIENT_ID` et `OZON_API_KEY` pour Ozon).
4. **Synchroniser les villes du nouveau transporteur** :
   - Pour Sendit : exécuter `npm run sendit:verify -- --live --yes` (ou laisser la synchronisation
     automatique du CRM s'exécuter). Les villes et quartiers du nouveau transporteur sont
     enregistrés avec `provider = 'sendit'`, leurs noms arabes et leurs prix de livraison.
5. **Configurer les paramètres transporteur (Sendit)** :
   - Dans `/crm/parametres` → « Transporteur Sendit », sélectionner obligatoirement le quartier
     de ramassage de la boutique (`pickupDistrictId`), puis ajuster les options d'ouverture et
     d'essayage de colis. Sans quartier de ramassage configuré, la création de colis Sendit échoue.
6. **Revoir les tarifs par ville et les commandes en attente** :
   - La synchronisation pré-remplit les tarifs manquants à partir des prix de livraison du
     transporteur. Revoir la grille dans `/crm/parametres`.
   - Les commandes non confirmées qui avaient une ville liée à l'ancien transporteur doivent
     être vérifiées par les agents lors de la confirmation téléphonique : la recherche de ville
     (`CityCombobox`) est désormais filtrée sur le nouveau transporteur.

Ajouter à la liste de vérification : `npm run test:unit` et
`npm run test:release-tree`. Le test `scripts/unit/next-internals.test.mjs` vérifie
les imports profonds de Next et `__NEXT_IMAGE_OPTS` (voir la checklist Next plus bas) :
il doit passer avant et après tout changement de version de Next.

## Retour arrière

Un rollback d’image ne défait pas une migration et peut ne plus savoir lire le
nouveau schéma. Préparer avant déploiement la paire version logicielle + snapshot
DB/médias vérifié. Si une restauration est nécessaire, arrêter toutes les écritures,
préserver l’état récent et suivre [les opérations](operations.md). Réconcilier les
commandes et appels transporteur postérieurs au snapshot avant toute reprise.
Ne jamais automatiser un downgrade SQL ou une recréation de colis après rollback.
Enregistrer la révision cible, les migrations appliquées, les vérifications et la
date pour que la prochaine mise à niveau parte de l’état réel de cette boutique.

## Points à revérifier à chaque mise à niveau de Next.js

Next est épinglé à **15.5.28**. Le storefront évite volontairement `next/image` côté
client et s’appuie sur des détails internes de Next ; ne pas changer la version sans
cette checklist.

- `src/components/storefront/ui/store-image.tsx` importe `getImgProps` et
  `image-loader` depuis `next/dist/shared/lib/*` (imports profonds) et lit
  `process.env.__NEXT_IMAGE_OPTS`, remplacé au build par le plugin define de Next.
  `src/components/storefront/product/gallery.tsx` construit lui-même les URLs
  `/_next/image?url=…&w=…&q=75`.
- Le dictionnaire de langue actif vient de `NEXT_PUBLIC_STORE_LOCALE`, défini dans
  `next.config.ts` (`env`) à partir de `store.config.ts` : un seul dictionnaire `fr`
  ou `ar` part dans le bundle.

Checklist :

1. Les deux chemins `next/dist/shared/lib/get-img-props` et `image-loader` existent
   toujours, avec la même signature ; `__NEXT_IMAGE_OPTS` est encore défini.
2. Les URLs `/_next/image` générées (widths, `q`) restent acceptées par l’optimiseur
   (`images.deviceSizes`/`imageSizes` de `next.config.ts`, `src/config/image-sizes`).
3. `NEXT_PUBLIC_STORE_LOCALE` est toujours inlinée : le bundle d’une boutique `fr`
   ne contient pas le dictionnaire `ar`, et inversement.
4. `DELIVERY_PROVIDER=mock npm run build` n’ouvre pas la DB, puis `npm run perf-budget`
   passe (routes `/`, `/produit/[slug]`, `/l/[slug]` toujours statiques/ISR, budget JS
   respecté ; la marge est faible).
5. `experimental.globalNotFound: true` est toujours présent dans `next.config.ts` : il est
   indispensable car il n’y a pas de layout racine de premier niveau
   (`src/app/global-not-found.tsx`). Structure multi-layouts racine : `(storefront)` et
   `(admin)` rendent chacun leur propre `<html>` ; les routes hors de ces deux groupes
   (robots, sitemap, api) n’ont besoin d’aucun layout.
6. Après `npm run start` et une première visite, `x-nextjs-cache` vaut `HIT` ou `STALE`
   sur `/`, `/boutique`, `/produit/<slug>` et `/l/<slug>` (voir
   [Cache & performance](operations.md#cache--performance)).
