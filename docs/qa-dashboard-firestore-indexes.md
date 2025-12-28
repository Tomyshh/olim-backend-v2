# Index Firestore requis pour le QA Dashboard

## Collection: ChatCC

### Index composite requis pour les requêtes avec filtres de date

Le QA Dashboard effectue des requêtes sur la collection `ChatCC` avec les filtres suivants :
- `satisfaction_score > 0` (obligatoire)
- `evaluation_date >= start` (optionnel selon période)
- `evaluation_date < end` (optionnel pour period=custom)

**Index composite requis :**

```
Collection: ChatCC
Fields:
  - satisfaction_score (Ascending)
  - evaluation_date (Ascending)
```

**Création via Firebase Console :**
1. Aller dans Firestore Database > Indexes
2. Cliquer sur "Create Index"
3. Collection ID: `ChatCC`
4. Fields:
   - `satisfaction_score` - Ascending
   - `evaluation_date` - Ascending
5. Cliquer sur "Create"

**Création via Firebase CLI (firestore.indexes.json) :**

```json
{
  "indexes": [
    {
      "collectionGroup": "ChatCC",
      "queryScope": "COLLECTION",
      "fields": [
        {
          "fieldPath": "satisfaction_score",
          "order": "ASCENDING"
        },
        {
          "fieldPath": "evaluation_date",
          "order": "ASCENDING"
        }
      ]
    }
  ]
}
```

Puis exécuter : `firebase deploy --only firestore:indexes`

## Sous-collection: ChatCC/{chatId}/messages

### Index requis pour l'ordre chronologique des messages

Les messages sont récupérés avec un `orderBy('timestamp', 'asc')`.

**Index simple requis :**

```
Collection: ChatCC/{chatId}/messages
Fields:
  - timestamp (Ascending)
```

**Note :** Cet index est généralement créé automatiquement par Firestore lors de la première requête, mais peut être créé manuellement si nécessaire.

## Vérification

Pour vérifier que les index sont bien créés :
1. Firebase Console > Firestore Database > Indexes
2. Vérifier que les index ci-dessus sont listés avec le statut "Enabled"

## Erreurs courantes

Si vous obtenez une erreur du type :
```
The query requires an index. You can create it here: [URL]
```

1. Cliquer sur le lien fourni dans l'erreur
2. Ou créer manuellement l'index via la console Firebase
3. Attendre que l'index soit construit (peut prendre quelques minutes)

