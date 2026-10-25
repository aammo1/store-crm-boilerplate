# Automatisation locale du catalogue

L’API optionnelle `/api/catalog-agent` gère les produits et leurs variantes génériques : création, modification, archivage et restauration. Elle utilise les mêmes schémas et services que l’administration. Les prix sont des entiers MAD ; les catégories sont du texte libre. Elle ne gère ni commandes, ni expéditions, ni corrections du stock existant.

## Configuration

Sur le serveur CRM, définir `CATALOG_AGENT_KEY` avec un secret aléatoire d’au moins 32 caractères. Sans cette variable (ou avec une valeur trop courte), la surface est désactivée (503). L’authentification est `Authorization: Bearer <secret>` ; une clé storefront distincte ne donne aucun accès catalogue.

Sur la machine exécutant le client versionné du dépôt :

```sh
export CRM_CATALOG_URL=http://localhost:3000
export CRM_CATALOG_KEY='<même secret catalogue fourni à l’exécution>'
node scripts/catalog-agent-client.mjs capabilities
node scripts/catalog-agent-client.mjs list
node scripts/catalog-agent-client.mjs show serum
```

L’URL doit être une origine HTTPS, sans chemin, identifiants, paramètres ou fragment. HTTP est accepté uniquement pour `localhost`, `127.0.0.1` et `[::1]`. Aucune destination par défaut ni configuration globale n’est utilisée. Ne pas placer la clé dans une variable `NEXT_PUBLIC_*`, un fichier versionné ou un plan partagé.

## Identité de création et stock initial

Le contrat de capacités est en version 2. `data.variants[].key` est une clé locale obligatoire lorsqu’une liste de variantes est fournie : 1–100 caractères ASCII alphanumériques, `_` ou `-`, unique dans la demande. Ce n’est ni un ID persistant ni un SKU. Les autres champs de variante (`options`, `sku`, `label`, `images`, `active`) sont validés par le schéma catalogue partagé ; `id` est interdit à la création.

`data.initialStock` accepte seulement `{ variantKey, qty }`. Chaque clé doit désigner exactement une variante explicite ; les clés inconnues ou répétées sont rejetées. Quantités entières de 0 à `Number.MAX_SAFE_INTEGER`, 100 entrées et 100 variantes maximum, jusqu’à trois axes d’options. Le service catalogue résout les clés par les options canoniques puis ouvre le stock exclusivement via l’inventaire, à l’emplacement `MAIN`, dans la transaction de création. Les variantes sans entrée démarrent à zéro.

Les aperçus et les reçus contiennent `variantIds: { [key]: serverVariantId }`. Les IDs/SKUs générés dans l’aperçu sont **provisoires** : seule la table du reçu appliqué fournit les identités persistantes. Les clés locales ne sont pas enregistrées dans les variantes. Un SKU peut être fourni à la création et devient ensuite immuable.

Exemple `operation.json` :

```json
{
  "command": "create",
  "requestId": "create-serum-001",
  "data": {
    "name": "Sérum",
    "slug": "serum",
    "category": "soins",
    "price": 199,
    "images": ["./photos/serum.png"],
    "optionDefinitions": [{ "name": "Contenance", "values": ["250 ml", "500 ml"] }],
    "variants": [
      { "key": "small", "options": [{ "name": "Contenance", "value": "250 ml" }] },
      { "key": "large", "options": [{ "name": "Contenance", "value": "500 ml" }] }
    ],
    "initialStock": [{ "variantKey": "small", "qty": 8 }, { "variantKey": "large", "qty": 4 }]
  }
}
```

Pour un produit sans options, fournir `variants: [{ "key": "standard", "options": [] }]` et éventuellement `initialStock: [{ "variantKey": "standard", "qty": 5 }]`. Sans liste de variantes ni stock initial, le catalogue génère la variante Standard, ou les combinaisons des `optionDefinitions` fournies. Les valeurs restent des chaînes, y compris `"36"`, `"XL"` et `"500 ml"`. Les champs optionnels `story`, `materials`, `badge`, `isBestSeller`, `upsellRef`, `landingEnabled` (activation de `/l/<slug>`) et `packs` (lots de quantité `[{ quantity, price, label, highlight }]`) sont également acceptés à la création et à la modification.

## Aperçu, application et reprise

```sh
node scripts/catalog-agent-client.mjs preview operation.json plan.json
# Examiner le résultat avant application.
node scripts/catalog-agent-client.mjs apply plan.json --yes
node scripts/catalog-agent-client.mjs receipt create-serum-001
```

L’aperçu exécute les vrais services dans une transaction annulée, sans changement catalogue, stock ou reçu. La signature HMAC lie la demande normalisée, la révision catalogue et une expiration de 30 minutes. Une modification concurrente du catalogue ou de sa disponibilité invalide l’aperçu : préparer et examiner un nouveau plan. Une rotation de la clé invalide aussi les aperçus en attente.

L’application vérifie la révision sous transaction SQLite immédiate, puis conserve atomiquement le produit et son reçu durable. Les reprises concurrentes de la même demande produisent une seule création et une seule ouverture par variante. Après une réponse perdue, réutiliser le même plan et `requestId` : le reçu est consulté avant tout nouveau téléversement, et un reçu identique est rejoué même si l’aperçu a expiré. Réutiliser un ID avec un autre contenu échoue (409). Conserver les reçus et la base lors des sauvegardes ; ne pas inventer un nouvel ID pour contourner une réponse incertaine.

Les plans (version 2) sont liés à l’origine CRM, sans clé secrète. Les anciens plans doivent être préparés à nouveau. Les photos sources sont copiées dans `plan.json.images/` et vérifiées par SHA-256 avant téléversement ; conserver ces fichiers jusqu’à l’application.

## Modification et archivage

```json
{
  "command": "edit",
  "requestId": "edit-serum-001",
  "target": "serum",
  "data": {
    "description": "Un soin quotidien.",
    "optionDefinitions": [{ "name": "Contenance", "values": ["300 ml", "500 ml"] }],
    "variants": [
      { "id": "<ID small du reçu>", "options": [{ "name": "Contenance", "value": "300 ml" }] },
      { "id": "<ID large du reçu>", "options": [{ "name": "Contenance", "value": "500 ml" }] }
    ]
  }
}
```

`target` accepte un ID produit ou un slug non ambigu. Une modification partielle suit le schéma admin ; une liste `variants` fournie est la sélection finale. Passer l’ID persistant lors d’un changement d’options ; sinon les options canoniques retrouvent les variantes existantes, même archivées. Les variantes omises deviennent inactives sans supprimer les références historiques. Les nouvelles variantes démarrent à zéro, celles réactivées conservent leur stock. Les snapshots des commandes/colis et l’attribution des retours restent attachés aux IDs d’origine. `key` et `initialStock` sont interdits en modification ; les réceptions et corrections passent par le CRM inventaire.

Archivage/restauration suivent le même cycle aperçu/application, avec par exemple `{ "command": "archive", "requestId": "archive-serum-001", "target": "serum" }` et `command: "restore"`. Aucune de ces actions n’ajuste le stock.

## Images et API directe

Le client prépare les galeries produit et variantes depuis des fichiers locaux ou des URL HTTPS. Les téléchargements externes n’emportent jamais la clé CRM et les redirections sont refusées. Le serveur ne récupère aucune URL externe : il accepte uniquement des chemins locaux `/api/media/*` ou `/images/*` validés.

`POST /api/catalog-agent/upload?dryRun=1` valide et convertit JPG/PNG/WebP (5 Mo maximum) en WebP, sans écrire de média. Après approbation, le client téléverse réellement les sources inchangées ; l’application vérifie l’existence des médias. Le stockage utilise des noms adressés par contenu et n’efface pas les photos retirées d’une galerie.

Toutes les requêtes API exigent le Bearer catalogue et répondent sans cache :

- `GET ?command=capabilities|list|show|receipt` (`target` pour show, `requestId` pour receipt).
- `POST { "action": "preview", "operation": { ... } }`.
- `POST { "action": "apply", "operation": { ... }, "preview": "<preuve signée>" }`.
- `POST /upload` avec `FormData.file`, éventuellement `?dryRun=1`.

## Vérification isolée

`npm run test:catalog-agent` utilise des DB/médias temporaires, des secrets éphémères et `DELIVERY_PROVIDER=mock`, avec les appels réseau réels bloqués. Les scénarios couvrent variantes Standard/non numériques/deux options, validation des clés et du stock, annulation des aperçus, révisions/signatures/expiration, reçus concurrents entre processus, images API/client, et conservation des identités après expédition et retour mock.
