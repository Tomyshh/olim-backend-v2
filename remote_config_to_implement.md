# Contrat Backend — Admin Remote Config (pour la page **Config**)

Ce document décrit **exactement** ce que le front attend pour lire/écrire les valeurs Remote Config depuis votre backend (au lieu des Cloud Functions callable).

## Objectif

- **Lecture** des paramètres Remote Config (prix + provider d'auth) depuis le serveur via **Firebase Admin SDK**.
- **Écriture** (publish) des paramètres Remote Config depuis le serveur via **Firebase Admin SDK**.
- Le front envoie un **Firebase ID token** (Bearer) et le backend contrôle l'accès via Firestore.

## Authentification & Autorisation

- **Header requis**: `Authorization: Bearer <FIREBASE_ID_TOKEN>`
- **Vérification**: `admin.auth().verifyIdToken(token)`
- **Contrôle admin (routes admin)**:
  - Lire `Conseillers2/{uid}` dans Firestore
  - `isAdmin === true` requis

## Clés Remote Config autorisées

Ces clés doivent être **exactement** celles-ci:

- `pack_start_mensually`
- `pack_essential_mensually`
- `pack_vip_mensually`
- `pack_elite_mensually`
- `pack_start_annually`
- `pack_essential_annually`
- `pack_vip_annually`
- `pack_elite_annually`
- `auth_provider_default` (valeurs: `"mail"` | `"phone"`)
- `add_family_member_ponctually`
- `add_family_member_mensually`

## Route 1 — GET (lecture)

- **Méthode**: `GET`
- **URL**: `/api/admin/remote-config`
- **Auth**: admin requis (`Conseillers2/{uid}.isAdmin == true`)

### Réponse (200)

```json
{
  "success": true,
  "etag": "....",
  "parameters": {
    "pack_start_mensually": "148",
    "pack_essential_mensually": "249",
    "pack_vip_mensually": "399",
    "pack_elite_mensually": "990",
    "pack_start_annually": "1620",
    "pack_essential_annually": "2160",
    "pack_vip_annually": "4320",
    "pack_elite_annually": "9990",
    "auth_provider_default": "mail",
    "add_family_member_ponctually": "0",
    "add_family_member_mensually": "0"
  }
}
```

### Erreurs

- `401` si pas de token / token invalide
- `403` si pas admin
- `500` si Remote Config non accessible

## Route 2 — PUT (publish)

- **Méthode**: `PUT`
- **URL**: `/api/admin/remote-config`
- **Auth**: admin requis (`Conseillers2/{uid}.isAdmin == true`)
- **Body JSON requis**: `{ "parameters": { ... } }`

### Payload attendu

```json
{
  "parameters": {
    "pack_start_mensually": "148",
    "pack_essential_mensually": "249",
    "pack_vip_mensually": "399",
    "pack_elite_mensually": "990",
    "pack_start_annually": "1620",
    "pack_essential_annually": "2160",
    "pack_vip_annually": "4320",
    "pack_elite_annually": "9990",
    "auth_provider_default": "mail",
    "add_family_member_ponctually": "0",
    "add_family_member_mensually": "0"
  }
}
```

### Validation requise (comme les anciennes Cloud Functions)

- Toutes les clés doivent appartenir à la liste “autorisée”.
- Chaque valeur doit être une **string non vide**.
- `auth_provider_default`: uniquement `"mail"` ou `"phone"`.
- Autres clés: **entier >= 0**, string stricte (ex: `"249"`, pas `"249.0"`).

### Logique Firebase Admin SDK (publish)

- `const template = await admin.remoteConfig().getTemplate()`
- Pour chaque clé publiée:
  - `template.parameters[key] = { ...currentParam, defaultValue: { value } }`
- `const published = await admin.remoteConfig().publishTemplate(template)`

### Réponse (200)

```json
{
  "success": true,
  "updatedKeys": ["pack_start_mensually", "auth_provider_default"],
  "etag": "...."
}
```

### Erreurs

- `400` payload invalide (clé non autorisée / valeur vide / type incorrect)
- `401` token manquant/invalide
- `403` pas admin
- `500` publish impossible

## CORS (important pour Flutter Web)

Le backend doit autoriser:

- **Origines**: votre domaine Web (`*.web.app`, `*.firebaseapp.com`, etc.)
- **Headers**: `Authorization`, `Content-Type`, `Accept`
- **Méthodes**: `GET, PUT, OPTIONS`

## Notes d'intégration front

Le front appelle:

- `GET /api/admin/remote-config` pour remplir les champs au chargement.
- `PUT /api/admin/remote-config` quand on clique sur “Sauvegarder”.

Base URL côté app: `lib/utils/app_constants.dart` (`AppConstants.backendBaseUrl`).


