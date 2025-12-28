# Swagger / OpenAPI (OLIM Backend)

Ce dépôt contient une spécification **OpenAPI 3.0** dans le fichier `openapi.yaml`.

## Comment ouvrir le Swagger

- **Swagger Editor (recommandé)** :
  - Ouvre Swagger Editor puis importe le fichier `openapi.yaml`.
- **Postman / Insomnia** :
  - Import “OpenAPI” → sélectionne `openapi.yaml`.

## Base URL

- En local (par défaut dans la spec) : `http://localhost:3000`
- Les routes API sont sous le préfixe : `/api/*`
- Il existe aussi un health-check racine : `GET /health`

## Authentification (Firebase ID Token)

La majorité des routes utilisent le middleware `authenticateToken` et attendent :

- Header: `Authorization: Bearer <FIREBASE_ID_TOKEN>`

Si le header est absent ou invalide, l’API renvoie généralement :

- `401` avec `{ "error": "Missing or invalid authorization header" }`
- ou `{ "error": "Invalid or expired token" }`

Certaines routes sont en **auth optionnelle** (`optionalAuth`). Dans la spec, cela signifie :

- soit tu envoies un Bearer token
- soit tu n’en envoies pas

⚠️ Attention : par exemple `POST /api/notifications/token` passe par `optionalAuth`, mais **le contrôleur renvoie quand même `401`** si aucun `uid` n’a été extrait.

## Pagination & filtres (patterns du backend)

Le backend utilise surtout :

- `limit` (query) : nombre max d’items retournés (souvent 50/100 par défaut)
- `status` (query) : filtre de statut (selon la collection)
- `unreadOnly=true` (query) : filtre notifications non lues

Exemples :

- `GET /api/requests?status=pending&limit=20`
- `GET /api/notifications?unreadOnly=true&limit=50`

## Formats des réponses d’erreur

Deux formats principaux existent :

- **Erreur standard** : `{ "error": "<message>" }`
- **Routes stubées** (non implémentées) : `{ "message": "Not implemented - ...", "note": "..." }` avec code HTTP `501`

## Routes “stubées” (501)

Certaines routes sont présentes mais volontairement non implémentées (sécurité / dépendances externes) :

- OTP auth (Vonage) : `/api/auth/*` (plusieurs endpoints)
- Upload fichiers : chat / documents / request files
- Admin : sync supabase, génération token FCM OAuth

Ces routes renvoient `501` et sont marquées comme telles dans `openapi.yaml`.

## Exemples curl

### Health

```bash
curl -s http://localhost:3000/health
```

### Profil (auth)

```bash
curl -s \
  -H "Authorization: Bearer $FIREBASE_ID_TOKEN" \
  http://localhost:3000/api/profile
```

### Créer une demande

```bash
curl -s -X POST \
  -H "Authorization: Bearer $FIREBASE_ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"requestType":"conciergerie","category":"travel","description":"Besoin d’aide pour...","priority":"normal"}' \
  http://localhost:3000/api/requests
```


