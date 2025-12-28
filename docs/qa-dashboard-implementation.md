# Implémentation QA Dashboard - Résumé

## ✅ Fonctionnalités implémentées

### 1. Endpoint GET /api/qa/stats

**Route :** `GET /api/qa/stats`

**Authentification :** Requise (Bearer token)

**Query Parameters :**
- `period` (optionnel, défaut: `all`) : `all` | `week` | `month` | `custom`
- `start` (requis si `period=custom`) : Date ISO8601
- `end` (requis si `period=custom`) : Date ISO8601

**Exemples :**
```
GET /api/qa/stats?period=all
GET /api/qa/stats?period=week
GET /api/qa/stats?period=month
GET /api/qa/stats?period=custom&start=2024-01-01T00:00:00Z&end=2024-01-31T23:59:59Z
```

### 2. Requête Firestore

**Collection :** `ChatCC`

**Filtres appliqués :**
- `satisfaction_score > 0` (obligatoire - seulement les chats évalués)
- `evaluation_date >= start` (si période spécifiée)
- `evaluation_date < end` (si period=custom avec end)

**Champs lus :**
- `satisfaction_score` (number, obligatoire)
- `counselorId` (string, obligatoire)
- `counselorName` (string, optionnel, fallback: "Inconnu")
- `evaluation_date` (Timestamp, optionnel)
- `evaluation_feedback` (string, optionnel)
- `evaluation_strengths` (string, optionnel)
- `evaluation_improvements` (string, optionnel)

### 3. Récupération des messages

Pour chaque chat évalué, les messages sont récupérés depuis :
- `ChatCC/{chatId}/messages`

**Ordre :** Chronologique (`orderBy('timestamp', 'asc')`)

**Champs lus :**
- `content` (string, fallback: "")
- `senderId` (string, fallback: "")
- `senderName` (string, fallback: "")
- `timestamp` (Timestamp, optionnel)
- `type` (string, fallback: "text")

### 4. Agrégation par conseiller

Pour chaque conseiller (`counselorId`), les statistiques suivantes sont calculées :

- **totalChats** : Nombre total de chats évalués
- **averageScore** : Score moyen (arrondi à 2 décimales)
- **excellentCount** : Nombre de chats avec score 90-100
- **goodCount** : Nombre de chats avec score 80-89
- **averageCount** : Nombre de chats avec score 70-79
- **poorCount** : Nombre de chats avec score < 70
- **commonImprovements** : Top 5 des axes d'amélioration
- **commonStrengths** : Top 5 des points forts
- **lastEvaluationDate** : Date de la dernière évaluation (ISO8601)
- **chatEvaluations** : Détails de chaque chat avec messages

### 5. Format de réponse JSON

```json
{
  "counselors": [
    {
      "counselorId": "abc123xyz",
      "counselorName": "Jean Dupont",
      "totalChats": 15,
      "averageScore": 87.5,
      "excellentCount": 5,
      "goodCount": 7,
      "averageCount": 2,
      "poorCount": 1,
      "commonImprovements": ["Vérifier l'orthographe", "Répondre plus vite"],
      "commonStrengths": ["Empathie", "Clarté"],
      "lastEvaluationDate": "2024-01-15T14:30:00.000Z",
      "chatEvaluations": [
        {
          "chatId": "chat123",
          "score": 85,
          "feedback": "Conversation professionnelle",
          "strengths": "Réactivité, empathie",
          "improvements": "Vérifier l'orthographe",
          "evaluationDate": "2024-01-15T14:30:00.000Z",
          "messages": [
            {
              "content": "Bonjour",
              "senderId": "client456",
              "senderName": "Marie Martin",
              "timestamp": "2024-01-15T14:25:00.000Z",
              "type": "text"
            }
          ]
        }
      ]
    }
  ]
}
```

### 6. Cache Redis

**Clé de cache :**
- Format : `olimcrm:qa:stats:v1:period=<period>:start=<start>:end=<end>`
- Exemples :
  - `olimcrm:qa:stats:v1:period=all`
  - `olimcrm:qa:stats:v1:period=week`
  - `olimcrm:qa:stats:v1:period=month`
  - `olimcrm:qa:stats:v1:period=custom:start=2024-01-01T00:00:00Z:end=2024-01-31T23:59:59Z`

**TTL :** 60-120 secondes (configurable via `QA_REDIS_TTL_SECONDS`, défaut: 90s)

**Anti-stampede :** Lock Redis pour éviter les calculs simultanés (TTL: 15s)

**Headers de réponse :**
- `X-Cache: HIT` - Données depuis le cache
- `X-Cache: WAIT_HIT` - Attente puis cache hit
- `X-Cache: MISS` - Calcul effectué, cache mis à jour
- `X-Cache: MISS_NOLOCK` - Calcul effectué sans lock (concurrent)
- `X-Cache: BYPASS` - Redis non disponible

## 📋 Checklist de validation

- [x] Requête ChatCC avec filtre `satisfaction_score > 0`
- [x] Filtres période (week, month, custom) appliqués sur `evaluation_date`
- [x] Regroupement par `counselorId`
- [x] Calcul des stats (excellent/good/average/poor) par conseiller
- [x] Récupération des messages depuis `ChatCC/{chatId}/messages`
- [x] Conversion des Timestamp Firestore en ISO8601 pour les dates
- [x] Cache Redis avec clé déterministe et TTL 60-120s
- [x] Format JSON conforme à la structure attendue par Flutter
- [x] Gestion des erreurs et validation des paramètres
- [x] Anti-stampede avec lock Redis

## 🔧 Configuration

**Variables d'environnement :**
- `QA_REDIS_TTL_SECONDS` : TTL du cache Redis en secondes (défaut: 90)
- `QA_REDIS_LOCK_TTL_SECONDS` : TTL du lock anti-stampede en secondes (défaut: 15)
- `REDIS_URL` : URL de connexion Redis (requis pour le cache)

## ⚠️ Prérequis Firestore

**Index composite requis :**
- Collection: `ChatCC`
- Fields: `satisfaction_score` (Ascending), `evaluation_date` (Ascending)

Voir `docs/qa-dashboard-firestore-indexes.md` pour les détails.

## 🚀 Tests recommandés

1. **Test period=all** : Vérifier que tous les chats évalués sont retournés
2. **Test period=week** : Vérifier que seuls les chats des 7 derniers jours sont retournés
3. **Test period=month** : Vérifier que seuls les chats des 30 derniers jours sont retournés
4. **Test period=custom** : Vérifier avec des dates spécifiques
5. **Test cache** : Vérifier que le cache fonctionne (header X-Cache)
6. **Test messages** : Vérifier que les messages sont bien récupérés pour chaque chat
7. **Test agrégation** : Vérifier que les stats sont correctement calculées par conseiller

