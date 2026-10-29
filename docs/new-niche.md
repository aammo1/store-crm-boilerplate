# Lancer une nouvelle niche (environ une demi-journée)

Une niche = une copie du template = une application (boutique + CRM), une base
SQLite, un déploiement et des secrets propres. Ce guide va du dépôt vide à une
boutique vérifiée et en ligne. Les identifiants techniques restent en anglais.

## 1. Prérequis

- Node.js 22+, un compte GitHub, un accès Coolify (ou tout hôte Docker) et un domaine.
- Le nom de domaine, le logo (PNG/JPG/SVG/WebP), la ville, le numéro WhatsApp.
- Facultatif au départ : identifiants Meta (Pixel ID + token) et TikTok (pixel code +
  token), accès transporteur : Ozon Express (`OZON_CLIENT_ID`, `OZON_API_KEY`) ou Sendit (`SENDIT_PUBLIC_KEY`, `SENDIT_SECRET_KEY`).

## 2. Créer le dépôt

Sur `aammo1/store-crm-boilerplate` : **Use this template → Create a new repository**, puis :

```sh
git clone <votre-copie> ma-niche && cd ma-niche
npm install
```

## 3. Lancer l’assistant

```sh
npm run new-store
```

Il demande : identité (nom, slug, domaine, langue `fr`/`ar`, niche, ville), contact
(WhatsApp, téléphone, email), marque (logo, couleurs principale/accent, style, arrondis,
image principale), catégories, suivi facultatif (Meta, TikTok), choix du transporteur
(`ozon` ou `sendit`) et ses identifiants facultatifs (`OZON_*` ou `SENDIT_*`), et
le premier administrateur (email, nom, mot de passe de 12 à 128 caractères).

Il écrit : `store.config.ts`, les visuels traités dans `public/brand/`, `.env.local`
(mock, développement, avec `MOCK_COURIER_PROFILE` adapté), `.env.production.example` (production),
complète `.gitignore` (`.env*`) et crée l’administrateur. Il vérifie le TypeScript et restaure l’ancien
`store.config.ts` en cas d’erreur.

Options :

- `--answers <fichier.json>` : mode non interactif (voir `examples/new-store-answers.json`).
  Clés transporteur acceptées : `courier` (`"ozon"` ou `"sendit"`), et selon le cas
  `ozonClientId` / `ozonApiKey` ou `senditPublicKey` / `senditSecretKey`.
  Si `adminPassword` est vide, un mot de passe aléatoire est généré et affiché une seule fois.
- `--slug <slug>` : impose le slug de la boutique (prioritaire sur le fichier de réponses,
  proposé par défaut en mode interactif) ; utilisé par `new-niche.py` d’`ai-memory-boilerplate` pour garder le même nom partout.
- `--force` : écrase un `store.config.ts` déjà personnalisé et régénère `.env.local`.
- `--skip-user` : ne crée pas l’administrateur.
- `--root <dossier>` : dépôt cible (par défaut, celui du script).
- `--no-typecheck` : saute la vérification TypeScript.

> **Secrets** : `.env.production.example` contient de **vrais secrets générés**
> (`AUTH_SECRET`, `STOREFRONT_API_KEY`, et la même `CATALOG_AGENT_KEY` que `.env.local`) et,
> si saisis, vos tokens Meta/TikTok et vos identifiants transporteur (Ozon ou Sendit), en clair. Le fichier est ignoré par git malgré
> son nom « example » : ne jamais le committer, l’envoyer ou le coller ailleurs que dans
> les variables d’environnement Coolify. Il fixe `DELIVERY_PROVIDER=ozon` ou `DELIVERY_PROVIDER=sendit` si vos identifiants
> de transporteur ont été saisis, ou `mock` sinon : voir l’étape 10.

## 4. Personnaliser

- **Textes** : `store.config.ts` (héros, garanties, FAQ, avis, pages légales, annonces).
- **Section sur mesure** : créer un composant serveur dans `src/custom/`, l’enregistrer
  dans `src/custom/index.ts`, puis l’associer à un produit dans `customSections` de
  `store.config.ts` (détails dans `src/custom/README.md`).
- **Langue** : `locale: "fr"` ou `"ar"` (arabe, RTL) dans `store.config.ts`. La langue
  est fixée au build. Le CRM reste en français.
- Aperçu : `npm run dev` puis http://localhost:3000.

## 5. Produits

Dans `/admin` : nouveau produit → options (jusqu’à 3 axes, ex. taille, couleur) →
photos → stock d’ouverture dans `/crm/stock` → **packs** (ex. 1 = 199 MAD,
2 = 349 MAD, 3 = 449 MAD) et activation de la **page d’atterrissage** `/l/<slug>`
depuis la fiche produit. Le serveur calcule toujours les prix des packs ; la remise
est stockée comme remise fixe de la commande et un agent qui édite la commande la
conserve tant qu’il ne la change pas.

## 6. Paramètres

`/crm/parametres` : frais de livraison, seuil de livraison gratuite, upsell, et
si Sendit est utilisé : sélection obligatoire du **quartier de ramassage** dans « Transporteur Sendit »,
ainsi que les préférences d'ouverture et d'essayage du colis.

## 7. Équipe

`/crm/equipe` : créer les agents (rôle `agent`) et gérer leurs accès.

## 8. Déployer sur Coolify

1. Nouvelle ressource depuis le dépôt GitHub, build pack **Dockerfile**, port 3000.
2. Volume persistant sur `/app/data` (base, médias, sauvegardes et cache d’images).
3. Variables d’environnement : coller `.env.production.example`. Renseigner **obligatoirement**
   `SECURITY_TRUSTED_IP_HEADER` (ex. `x-forwarded-for` derrière un proxy inverse maîtrisé)
   **ou** `SECURITY_ACCEPT_GLOBAL_BUDGETS="1"` (sinon le conteneur refuse de démarrer). Vérifier
   `CRM_PUBLIC_URL` et `SECURITY_ALLOWED_ORIGINS` (domaine public en `https://`),
   `DELIVERY_PROVIDER` (`ozon` ou `sendit`, ou `mock` au départ si les identifiants ont été ignorés),
   les clés du transporteur choisi (`OZON_CLIENT_ID`/`OZON_API_KEY` ou `SENDIT_PUBLIC_KEY`/`SENDIT_SECRET_KEY`),
   et les tokens Meta/TikTok (`FACEBOOK_*`, `TIKTOK_*`). `PORT` doit correspondre au port écouté (3000).
4. Health check : `/api/health`.
5. **Une seule réplique** (SQLite) ; pas de déploiement roulant.
6. Le build n’a pas besoin de base. Si l’administrateur n’a pas été créé sur la base de
   production : `node scripts/create-user.mjs <email> '<mot-de-passe>' '<nom>' admin`
   dans le conteneur.

### Optionnel : Cloudflare

Non requis : Coolify + domaine + cache ISR de l’application suffisent. Si souhaité :
proxy orange, SSL Full (strict), ne jamais cacher `/crm` `/admin` `/login` `/api/*`.
Laisser `SECURITY_TRUSTED_IP_HEADER` vide (seuls `x-real-ip`/`x-forwarded-for` sont
acceptés). Détails : [operations](operations.md#optionnel--cloudflare).

## 9. Notes et limites connues

> **Budget JS** : marge faible (≈ 115,5 KiB sur `/produit/[slug]`, ≈ 117,5 KiB sur
> `/l/[slug]`, limite 120 KiB = 122 880 octets). Après tout ajout de code client,
> relancer `npm run build && npm run perf-budget`.
>
> **Limite connue** : une URL inexistante sous `/admin` ou `/crm` affiche la 404 dans la
> langue du storefront (`global-not-found`), alors que les pages qui appellent
> `notFound()` affichent la 404 française du CRM.
>
> **Limite connue** : `/merci` affiche les totaux de ligne sans remise avec le total
> serveur pour les commandes en pack (pas de ligne remise/livraison).

## 10. Vérifier

- **Fournisseur** : commencer avec `DELIVERY_PROVIDER=mock` (avec `MOCK_COURIER_PROFILE`
  défini sur `ozon` ou `sendit`), passer les commandes de test, puis basculer sur le transporteur réel
  sur une base propre (voir les sections d'activation dans [operations](operations.md)).
- **Parcours Ozon** :
  - Vérifier la connexion en lecture seule : `npm run ozon:verify -- --live --yes`.
  - Circuit d'expédition : création de colis → création et sauvegarde de BL → impression PDF du BL → remise au livreur.
  - Statuts de suivi non mappés par défaut (outcomes Livré/Refusé enregistrés manuellement par les agents).
- **Parcours Sendit** :
  - Vérifier la connexion en direct : `npm run sendit:verify -- --live --yes`.
  - Sélectionner obligatoirement le quartier de ramassage dans `/crm/parametres` → « Transporteur Sendit ».
  - Circuit d'expédition : création de colis → sélection dans « Expéditions (Étiquettes) » → impression des étiquettes 10×10 (PDF) → confirmation explicite de remise groupée au livreur.
  - Suivi automatique avec outcomes de livraison (`DELIVERED` → Livré, `REJECTED` → Refusé) et alertes `delivery_issue`.
  - En cas d'erreur de soumission incertaine : bouton « Chercher chez Sendit » dans la fiche commande pour vérifier si le colis existe chez Sendit avant toute décision.
- **Commandes de test** : une via le catalogue (panier → nom et téléphone → upsell →
  `/merci`) et une via `/l/<slug>` (pack → formulaire → upsell → `/merci`) ; elles
  apparaissent dans `/crm/orders`, avec le total attendu.
- **Cache** : `curl -sI https://domaine/produit/<slug> | grep -i x-nextjs-cache` donne
  `HIT` ou `STALE` après la première visite.
- **Meta et TikTok** : envoyer des événements de test (codes de test) et vérifier un
  seul `Purchase` dédupliqué par plateforme dans les Events Managers.
- **Budget JS** : `DELIVERY_PROVIDER=mock npm run build && npm run perf-budget`.
- **PageSpeed mobile** (`/`, un produit, une landing) : noter les résultats dans
  [release-verification](release-verification.md).

## 11. Mise à jour du template

Les copies ne reçoivent aucune mise à jour automatique : voir
[`docs/template-upgrades.md`](template-upgrades.md).

## 12. Checklist de mise en ligne

- [ ] Volume persistant monté sur `/app/data` (Coolify) : voir l’étape 8.
- [ ] Variables de base : `AUTH_SECRET` stable, `SECURITY_ALLOWED_ORIGINS` = origine exacte `https://`, tokens Meta/TikTok facultatifs.
- [ ] Transporteur actif :
  - [ ] **Option Ozon** : `DELIVERY_PROVIDER=ozon` + `OZON_CLIENT_ID` et `OZON_API_KEY` valides, test `npm run ozon:verify -- --live --yes` réussi.
  - [ ] **Option Sendit** : `DELIVERY_PROVIDER=sendit` + `SENDIT_PUBLIC_KEY` et `SENDIT_SECRET_KEY` valides, test `npm run sendit:verify -- --live --yes` réussi, quartier de ramassage configuré dans `/crm/parametres`.
  - [ ] **Option Mock** : `DELIVERY_PROVIDER=mock` temporaire si en attente des clés de production.
- [ ] Mot de passe administrateur vérifié ou changé (`scripts/create-user.mjs`, étape 8).
- [ ] Si pixels configurés : noms d’événements et événements de test confirmés dans les Events Managers Meta/TikTok.
- [ ] Une vraie commande de test passée, visible dans `/crm/orders` (étape 10).
- [ ] PageSpeed mobile sur `/`, un produit et une landing, noté dans [release-verification](release-verification.md).
- [ ] Facultatif : Cloudflare (voir l’encadré de l’étape 8).
