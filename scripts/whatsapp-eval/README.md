# Banc d'évaluation WhatsApp Darija

Banc d'évaluation hors-ligne par défaut et à activation explicite (**opt-in**) pour comparer les modèles OpenRouter sur des messages réalistes en Darija marocaine (lettres latines et écriture arabe), en français et en arabe standard.

## Objectif

Les modèles économiques traitent la darija marocaine de façon inégale, en particulier en lettres latines (« arabizi ») et dans les notes vocales. Avant le lancement en production, ce banc permet au propriétaire de comparer les réponses des modèles candidats côte à côte sur une trentaine de cas concrets et de choisir le modèle le plus adapté en lisant les réponses.

## Sécurité et politique réseau

- **Hors-ligne par défaut** : Ce script ne fait **aucun appel réseau** lorsqu'il est exécuté sans configuration explicite.
- **Vérification d'autorisation** : Le script refuse de s'exécuter si `WHATSAPP_EVAL_LIVE=1` et `OPENROUTER_API_KEY` ne sont pas définis dans l'environnement, et exige le drapeau `--yes`.
- **Exclusion CI et test** : Ce banc n'est jamais exécuté dans `npm test` ni dans les pipelines de CI.
- **Protection des clés et données** : Les clés d'API ne sont jamais affichées dans la console ni dans les rapports générés.
- **Isolation totale** : Chaque modèle s'exécute contre une base SQLite temporaire vierge avec des migrations appliquées et un catalogue de test. Les répertoires temporaires sont toujours nettoyés à la fin de l'exécution.

## Utilisation

### 1. Exécution par défaut

```bash
WHATSAPP_EVAL_LIVE=1 OPENROUTER_API_KEY="sk-or-v1-..." npm run eval:whatsapp -- --yes
```

Par défaut, le banc évalue :
- **Modèles Chat** : `z-ai/glm-5.3-flash`, `deepseek/deepseek-v4.1-flash`, `qwen/qwen3.7-flash`
- **Modèles Audio** : `google/gemini-2.5-flash-lite`, `qwen/qwen3.8-omni-flash`
- **Cas textuels** : Les ~30 cas définis dans `cases.json`

### 2. Personnalisation des modèles

Pour comparer d'autres modèles OpenRouter :

```bash
WHATSAPP_EVAL_LIVE=1 OPENROUTER_API_KEY="sk-or-v1-..." npm run eval:whatsapp -- --yes \
  --chat-models="z-ai/glm-5.3-flash,deepseek/deepseek-v4.1-flash" \
  --audio-models="google/gemini-2.5-flash-lite"
```

### 3. Filtrer sur des cas spécifiques

Pour cibler un ou plusieurs cas précis (identifiants définis dans `cases.json`) :

```bash
WHATSAPP_EVAL_LIVE=1 OPENROUTER_API_KEY="sk-or-v1-..." npm run eval:whatsapp -- --yes \
  --cases="status-darija-latin,bot-honesty-latin,prompt-injection-french"
```

## Évaluation vocale (Audio)

Pour tester la compréhension vocale en darija :
1. Enregistrez environ 5 messages vocaux courts (ex. "fin wsal colis dyali", "wach kayn livraison l Agadir", "bghit nbdel l'adresse").
2. Placez les fichiers audio (`.ogg`, `.mp3`, ou `.m4a`) dans le dossier `scripts/whatsapp-eval/audio/`.
3. Relancez l'évaluation avec `--yes`.

> **Note importante** : Le dossier `scripts/whatsapp-eval/audio/` est ignoré par Git (à l'exception de `.gitkeep`). Les enregistrements audio réels ne sont jamais commités dans le dépôt.

## Rapports générés

Chaque exécution génère un rapport Markdown horodaté dans :
`scripts/whatsapp-eval/reports/<timestamp>.md`

Ce dossier est également ignoré par Git. Le rapport contient :
- **Tableau résumé** : latence médiane et coût total par modèle.
- **Cas par cas** : pour chaque message client, un tableau comparatif avec les réponses verbatim des modèles, les outils CRM appelés, l'état de transfert à un humain (`handoff`), le temps de réponse et le coût en micro-USD (µ$).
- **Checklist de validation humaine** : au-dessus de chaque tableau, une liste de critères (`[ ] status`, `[ ] no_price_invented`, `[ ] handoff`, etc.) que l'évaluateur humain peut cocher pour noter la pertinence du modèle.
