# Installation et opérations

## Isolation et stockage

Une boutique = un dépôt, une instance Node long-vivante, un SQLite local, un
répertoire de médias, une équipe et des secrets indépendants. Ne pas monter le
même volume dans plusieurs CRM, ni placer SQLite sur un stockage réseau ou
éphémère. Ne jamais copier la base ou les identifiants d’une autre boutique.
Les migrations SQL sont appliquées automatiquement à la première ouverture et
enregistrées dans `_migrations`. Aucun seed de produits/utilisateurs/commandes,
aucune initialisation SQLite au build. Le premier admin est une action explicite.

## Configuration runtime

`.env.example` est le contrat de configuration ; Next charge `.env.local`, tandis
que Compose lit `.env` (ou `--env-file`). Les scripts `create-user.mjs` et
`backup-db.mjs` ne chargent aucun fichier env : exporter `DB_PATH`, ou les lancer
dans le conteneur déjà configuré. Ne pas afficher `docker compose config` avec
les secrets résolus ; utiliser `config --quiet`.

| Variable CRM | Usage |
| --- | --- |
| `DB_PATH` | `./data/crm.db` hors conteneur ; `/app/data/crm.db` dans Compose |
| `UPLOAD_DIR` | Par défaut `uploads` à côté du DB ; Compose fixe `/app/data/uploads` |
| `AUTH_SECRET` | Générer `openssl rand -base64 32`, conserver stable et sauvegarder séparément |
| `CRM_PUBLIC_URL` | Origine canonique publique des médias, sans chemin/query ni identifiants ; HTTPS en production |
| `STOREFRONT_API_KEY` | `openssl rand -hex 32`, ≥32 caractères ; absent/invalide désactive v1 (503) |
| `SECURITY_ALLOWED_ORIGINS` | Liste séparée par virgules d’origines navigateur CRM exactes, protocole et port inclus ; sans wildcard |
| `SECURITY_TRUSTED_IP_HEADER` | Vide par défaut ; seules valeurs acceptées : `x-real-ip` ou `x-forwarded-for` (dernier saut) ; `CF-Connecting-IP` n’est **pas** supporté (ignoré). Opt-in uniquement derrière un proxy maîtrisé |
| `DELIVERY_PROVIDER` | **Obligatoire en production** : exactement `mock`, `ozon` ou `sendit`, sinon le démarrage échoue. **Seule la valeur exacte `mock`** sélectionne le mock dans le code ; `sendit` sélectionne Sendit ; toute autre valeur ou variable omise sélectionne Ozon. `ozon` exige `OZON_CLIENT_ID` et `OZON_API_KEY` ; `sendit` exige `SENDIT_PUBLIC_KEY` et `SENDIT_SECRET_KEY`. Compose refuse de démarrer sans elle. Garder `mock` jusqu’à l’activation autorisée |
| `MOCK_COURIER_PROFILE` | Profil simulé quand `DELIVERY_PROVIDER=mock` : `ozon` (défaut) ou `sendit`. Simule les capacités du transporteur (BL vs étiquettes 10×10, helper de recherche) |
| `OZON_CLIENT_ID`, `OZON_API_KEY` | Identifiants propres au compte de cette boutique, inutiles pour mock |
| `OZON_BASE_URL` | `https://api.ozonexpress.ma` par défaut |
| `OZON_USE_CUSTOM_TRACKING` | `0` par défaut ; activer seulement après validation du compte/provider |
| `SENDIT_PUBLIC_KEY`, `SENDIT_SECRET_KEY` | Clés API Sendit propres au compte de cette boutique, inutiles pour mock |
| `SENDIT_BASE_URL` | `https://api.sendit.ma` par défaut |
| `COURIER_SUBMIT_INTERVAL_SEC` | 15 s par défaut, minimum 5 s (remplace `OZON_SUBMIT_INTERVAL_SEC` avec repli automatique) |
| `COURIER_POLL_INTERVAL_MIN` | 30 min par défaut, minimum 5 min (remplace `OZON_POLL_INTERVAL_MIN` avec repli automatique) |
| `COURIER_TRACK_BATCH` | 25 par défaut (remplace `OZON_TRACK_BATCH` avec repli automatique) |
| `CATALOG_AGENT_KEY` | Secret dédié ≥32 caractères ; vide désactive l’API catalogue automatisée |
| `FACEBOOK_PIXEL_ID`, `FACEBOOK_ACCESS_TOKEN` | Meta serveur facultatif, désactivé sans ID numérique et token ; le CRM n’y monte aucun Pixel ; les Pixels navigateur du storefront viennent des identifiants de `store.config.ts` et sont dédupliqués avec les événements serveur par ID d’événement |
| `FACEBOOK_TEST_EVENT_CODE`, `FACEBOOK_API_VERSION` | Code test facultatif et version Graph (`v22.0` par défaut) |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | Assistant lecture seule facultatif ; clé vide le laisse indisponible, modèle par défaut dans `.env.example` |
| `TIKTOK_PIXEL_ID`, `TIKTOK_ACCESS_TOKEN` | TikTok Events API serveur facultatif, désactivé sans les deux ; le token reste en env serveur |
| `TIKTOK_TEST_EVENT_CODE`, `TIKTOK_API_BASE` | Code test facultatif ; base API v1.3 par défaut |
| `SECURITY_ACCEPT_GLOBAL_BUDGETS` | `1` pour accepter explicitement, en production, des budgets de débit globaux uniquement (sans en-tête IP de confiance) |
| `HEALTH_DETAILS_TOKEN` | Facultatif, ≥32 caractères ; active le détail de `/api/health` en Bearer. Sans lui, la route publique ne renvoie que `{status, time}` |
| `LOG_FORMAT` | `json` (défaut en production) ou `pretty` (défaut en dev) |
| `LOG_LEVEL` | `debug` pour émettre les logs debug en production ; sinon ignoré |
| `MIGRATIONS_ALLOW_CHECKSUM_MISMATCH` | **Récupération uniquement** (`1`), voir « Migrations et checksums » ; à retirer ensuite |
| `BACKUP_DIR`, `BACKUP_RETENTION`, `BACKUP_RCLONE_REMOTE` | Lus par `scripts/backup-db.mjs` : dossier (défaut `<dossier DB>/backups`), jeux conservés (défaut 14), destination rclone facultative |

Variables internes, à ne pas définir : `NODE_ENV`, `NEXT_RUNTIME`, `NEXT_PHASE`,
`PORT`, `NEXT_PUBLIC_STORE_LOCALE` (dérivée de `store.config.ts`) et
`__NEXT_IMAGE_OPTS` (injectée par Next au build).


La clé storefront donne accès aux seules routes v1, pas à l’administration ou
aux sessions Auth.js. La clé catalogue est distincte. Ne jamais exposer ces clés
en `NEXT_PUBLIC_*`, URL, logs, captures ou JSON de paramètres.
`CRM_PUBLIC_URL` ne remplace pas l’allowlist des mutations navigateur.
Le storefront appelle v1 côté serveur : ne pas ajouter son origine à l’allowlist
CRM pour contourner cette frontière. Son propre proxy contrôle son origine.

Ne faire confiance à une IP transférée que si le reverse proxy écrase
`x-real-ip` ou garantit le dernier hop de `x-forwarded-for`, et si l’accès direct
au service est bloqué. Sans cela, laisser `SECURITY_TRUSTED_IP_HEADER` vide ; les
budgets globaux/compte/téléphone restent actifs. Configurer aussi les limites de
corps, connexions et débit au proxy. Ne pas dériver des permissions du `Host`
fourni par l’appelant.

## Checklist de production

Au démarrage, `src/lib/env.ts` valide l’environnement et **interrompt le boot**
avec la liste des problèmes (en production) :

- `AUTH_SECRET` présent, ≥32 caractères ; `CRM_PUBLIC_URL` URL absolue sans chemin.
- `SECURITY_ALLOWED_ORIGINS` : origines exactes en HTTPS, sans joker.
- `DELIVERY_PROVIDER` valant `mock`, `ozon` ou `sendit` (et identifiants requis pour le transporteur actif : `OZON_*` ou `SENDIT_*`).
- `SECURITY_TRUSTED_IP_HEADER` (`x-real-ip` ou `x-forwarded-for`, seulement derrière
  un proxy qui l’écrase) **ou** `SECURITY_ACCEPT_GLOBAL_BUDGETS=1`. Dans ce second
  cas il n’existe que des budgets globaux : un seul client abusif peut épuiser les
  budgets de commande/connexion de tous. Ajouter alors une limite de débit au
  reverse proxy.

Avertissements au boot et dans `/api/health` détaillé : `DELIVERY_PROVIDER=mock` en
production (aucun colis réel n’est créé — les commandes confirmées ne partent pas
chez le transporteur) et budgets globaux acceptés. Un mock en production doit être
une décision explicite et temporaire.

Ne jamais committer de fichier env de production (`.env`, `.env.local`,
`.env.production*`) : ils restent privés sur le serveur ou dans le gestionnaire de
secrets de la plateforme. Seul `.env.example` (sans valeur réelle) est versionné.

Workers : un **bail en base** (90 s de TTL, renouvelé par heartbeat) garantit un seul
propriétaire de workers par DB. Un second processus sur la même DB ne démarre pas
les workers tant que le bail est valide ; après un arrêt brutal, attendre
l’expiration du TTL avant de relancer. Le déploiement reste un seul processus par DB.

## Déploiement Docker

Suivre les commandes du [README](../README.md), avec un `-p` unique et un fichier
env privé par boutique. Compose fournit `crm` sur `127.0.0.1:3000` et un volume
`<projet>_crm-data:/app/data`. Pour plusieurs boutiques sur une machine, donner
un port hôte distinct à chacune via `docker-compose.local.yml` (ignoré), chargé
explicitement avec `-f docker-compose.yml -f docker-compose.local.yml`.
Ne pas utiliser `down -v` sur une installation à conserver.

Le Dockerfile utilise Node 22 Alpine pour tous les stages. `better-sqlite3` 13
fournit les bindings musl ; un test `:memory:` vérifie le binding avant le build.
`npm ci --ignore-scripts` conserve ce mode précompilé ; réévaluer cette décision
si une dépendance commence à nécessiter une compilation/install script. Le
tracing Next inclut migrations et prebuilds ; l’image copie aussi le package
SQLite complet pour les outils CLI. Ne pas mélanger un module natif compilé sur
une autre version Node/libc avec cette image.

Le runner est nonroot UID/GID **1001:1001**, écoute sur `0.0.0.0:3000`, et ne
modifie que les données et le cache Next prévus. Un volume nommé neuf récupère
les permissions du répertoire de l’image. Un bind mount ou volume ancien doit
être préparé par l’administrateur pour UID/GID 1001, y compris DB/WAL/uploads/
backups. Vérifier les droits avant démarrage ; ne pas passer le service en root
pour masquer une erreur de permissions.

Reverse proxy : HTTPS public, port interne 3000, origine CRM exacte dans les
variables, en-têtes forwarding maîtrisés. En Coolify, utiliser une ressource
Dockerfile pour ce CRM, port 3000, stockage persistant dédié `/app/data`, secrets
runtime et domaine HTTPS. Utiliser le déploiement à instance unique avec arrêt
de l’ancien processus avant remplacement ; pas de déploiement roulant qui fait
tourner deux owners SQLite/workers. Le storefront est une autre ressource avec
ses secrets serveur propres. Aucune base PostgreSQL/Redis n’est requise par le CRM.

## Santé et surveillance

`GET /api/health` ouvre/vérifie la DB. Réponse publique : uniquement
`{status, time}` avec `status` = `ok` ou `degraded` (HTTP 200), ou `down` (HTTP 503,
erreur DB). `degraded` signale un worker activé dont le heartbeat est périmé ou qui
cumule au moins 5 erreurs consécutives. Avec `Authorization: Bearer $HEALTH_DETAILS_TOKEN`
(variable ≥32 caractères) la réponse ajoute `db`, `provider`, `warnings`, `lease`,
`workers.{submission,tracking,meta,tiktok}.{enabled,lastTickAt,stale,…}`,
`courier.{provider,configured,pickupDistrictConfigured,healthy,lastCheckedAt,message}`
et les compteurs `queues.{submissionsQueued,submissionsNeedsReview,submissionsFailed}`. Le healthcheck
Docker teste cette URL sur `127.0.0.1`, délai initial 60 s ; il reste vert en
`degraded` : surveiller le champ `status` depuis un moniteur externe (avec le token
pour le détail). Il ne valide ni les identifiants ni la livraison effective ;
un tick indique une boucle exécutée, pas un appel provider réussi.

Dans le CRM (`/crm`), la carte **« Santé transporteur »** affiche le statut du provider actif,
la configuration des clés et du quartier de ramassage, ainsi que l'état des workers et les soumissions
en souffrance (`needs_review`). Un bouton **« Tester la connexion »** permet de tester en direct la
connectivité avec le transporteur (requête bridée à un test toutes les 10 s). Les logs sont
structurés (`LOG_FORMAT`), sans données personnelles ni URL à identifiants.
Les workers démarrent via l’instrumentation Node : soumission, tracking, Meta
facultatif et synchronisation des villes. Garder le processus long-vivant.

Le mock est en mémoire par processus : la DB persiste après redémarrage, mais les
faux colis du provider ne persistent pas. Utiliser une installation jetable pour
les parcours mock, sans considérer ceux-ci comme un historique transporteur réel.

## Premier admin et récupération d’accès

```sh
docker compose --env-file .env -p ma-boutique exec crm node scripts/create-user.mjs admin@example.test '<mot-de-passe-unique-12-a-128-caracteres>' 'Administrateur' admin
```

Le script doit être lancé depuis `/app` dans l’image ou depuis la racine du dépôt
en local pour trouver `migrations/`. Il crée le schéma frais si nécessaire, puis
crée **ou met à jour** l’email normalisé : mot de passe scrypt, nom, rôle,
réactivation et incrément de version de session pour un compte existant. Le rôle
`agent` fonctionne de la même façon ; l’admin gère ensuite l’équipe dans `/crm/equipe`.
Le mot de passe est de 12 à 128 caractères. Ne pas l’enregistrer dans les docs ou
les scripts de déploiement ; utiliser un terminal privé sans historique sensible.

## Sauvegarde et restauration vérifiée

```sh
# Local, avec DB_PATH exporté si différent du défaut :
npm run backup
# Conteneur (le package.json standalone ne garantit pas le script npm) :
docker compose --env-file .env -p ma-boutique exec crm node scripts/backup-db.mjs
```

Le script refuse une DB absente, ouvre la source existante en lecture seule et
utilise l’API de backup SQLite pour produire un snapshot cohérent même avec WAL.
Avant toute écriture du snapshot, il impose un umask `077`, crée ou restreint le
répertoire `backups/` à `0700`, puis réserve exclusivement le fichier à `0600`.
Ces droits sont réservés au propriétaire, même si l’umask appelant est `022` ;
un répertoire existant doit donc appartenir à l’utilisateur qui lance le script.
Dans Docker, ce propriétaire est UID 1001. Le parent `/app/data` reste un volume
de travail pour DB/uploads ; ses droits ne constituent pas la frontière privée
des sauvegardes : `backups/` et les nouveaux snapshots ont leurs propres droits
restrictifs. Ne pas partager ce volume avec des utilisateurs non autorisés ; root
et les administrateurs de l’hôte restent capables d’accéder aux données. Les anciens
snapshots déjà créés ne sont pas chmodés par le script : corriger leurs droits
avant de les copier hors du répertoire privé.
Chaque exécution produit un jeu daté : `crm-<horodatage>.db` (snapshot SQLite),
`uploads-<horodatage>.tar.gz` (médias) et `manifest-<horodatage>.json` (sha256 de
chaque artefact). La rétention (`BACKUP_RETENTION`, 14 jeux par défaut) s’applique
à ces trois préfixes dans `backups/` (donc `/app/data/backups` en Compose, ou
`BACKUP_DIR`). Si `BACKUP_RCLONE_REMOTE` est défini, chaque artefact est aussi copié
hors hôte avec `rclone copy` ; rclone doit être installé et configuré séparément
(ses identifiants ne vont jamais dans ce dépôt) et son absence fait échouer le
backup. Les secrets (`AUTH_SECRET`, clés) ne sont pas sauvegardés : les conserver
chiffrés ailleurs. Ce n’est pas un planificateur : utiliser les exemples de
`deploy/backup/` (`crm-backup.cron`, ou `crm-backup.service` + `crm-backup.timer`
systemd ; remplacer `<container>` par le conteneur en cours) et surveiller le code
de sortie. Une sauvegarde locale seule ne protège pas contre la perte du
disque/volume : configurer l’offsite avec une rétention indépendante et un accès
limité. Pour un point de restauration DB+médias strictement commun, mettre les
écritures en maintenance pendant la capture. Ne pas copier seulement `crm.db` à
chaud en ignorant son WAL.

**Vérifier un snapshot** (copie temporaire, n’ouvre jamais la DB vivante) :

```sh
npm run backup:verify                      # dernier crm-*.db de BACKUP_DIR
npm run backup:verify -- /chemin/crm-<horodatage>.db
docker compose --env-file .env -p ma-boutique exec crm node scripts/verify-backup.mjs
```

Il contrôle le sha256 du manifeste, `integrity_check`, `foreign_key_check` et que
le nombre de migrations appliquées égale celui des fichiers, puis affiche les
comptages commandes/produits. Un code de sortie non nul = backup inutilisable.

Contrôle manuel équivalent (chemin à adapter, ne modifie pas la source) :

```sh
DB_PATH=/chemin/backup/crm-snapshot.db node --input-type=module -e 'import Database from "better-sqlite3"; const db=new Database(process.env.DB_PATH,{readonly:true,fileMustExist:true}); const result=db.pragma("integrity_check"); if(result.length!==1 || result[0].integrity_check!=="ok" || db.pragma("foreign_key_check").length) process.exitCode=1; console.log(result); db.close();'
```

**Exercice de restauration** (au moins à chaque changement de version majeure, et trimestriellement) : tester une restauration complète dans **un autre répertoire/volume
isolé**, avec `DELIVERY_PROVIDER=mock`, clés de test, intégrations externes
désactivées et sans trafic public. Restaurer DB et uploads, attribuer les droits
1001, lancer la version logicielle correspondante puis vérifier santé, connexion,
comptages et médias. Employer le `AUTH_SECRET` émetteur dans un environnement privé
si l’on doit tester les anciens tokens ; une clé éphémère ne permet pas leur replay.

Pour restaurer réellement : arrêter le storefront et le CRM (y compris workers),
conserver une copie de l’état en panne, remplacer la DB et les médias par la
sauvegarde validée et retirer les anciens fichiers `crm.db-wal`/`crm.db-shm` de la
destination arrêtée. Ne jamais garder des sidecars d’une autre DB. Rétablir les
droits et secrets, redémarrer une seule instance puis réconcilier les opérations
courier effectuées après la sauvegarde avant reprise du trafic. Restaurer SQLite
ne restaure pas le portail transporteur : aucun retry aveugle d’opération incertaine.

## Migrations et checksums

Chaque migration appliquée est enregistrée dans `_migrations` avec son checksum
sha256 ; les lignes plus anciennes sans checksum sont complétées au premier boot.
Une erreur de migration interrompt le démarrage (aucune erreur avalée) et la
transaction de ce fichier est annulée. Si un fichier déjà appliqué a été modifié, le
boot échoue (« modifiée après application »). Procédure :

1. **Ne jamais éditer** une migration appliquée ; restaurer le fichier d’origine
   depuis git (`git checkout -- migrations/NNN_*.sql`) puis redéployer.
2. Seulement si la divergence est connue, comprise et inoffensive (par exemple fin de
   ligne) et que le fichier d’origine est introuvable : démarrer **une fois** avec
   `MIGRATIONS_ALLOW_CHECKSUM_MISMATCH=1` (avertissement journalisé), puis retirer la
   variable. Les changements de schéma passent par une **nouvelle** migration.
3. Faire un backup vérifié avant toute récupération.

## Outcomes de livraison (Ozon et Sendit)

Les outcomes **Livré** / **Refusé** alimentent la fiche client, la blocklist, les KPI et les encaissements COD.
Le comportement diffère selon le transporteur actif :

- **Sendit** : les statuts reposent sur la liste officielle publiée par le plugin WooCommerce de Sendit
  (`sendit-ma-integration` v2.2.x, `GET /all-status-deliveries`). Le poller de suivi met automatiquement
  à jour les commandes :
  - `DELIVERED` normalise en `delivered` et enregistre automatiquement l'outcome **Livré** (crédite le cash à encaisser, met à jour l'historique client et les KPI).
  - `REJECTED` normalise en `refused` et enregistre automatiquement l'outcome **Refusé** (retour en stock physique selon la politique, alimentation de la blocklist et des taux de refus).
  - `UNREACHABLE`, `POSTPONED`, `NEW_DESTINATION` normalisent en **`delivery_issue`** : la commande est signalée avec une alerte d'incident de livraison pour permettre aux agents de relancer rapidement le client par téléphone ou WhatsApp.
  - `PENDING`, `TO_PREPARE`, `TOPICKUP` normalisent en `awaiting_pickup` (en attente de ramassage).
- **Ozon** : la table `OZON_STATUS_MAP` est **volontairement vide** : aucun statut Ozon n'étant vérifié par une documentation officielle, aucun mapping n'est inventé. Tout statut inconnu normalise en `unknown`.
  Les agents continuent d'enregistrer **manuellement** Livré / Refusé depuis la fiche commande jusqu'à ce que le propriétaire observe des statuts réels (`npm run ozon:verify`) et valide les correspondances.

## Rapprochement COD (encaissements)

Flux dans `/crm/encaissements` : 1) les commandes livrées représentent du COD à
encaisser (vieillissement des impayés affiché) ; 2) importer le relevé CSV du
transporteur : l’aperçu devine les colonnes (numéro de suivi, montant versé, frais),
vous corrigez le mapping ; 3) le CRM rapproche chaque ligne à une commande par numéro
de suivi ; les écarts de montant doivent être acceptés explicitement ou traités par un humain ;
4) valider enregistre la remise (annulable depuis son détail).

**Compte transporteur partagé entre plusieurs boutiques** : si un même compte Sendit ou Ozon est
utilisé pour expédier les colis de plusieurs boutiques, le relevé CSV de versement regroupe
les colis de l’ensemble de ces boutiques. Le CRM identifie automatiquement les lignes inconnues
comme **« Lignes d’autres boutiques »** (`foreign`) : présentées dans un onglet séparé, elles
sont ignorées pour le calcul financier de cette boutique et **ne bloquent plus** la validation
de la remise COD. Seuls les écarts de montant sur les commandes appartenant réellement à cette
boutique requièrent une acceptation explicite.

Les dépenses publicitaires (`/crm/depenses`), le coût variante, les tarifs par ville et les KPI
(confirmation, livraison, profit, ROAS, cash remis) se lisent sur le tableau de bord ;
les commandes s’exportent en CSV depuis la liste. Valider les montants contre le
portail transporteur avant de considérer un écart comme réglé.

## Paniers abandonnés (leads) et obligations légales

La capture de paniers abandonnés est **désactivée par défaut** (`leads.enabled` dans
`store.config.ts` ; la route `/api/store/leads` répond 404 sinon) et se consulte dans
`/crm/paniers`. Elle enregistre des données personnelles (téléphone normalisé, nom
facultatif, variantes/quantités) avant toute commande : informer le client dans la
page Confidentialité et ne l’activer qu’avec une base légale (loi marocaine 09-08,
CNDP : déclaration/autorisation selon votre cas). Les leads de plus de 30 jours
(`LEAD_RETENTION_DAYS`) sont purgés automatiquement, quel que soit leur statut ; un
téléphone bloqué n’est jamais enregistré.

Ces textes n’ont pas valeur de conseil juridique : faire valider par le
propriétaire. La page de suivi client `/suivi` ne révèle une commande qu’avec la
référence de commande (affichée sur la page de remerciement) et le téléphone
correspondant ; toute erreur renvoie la même réponse vide. L’attribution UTM (source/campagne) est
capturée par le storefront intégré.

## Activation Ozon par le propriétaire

Conserver mock jusqu’à réception des identifiants du compte **de cette boutique**,
validation du contrat provider, des villes, du payload, du suivi et des BL.
Préparer une base live propre : ne pas envoyer les commandes de test mock à Ozon.
Dans Compose, définir explicitement `DELIVERY_PROVIDER=ozon` pour sortir du défaut
mock ; au runtime toute valeur autre que `mock` sélectionne l’adapter Ozon.

Vérification live existante, **lecture seule et accord explicite du propriétaire** :

```sh
npm run ozon:verify -- --live --yes
# Facultatif après autorisation pour un code réel : ajouter --code CODE_AUTORISE
```

Ce script est une action réseau réelle, même avec `DELIVERY_PROVIDER=mock` : il
appelle directement Ozon, charge `.env.local` si présent (parseur simple), et
requiert `OZON_CLIENT_ID`/`OZON_API_KEY`. Préférer des variables exportées privées
dans le dépôt cible. Il observe villes, tracking sur code factice et éventuellement
tracking/parcel-info réel ; il ne crée aucun colis, n’applique pas de mapping et
ne certifie pas le workflow d’expédition. Sa sortie brute peut contenir des données
client/provider : la relire et la caviarder avant tout partage. Ne pas exposer les
URLs `/customers/<id>/<key>/...` dans logs, tickets ou captures.

Les statuts de suivi Ozon ne sont volontairement **pas** mappés : `STATUS_MAP`
(`src/lib/shipping/status-map.ts`) est vide, donc tout statut s’affiche « inconnu » et
rien ne modifie le stock automatiquement, jusqu’à capture de statuts réels selon
`src/lib/shipping/POLICY.md`.

Les mappings inconnus/non vérifiés restent tels quels ; ils ne doivent jamais
déplacer le stock automatiquement. Le worker seul crée les colis ; le poller seul
lit le suivi opérationnel. BL/handoff exigent une action explicite, une claim
durable, et une réconciliation portail enregistrée en cas d’issue incertaine.
Ne pas relancer un BL incertain ou reprendre automatiquement une lease expirée.

## Activation Sendit par le propriétaire

Conserver `mock` (avec `MOCK_COURIER_PROFILE=sendit`) jusqu’à réception des clés API du
compte Sendit **de cette boutique** (`SENDIT_PUBLIC_KEY` et `SENDIT_SECRET_KEY`).
Préparer une base live propre : ne pas envoyer les commandes de test mock à Sendit.
Dans Compose, définir explicitement `DELIVERY_PROVIDER=sendit`.

Vérification live existante, **lecture seule et accord explicite du propriétaire** :

```sh
npm run sendit:verify -- --live --yes
# Facultatif après autorisation pour inspecter un code réel : ajouter --code CODE_SUIVI
```

Ce script est une action réseau réelle, même avec `DELIVERY_PROVIDER=mock` : il
appelle directement l'API Sendit, charge `.env.local` si présent (parseur simple),
et requiert `SENDIT_PUBLIC_KEY`/`SENDIT_SECRET_KEY`. Il vérifie la validité des clés,
échantillonne les quartiers et villes desservis, inspecte la liste officielle des statuts
et affiche les tarifs de livraison. Il ne crée aucun colis.
Ne jamais exposer `SENDIT_SECRET_KEY` dans les logs, tickets ou captures d’écran :
toutes les clés secrètes sont automatiquement caviardées par le CRM dans les traces et réponses.

### Checklist premier colis réel Sendit

1. **Variables d’environnement** : `DELIVERY_PROVIDER=sendit`, `SENDIT_PUBLIC_KEY`, `SENDIT_SECRET_KEY`.
2. **Synchronisation des villes et quartiers** : exécutée automatiquement au démarrage du CRM
   ou via `npm run sendit:verify -- --live --yes`. Les villes portent `provider = 'sendit'`,
   leurs noms arabes (`arabic_name`) et le drapeau point relais (`is_pickup`).
3. **Quartier de ramassage configuré** : se rendre dans `/crm/parametres` → « Transporteur Sendit »,
   sélectionner obligatoirement votre quartier de ramassage (`pickupDistrictId`, requis par l'API Sendit),
   puis activer si souhaité l’ouverture de colis (`allowOpen`) et l’essayage (`allowTry`).
   Sans quartier de ramassage configuré, la création de colis Sendit échoue.
4. **Vérification des tarifs par ville** : la synchronisation pré-remplit les tarifs de livraison
   depuis les prix retournés par Sendit. Ajuster la grille dans `/crm/parametres`.
5. **Adresse client valide** : la confirmation d'une commande exige une adresse d'au moins 5
   caractères pour Sendit (`confirmation.ts`).

### Workflow d’expédition : Étiquettes 10×10 et remise groupée

Contrairement à Ozon, Sendit ne fonctionne pas avec des bons de livraison (BL). Le CRM adapte
automatiquement son interface selon les capacités du transporteur (`src/lib/shipping/couriers.ts`) :
- Dans `/crm/expeditions`, l’onglet affiche **« Expéditions (Étiquettes) »**.
- L'agent sélectionne les colis prêts et clique sur **« Générer les étiquettes (PDF) »** :
  le serveur diffuse le flux PDF 10×10 officiel retourné par Sendit (`/api/crm/labels/pdf`).
- L'agent clique ensuite sur **« Confirmer la remise au livreur »** : action explicite qui
  met à jour en lot le statut des commandes en `in_transit` (`/api/crm/parcels/handoff`).

### Soumission, workers et outil de recherche Sendit

- Le worker seul crée les colis (`COURIER_SUBMIT_INTERVAL_SEC`, défaut 15 s) ; le poller seul
  lit le suivi opérationnel (`COURIER_POLL_INTERVAL_MIN`, défaut 30 min, par lot `COURIER_TRACK_BATCH`).
- En cas de saturation de l’API Sendit (HTTP 429), l’adaptateur lève une erreur `throttled` : la
  soumission est automatiquement replacée en `queued` avec un délai d’attente sécurisé (`retryAfterSec`
  ou backoff), sans passer par `needs_review`.
- En cas d’échec incertain (timeout réseau, erreur HTTP inconnue), la soumission passe immédiatement en
  `needs_review` : aucun retry aveugle.
- **Outil de recherche chez Sendit** : dans la fiche commande (`/crm/orders/[id]`), le formulaire
  de résolution affiche le bouton **« Chercher chez Sendit »** (`/api/crm/submissions/[id]/lookup`).
  Cet outil est **strictement en lecture seule** : il interroge Sendit avec la référence unique de
  la commande (`"<slug>-<orderId>"`) et le téléphone du client. Si le colis existe déjà chez Sendit,
  l'agent peut lier directement le numéro de suivi sans recréer de doublon. Si le colis n'existe
  pas, l'agent peut relancer la création en toute sécurité.

## Rotation et mises à niveau

Conserver les secrets de façon durable et privée. Une rotation de `AUTH_SECRET`
invalide sessions et tokens dérivés : anciens replays checkout →
`TOKEN_SECRET_CHANGED`, anciens tokens upsell invalides. Les reçus ne disparaissent
pas et empêchent de recréer une commande avec la même clé, mais ils ne rendent
pas la rotation transparente. Il n’y a pas de keyring multi-secrets. Mettre le
checkout en maintenance, traiter les tentatives incertaines, fermer les parcours
ouverts et prévoir le traitement marchand des replays historiques avant rotation.
La simple attente de 20 secondes ne résout pas les replays historiques.
Coordonner la rotation de clé storefront avec son serveur ; aucune double clé
automatique. Voir [intégration](storefront-integration.md) pour le cookie exemple
et [mises à niveau](template-upgrades.md) pour migrations/rollback.

## Coolify (voie par défaut)

Ressource **Dockerfile** depuis le dépôt GitHub de la niche, port 3000, **une seule
réplique** (SQLite) avec arrêt de l’ancien conteneur avant remplacement. Volume
persistant monté sur `/app/data` : il contient `crm.db`, `uploads`, `backups` **et le
cache d’images** `/app/data/image-cache` (lien depuis `/app/.next/cache/images`).
Domaine pointé vers le VPS, HTTPS géré par Coolify ; aucun CDN requis : l’ISR de l’application (voir « Cache & performance ») suffit. Variables : coller `.env.production.example` (voir [new-niche](new-niche.md)). Health
check : `/api/health`. **`PORT` doit correspondre au port réellement écouté** (3000
dans l’image) : le préchauffage au démarrage appelle `http://127.0.0.1:${PORT ?? 3000}`.
Un `PORT` différent du port d’écoute laisse `/` et `/boutique` vides jusqu’à la
revalidation de 300 s.

## Optionnel : Cloudflare

Facultatif, jamais requis : la boutique est déjà rapide sans CDN. À configurer par le
propriétaire (action manuelle) seulement si un cache de bord est souhaité.

- **DNS** proxifié (nuage orange) ; **SSL/TLS : Full (strict)** avec le certificat
  Let’s Encrypt de l’origine.
- **Ne jamais mettre en cache** `/crm`, `/admin`, `/login`, `/api/*` (sauf
  `/api/media/*` et `/api/store/cross-sells`) ni `/merci`, ni avec le cookie
  `authjs.session-token`.
- **Respecter le `Cache-Control` de l’origine** : `/_next/static/*` (immutable),
  `/_next/image*`, `/api/media/*`, `/brand/*` (immutable), `/images/*`. Pages publiques
  (`/`, `/boutique*`, `/produit/*`, `/l/*`, pages de contenu) : Edge TTL 60 s au plus ;
  après un gros changement de catalogue, purger depuis Cloudflare.
- Brotli et HTTP/3 : oui. Rocket Loader : **non** (casse le chargement différé des pixels).
- **IP client** : `SECURITY_TRUSTED_IP_HEADER` n’accepte que `x-real-ip` ou
  `x-forwarded-for` (dernier saut ; toute autre valeur, dont `CF-Connecting-IP`, est
  ignorée : aucune IP de confiance). **Laisser vide** sauf si la chaîne de proxys
  fournit l’IP réelle du visiteur. Sinon les limites par IP et la CAPI Meta/TikTok
  voient l’IP du proxy/bord (ou aucune) ; les budgets globaux/compte/téléphone restent
  actifs.

## Cache & performance

- **Fraîcheur** : les pages `/`, `/boutique`, `/boutique/[categorie]`,
  `/produit/[slug]` et `/l/[slug]` sont servies par l’ISR de Next (`revalidate = 300`)
  et le cache de données `unstable_cache` étiqueté `storefront`. `revalidateStorefront()`
  (tag + `revalidatePath("/", "layout")`) est appelé après chaque mutation visible :
  produits/packs/archivage/restauration, paramètres, stock (ouverture, ajustement,
  lot), confirmation/annulation/édition/lignes de commande, inspection des
  retours et agent catalogue. Les 300 s rattrapent un oubli.
- **Build sans base** : `generateStaticParams` renvoie `[]` et les loaders
  storefront renvoient des données vides pendant `phase-production-build`. Le build
  n’ouvre jamais SQLite. Au démarrage, un préchauffage (`/api/internal/warmup`,
  jeton dérivé d’`AUTH_SECRET`) invalide les pages vides puis rend `/` et
  `/boutique` ; voir la note `PORT` ci-dessus. Les autres pages se remplissent à la
  première visite.
- **Cache d’images** `/app/data/image-cache` : sans risque à supprimer, il se
  reconstruit à la demande.
- **Contrôle** (HIT/STALE attendus après la première visite, jamais MISS à chaque
  requête) :

  ```sh
  for p in / /boutique /produit/<slug> /l/<slug>; do
    curl -sI "https://votre-domaine$p" | grep -i '^x-nextjs-cache'
  done
  # Si Cloudflare est utilisé : curl -sI ... | grep -i '^cf-cache-status'
  ```

- **Interdit dans `src/app/(storefront)`**, car cela rend la route dynamique :
  `cookies()`, `headers()`, `searchParams`, `auth()`, `connection()`,
  `export const dynamic = "force-dynamic"`.
- **Budget JS** : ≤ 120 KiB (122 880 octets) gzip au premier chargement sur `/produit/[slug]` et
  `/l/[slug]`. Après un build :

  ```sh
  DELIVERY_PROVIDER=mock npm run build && npm run perf-budget
  ```

  `scripts/perf-budget.mjs` ne lit que `.next` (jamais la DB). Pour chaque route il
  prend `pages[route]` de `.next/app-build-manifest.json` plus l’entrée du layout racine
  storefront `/(storefront)/layout`, fichiers `.js` uniquement, dédupliqués, gzip niveau 9,
  puis somme. Le budget par défaut est 120 KiB (122 880 octets), modifiable avec
  `PERF_BUDGET_KB`. Il échoue (code 1) si un budget est dépassé, si `.next` ou une
  route manque, si une route storefront n’est plus statique/ISR, ou si un chunk
  de ces routes contient `libphonenumber`, `ZodError`, `better-sqlite3` ou
  `node:crypto`. Il affiche aussi `/`, `/boutique`, `/merci` et une page de
  contenu pour information. La marge est faible (build de revue : `/produit/[slug]` ≈ 115,5 KiB, `/l/[slug]`
  ≈ 117,5 KiB sur 120 KiB, soit ≈ 118,3 et ≈ 120,3 kB décimaux ; relancer
  `npm run perf-budget` pour les valeurs exactes). Tout ajout de code client
  storefront impose de relancer le budget après build. Si le budget approche : si le budget approche, alléger
  l’îlot du layout storefront ou charger paresseusement l’UI rarement utilisée.
- **Toaster** : `sonner` n’est monté que dans le layout `(admin)` et dans un toaster
  de superposition chargé paresseusement par l’hôte du tunnel. Un nouveau code
  storefront ne doit pas importer `sonner` ni `components/ui/sonner` dans le bundle
  initial.
- **Packs** : une remise de pack est stockée comme remise fixe de commande, avec
  `pack_snapshot_json` pour le détail. Si un agent modifie la commande, la remise
  fixe est conservée jusqu’à ce que l’agent la change ; il n’y a aucun recalcul
  automatique.

## Limites connues

- `/merci` affiche les totaux de ligne sans remise avec le total serveur pour les
  commandes en pack : pas encore de ligne de remise ni de livraison.
- Sans IP client fiable (voir « IP client »), les limites par IP et la CAPI voient
  l’IP du proxy/bord.
