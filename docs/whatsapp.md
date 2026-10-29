# Guide opérateur : Assistant WhatsApp et Evolution API

Ce document détaille l'architecture, le déploiement, la configuration et l'exploitation de l'intégration WhatsApp dans le CRM.

---

## 1. Vue d'ensemble (Overview)

L'assistant WhatsApp connecte chaque copie de boutique à son **propre numéro WhatsApp dédié** via une instance auto-hébergée d'**Evolution API v2** (moteur Baileys).

### Objectifs principaux
- **Notifications proactives** : informer automatiquement les clients des événements clés de commande et d'expédition (confirmation, création de colis avec suivi, livraison effectuée, tournée en cours, problème de livraison).
- **Assistance IA 24/7** : répondre aux messages textuels, notes vocales (transcrites par IA) et images des clients en Darija marocain (caractères latins ou arabes), arabe ou français, via des modèles économiques sur OpenRouter.
- **Contrôle humain permanent** : boîte de réception unifiée `/crm/whatsapp` permettant aux agents de reprendre la main à tout moment, réviser les propositions de l'IA et valider les modifications de commandes.
- **Alertes administrateur** : notification WhatsApp instantanée envoyée aux numéros administrateurs à chaque confirmation de commande.

### Principes de sécurité anti-bannissement (Safety First)
Les clients non officiels (Baileys) risquent le bannissement si le numéro adopte un comportement assimilé à du spam. Le système applique des règles strictes :
1. **Le client écrit en premier** : le bouton de la page `/merci` propose un lien `wa.me` pré-rempli avec la référence de la commande (formulations variées).
2. **Aucun message non sollicité** : aucun premier message n'est envoyé sans contact humain préalable (soit une commande confirmée par un agent, soit une relance après 2 appels sans réponse `no_answer` espacés d'au moins 2 h).
3. **Format texte brut** : uniquement des messages en texte simple, sans templates marketing WhatsApp Business.
4. **Cadencement et fenêtres d'envoi** : les messages initiés par la boutique respectent une fenêtre horaire configurable (par défaut 09:00–21:00 Africa/Casablanca), un plafond quotidien (par défaut 40 en phase de rodage), un délai aléatoire de 30 à 120 s entre envois, et l'affichage d'un statut "en train d'écrire" (*composing*). Les réponses de l'IA aux clients et les alertes admin sont exemptes de la fenêtre.
5. **Jamais de renvoi automatique après incertitude** : un envoi dont le statut réseau est incertain passe en `uncertain` et n'est jamais réémis automatiquement.
6. **Confidentialité par numéro** : une commande n'est dévoilée qu'au numéro de téléphone qui l'a passée. Un tiers fournissant la référence et les 4 derniers chiffres n'obtient que le statut et le suivi, sans adresse ni nom complet.
7. **Autonomie délimitée de l'IA** : l'IA ne peut en aucun cas créer, confirmer, annuler ou modifier le prix d'une commande. Elle rédige des brouillons et propositions que l'agent valide.
8. **Statuts transporteur isolés** : les correspondances de statuts bruts transporteur alimentent uniquement les notifications et ne modifient jamais les stocks.
9. **Système d'avertissements (strikes)** : détection des insultes, abus, spam ou tentatives d'injection avec avertissements gradués et blocage automatique optionnel.
10. **Inerte par défaut** : toutes les fonctionnalités à risque sont désactivées par défaut dans `/crm/parametres`. Un coupe-circuit général (*kill switch*) permet de stopper tous les flux sortants instantanément.

---

## 2. Hébergement sur Coolify (Hosting on Coolify - 4 cœurs / 8 Go)

L'architecture recommandée héberge Coolify, le CRM Next.js et la stack Evolution API sur un même serveur privé virtuel (VPS).

### Dimensionnement recommandé
- **VPS** : 4 cœurs vCPU / 8 Go de RAM.
- **Consommation mémoire stable** : environ 2 à 2,5 Go pour une boutique en production.
- **Pics de compilation** : les builds Next.js (`next build`) consomment ponctuellement 1,5 à 2 Go de RAM supplémentaire.

### Swap système (4 Go obligatoire)
Pour éviter que le mécanisme OOM (*Out Of Memory Killer*) du noyau Linux n'interrompe le CRM ou PostgreSQL pendant un build, configurez 4 Go de swap sur le serveur hôte :

```sh
# Création et activation du swapfile
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Persistance au redémarrage
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### Limites mémoire des conteneurs dans Coolify
Attribuez des plafonds de mémoire dans les réglages des ressources de chaque conteneur :
- **CRM Next.js** : 1 Go (1024 Mo)
- **Evolution API** : 768 Mo
- **PostgreSQL (base Evolution)** : 512 Mo
- **Redis (cache Evolution)** : 256 Mo

### Architecture multi-boutiques
Un unique serveur Evolution API v2 peut gérer plusieurs instances isolées (une instance distincte par boutique / niche), chacune connectée à son propre numéro WhatsApp.

---

## 3. Déploiement d'Evolution API v2 (Deploy Evolution API v2)

Déployez Evolution API v2 dans Coolify comme une ressource Docker Compose ou un service avec PostgreSQL et Redis sur un réseau Docker privé.

### Sécurité réseau
- **Réseau privé** : Evolution API ne doit être accessible que sur le réseau Docker interne partagé avec le conteneur CRM.
- **Port 8080** : ne pas exposer le port 8080 sur l'Internet public.
- **Evolution Manager UI** : le gestionnaire d'instances ne doit être accessible que derrière un mot de passe administrateur fort, utilisé uniquement lors du scan initial du QR code.

### Exemple de variables d'environnement Evolution Compose
Adaptez les clés selon la documentation de votre version d'Evolution API v2 :

```env
# Clé secrète globale d'authentification à l'API Evolution
AUTHENTICATION_API_KEY=<SECRET_GLOBAL_EVOLUTION_CLE_ALEATOIRE>

# Base de données PostgreSQL dédiée
DATABASE_PROVIDER=postgresql
DATABASE_CONNECTION_URI=postgresql://postgres:<MOT_DE_PASSE_POSTGRES>@postgres:5432/evolution?schema=public

# Cache Redis
CACHE_REDIS_ENABLED=true
CACHE_REDIS_URI=redis://redis:6379/1

# Configuration du serveur
SERVER_PORT=8080
SERVER_URL=http://evolution:8080
LOG_LEVEL=ERROR,WARN
```

---

## 4. Instance et Webhook (Instance and Webhook)

### Création et association de l'instance
1. Dans le Manager Evolution (ou par appel API avec `AUTHENTICATION_API_KEY`), créez une instance portant le nom du slug de la boutique (ex. `matelas-confort`).
2. Ouvrez WhatsApp sur le smartphone dédié à la boutique.
3. Allez dans **Appareils connectés** > **Connecter un appareil**, puis scannez le QR code généré par l'instance Evolution.

### Configuration du Webhook
Configurez le webhook de l'instance dans Evolution :
- **URL du Webhook** : `https://<domaine-crm>/api/whatsapp/webhook/<WHATSAPP_WEBHOOK_SECRET>`
- **En-tête personnalisé (*Header*)** : `x-webhook-secret: <WHATSAPP_WEBHOOK_SECRET>`
- **Événements souscrits** : exactement deux événements :
  - `MESSAGES_UPSERT` (réception de nouveaux messages entrants et mises à jour)
  - `CONNECTION_UPDATE` (état de connexion / déconnexion de l'appareil)
- **Webhook by Events** : désactivé (`false` / OFF) pour recevoir les flux sur l'URL unique.
- **Base64** : désactivé (`false` / OFF). Le CRM télécharge les médias à la demande pour éviter d'alourdir les payloads HTTP.

---

## 5. Variables d'environnement CRM (CRM Env Vars)

Configurez les variables suivantes dans l'environnement de production du CRM (`.env` ou interface Coolify) :

| Variable | Description | Exemple / Valeur |
|---|---|---|
| `EVOLUTION_BASE_URL` | URL privée d'Evolution API sur le réseau Docker. HTTPS obligatoire sauf sur hôte loopback ou nom d'hôte privé. | `http://evolution:8080` |
| `EVOLUTION_INSTANCE` | Nom de l'instance créée dans Evolution (slug boutique). | `ma-boutique` |
| `EVOLUTION_API_KEY` | Clé d'API globale ou de l'instance pour authentifier les appels sortants. | `sec_evo_...` |
| `WHATSAPP_WEBHOOK_SECRET` | Secret aléatoire fort (≥ 32 caractères) présent dans l'URL et l'en-tête de validation. | `whsec_...` |
| `OPENROUTER_API_KEY` | Clé d'API OpenRouter (réutilise la variable existante de l'assistant CRM). | `sk-or-...` |
| `WHATSAPP_CHAT_MODEL` | Modèle OpenRouter pour conversation, outils et détection d'abus. | `z-ai/glm-5.3-flash` |
| `WHATSAPP_CHAT_FALLBACK_MODEL` | Modèle de repli en cas d'indisponibilité du modèle principal. | `deepseek/deepseek-v4.1-flash` |
| `WHATSAPP_AUDIO_MODEL` | Modèle OpenRouter pour la transcription vocale en Darija / arabe. | `google/gemini-2.5-flash-lite` |
| `WHATSAPP_AUDIO_FALLBACK_MODEL` | Modèle de repli pour la transcription vocale. | `qwen/qwen3.8-omni-flash` |

---

## 6. Préchauffage du numéro (Number Warm-up)

Le respect de la phase de rodage est **essentiel** pour pérenniser le numéro et éviter les blocages par les algorithmes de Meta.

### Règles d'or
1. **Carte SIM dédiée** : utilisez toujours une nouvelle carte SIM dédiée à la boutique. Ne jamais utiliser le numéro personnel d'un associé ou le numéro historique d'un service commercial non rodé.
2. **Phase manuelle (2 semaines)** : pendant les 14 premiers jours, utilisez le numéro manuellement sur un smartphone physique pour des échanges normaux avec des contacts réels (amis, collègues, fournisseurs).
3. **Plafond quotidien progressif** :
   - Semaines 1 et 2 d'automatisation : laisser `daily_outbound_cap = 40`.
   - Semaine 3 : augmenter à 60 messages / jour si aucun signalement n'a eu lieu.
   - Semaine 4 : augmenter à 100 messages / jour.
   - Régime de croisière : 150 à 200 messages / jour.
4. **Pourquoi les numéros sont bannis** : WhatsApp bannit principalement sur signalement utilisateur (*Report* / *Signaler comme spam*) et lors d'envois massifs de messages identiques à des contacts froids. Laisser le client initier l'échange et varier les formulations protège la réputation du numéro.

---

## 7. Activation progressive des fonctionnalités (Turning Features On)

Ne jamais activer l'ensemble des modules d'un coup. Procédez par étapes dans `/crm/parametres` :

1. **Activation générale (`enabled`)** : active le sous-système une fois l'instance Evolution connectée et le webhook vérifié.
2. **Notifications client (`notifications_enabled`)** : active les messages de commande confirmée, expédiée avec numéro de suivi, et livrée.
3. **Assistant IA (`ai_enabled`)** : active les réponses automatiques 24/7 pour les questions avant-vente, le statut des commandes et la FAQ.
4. **Blocage automatique (`auto_block_enabled`)** : active le blocage automatique des clients atteignant le seuil de strikes (laisser désactivé au départ pour observer les faux positifs).
5. **Recommandations catalogue (`catalog_enabled`)** : permet à l'IA de proposer des liens et variantes du catalogue disponibles en stock.
6. **Propositions de modifications (`edit_proposals_enabled`)** : permet à l'IA de préparer des brouillons d'adresse ou d'articles pour validation par un agent.

### Coupe-circuit général (Kill Switch)
En cas de comportement imprévu (boucle de messages, bug d'un modèle IA, avertissement de WhatsApp) :
- Désactivez le toggle principal dans `/crm/parametres` ou le bouton d'urgence.
- **Effet immédiat** : tout envoi sortant et tout appel IA est suspendu dès le prochain tick du worker (moins de 15 s). Les messages entrants restent enregistrés dans la boîte de réception sans réponse automatique.

---

## 8. Coûts et plafonds budgétaires (Costs & Budget Cap)

L'utilisation de modèles économiques de pointe sur OpenRouter permet de maintenir les coûts d'IA sous 12 $ par mois pour un volume de 50 à 200 commandes par jour.

### Grille des modèles (relevée au 2026-10-29)

| Rôle | Modèle principal | Repli (*Fallback*) | Coût indicatif par million de tokens |
|---|---|---|---|
| **Chat + Outils + Détection d'abus** | `z-ai/glm-5.3-flash` | `deepseek/deepseek-v4.1-flash` | ~0,046 $ (entrée) / ~0,074 $ (sortie) |
| **Transcription audio (notes vocales)** | `google/gemini-2.5-flash-lite` | `qwen/qwen3.8-omni-flash` | Coût audio minimal par minute |
| **Vision (analyse photos produits)** | `z-ai/glm-5.3-flash` | Inclus dans le modèle de chat | Inclus dans le tarif vision standard |

### Optimisations et garde-fous
- **Confidentialité OpenRouter** : chaque requête envoie l'en-tête `provider.data_collection: "deny"`.
- **Cache SHA-256 des transcriptions** : une note vocale transférée ou réémise avec le même contenu n'est transcrite qu'une seule fois.
- **Plafond budgétaire quotidien (*Daily AI Budget Cap*)** : configurable dans `/crm/parametres` (ex. 1,00 $ / jour). Dès que le seuil est atteint, l'IA se met en pause et les conversations sont signalées aux agents dans la boîte de réception CRM.

---

## 9. Sauvegardes et restauration (Backups)

### Données CRM et WhatsApp
Le script de sauvegarde SQLite standard (`npm run backup` ou `scripts/backup-db.mjs`) capture l'intégralité des tables WhatsApp :
- `wa_conversations` (historique et fils de discussion)
- `wa_messages` (messages entrants, sortants et métadonnées)
- `wa_outbox` (file d'attente d'expédition)
- `wa_events` (événements bruts webhook)
- `wa_strikes` (registre des avertissements et motifs)
- `whatsapp_settings` (configuration stockée dans `app_state`)

### Base PostgreSQL d'Evolution API
Ajoutez la base PostgreSQL d'Evolution aux sauvegardes quotidiennes automatiques de Coolify avec export distant chiffré.

### Tolérance aux pannes
En cas de perte complète du conteneur ou de la base d'Evolution API :
- **Aucune perte opérationnelle côté CRM** : l'historique des discussions, les transcriptions et les commandes restent intacts dans SQLite.
- **Restauration rapide** : il suffit de recréer l'instance Evolution et de scanner à nouveau le QR code depuis le smartphone.

---

## 10. Confidentialité et rétention (Privacy & Retention)

1. **Consentement client** : le storefront affiche une mention informative lors de la commande et sur la page `/merci` précisant l'utilisation de WhatsApp pour le suivi du colis.
2. **Rétention des médias à 90 jours** : les notes vocales et photos téléchargées dans `data/uploads/wa/` sont automatiquement purgées après 90 jours. Les transcriptions textuelles sont conservées pour le service client.
3. **Zéro PII et corps de messages dans les logs** : les logs applicatifs (`LOG_FORMAT=json`) ne contiennent ni numéros de téléphone ni contenus de messages. Seuls les identifiants techniques opaques et références anonymisées sont enregistrés.
4. **Vérification d'identité stricte** : l'accès aux détails complets d'une commande requiert l'identité exacte du numéro appelant.

---

## 11. Dépannage (Troubleshooting)

### Le numéro est déconnecté (*CONNECTION_UPDATE*)
- **Symptôme** : un bandeau d'alerte apparaît en haut du CRM indiquant "WhatsApp déconnecté".
- **Action** : ouvrez le Manager Evolution API, vérifiez que le smartphone est allumé et connecté à Internet, puis rescannez le QR code si la session a expiré.

### Messages sortants incertains (`uncertain`)
- **Symptôme** : des lignes apparaissent avec le statut `uncertain` dans la file sortante de l'inbox.
- **Cause** : timeout HTTP lors de l'appel à Evolution ou micro-coupure réseau.
- **Action** : ne jamais forcer un réenvoi aveugle. L'agent vérifie sur le téléphone physique si le message est parti. Dans l'inbox CRM, l'agent clique sur « Marquer comme envoyé » ou « Annuler ».

### Plafond budgétaire IA atteint
- **Symptôme** : l'IA ne répond plus automatiquement et un badge signale le dépassement de budget.
- **Action** : les agents répondent manuellement depuis l'inbox `/crm/whatsapp`. Si nécessaire, augmentez temporairement le plafond quotidien dans `/crm/parametres`.

### Faux positif sur un blocage client
- **Symptôme** : un client légitime est bloqué suite à une mauvaise interprétation d'un message.
- **Action** : un agent ou administrateur peut inspecter l'historique des strikes dans la fiche conversation et cliquer sur « Débloquer le numéro » en un clic.
