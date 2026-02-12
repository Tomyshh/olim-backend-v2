# Contrat Backend — Brouillons de demandes (Request Drafts)

## Vue d'ensemble

Le frontend sauvegarde automatiquement un **brouillon** à chaque étape de
création de demande (manuelle, vocale, inscription logement). Ces brouillons
sont stockés côté backend et accessibles sur tout appareil connecté au même
compte.

**Authentification** : toutes les requêtes incluent un Bearer token Firebase
(`Authorization: Bearer <idToken>`). Le backend en extrait l'`uid`.

---

## Endpoints

### 1. Créer un brouillon

```
POST /v1/request-drafts
```

**Body (JSON)** :

```json
{
  "id": "draft_1707753600000_12345",
  "type": "manual_conversational",
  "title": "Changement adresse Teoudat Zehut",
  "category": "Logement",
  "subcategory": "Changer adresse Teoudat Zehut",
  "progress": 0.25,
  "current_step": "Adresses",
  "snapshot_json": { ... },
  "uploaded_urls": ["https://storage.../doc1.pdf"],
  "created_at": "2026-02-12T14:30:00.000Z",
  "updated_at": "2026-02-12T14:30:00.000Z"
}
```

**Réponse (201)** :

```json
{
  "id": "uuid-generated-by-backend",
  "draftId": "uuid-generated-by-backend"
}
```

> Le backend **génère un ID** et le renvoie. Le frontend remplace son ID
> temporaire par celui du backend.

---

### 2. Lister les brouillons

```
GET /v1/request-drafts
```

**Réponse (200)** :

```json
{
  "drafts": [
    {
      "id": "uuid-1",
      "type": "voice_stepflow",
      "title": "Inscription Arnona",
      "category": "Logement",
      "subcategory": "Inscription / Désinscription logement",
      "progress": 0.5,
      "current_step": "Documents",
      "snapshot_json": { ... },
      "uploaded_urls": ["https://..."],
      "created_at": "2026-02-12T14:30:00.000Z",
      "updated_at": "2026-02-12T14:35:00.000Z"
    }
  ]
}
```

> Triés par `updated_at` DESC.

---

### 3. Mettre à jour un brouillon

```
PATCH /v1/request-drafts/{draftId}
```

**Body (JSON)** : même structure que le POST. Le backend met à jour les
champs fournis (merge partiel ou remplacement total, au choix).

**Réponse (200)** :

```json
{
  "success": true
}
```

---

### 4. Supprimer un brouillon

```
DELETE /v1/request-drafts/{draftId}
```

**Réponse (200)** :

```json
{
  "success": true
}
```

---

### 5. Finaliser un brouillon (optionnel)

```
POST /v1/request-drafts/{draftId}/finalize
```

Transforme le brouillon en vraie(s) demande(s) côté backend.

- Pour `manual_conversational` et `voice_stepflow` : crée 1 demande.
- Pour `housing_inscription` : crée N demandes (une par service coché dans
  `snapshot_json.selectedServices`).

> **Note** : actuellement le frontend crée les demandes lui-même via
> `POST /v1/requests`. Ce endpoint est prévu pour une future optimisation
> backend. En attendant, le frontend supprime simplement le brouillon après
> envoi réussi.

**Réponse (200)** :

```json
{
  "success": true,
  "requestIds": ["req-1", "req-2"]
}
```

---

## Schéma DB recommandé

### Table `request_drafts`

| Colonne          | Type         | Notes                           |
|------------------|--------------|---------------------------------|
| `id`             | UUID (PK)    | Généré par le backend           |
| `uid`            | VARCHAR(128) | UID Firebase de l'utilisateur   |
| `type`           | VARCHAR(50)  | `manual_conversational`, `voice_stepflow`, `housing_inscription` |
| `title`          | VARCHAR(255) | Titre affiché                   |
| `category`       | VARCHAR(255) | Catégorie de la demande         |
| `subcategory`    | VARCHAR(255) | Sous-catégorie                  |
| `progress`       | FLOAT        | 0.0 à 1.0                      |
| `current_step`   | VARCHAR(100) | Label de l'étape en cours       |
| `snapshot_json`  | JSONB        | Données complètes du formulaire |
| `uploaded_urls`  | TEXT[]       | URLs des documents pré-uploadés |
| `created_at`     | TIMESTAMPTZ  | Date de création                |
| `updated_at`     | TIMESTAMPTZ  | Dernière mise à jour            |

**Index** : `uid` (fréquent pour le listing)

### Alternative Firestore

```
clients/{uid}/drafts/{draftId}
```

Même structure de document.

---

## Types de brouillons

### `manual_conversational`

Brouillon d'une demande manuelle (ConversationalFormPage).

**`snapshot_json`** :

```json
{
  "snapshotType": "manual",
  "categoryId": "logement",
  "subcategoryId": "address_change_id_card",
  "formData": { "id_number": "123456789", "current_address_id": "..." },
  "currentStep": 3,
  "currentFieldIndex": 1,
  "availableDays": ["Lundi", "Mercredi"],
  "availableHours": ["9h-12h"],
  "userDescription": "...",
  "linkedRequestId": null,
  "selectedMember": "David Cohen",
  "selectedDocumentUrls": ["https://..."]
}
```

### `voice_stepflow`

Brouillon d'une demande vocale (StepFlowPage).

**`snapshot_json`** :

```json
{
  "snapshotType": "voice",
  "initialDataJson": { /* VoiceRequestInitialData.toJson() */ },
  "formDataJson": { /* VoiceRequestFormData.toJson() */ },
  "currentStepIndex": 2,
  "supplementaryUrls": ["https://..."],
  "requiredDocumentUrls": {
    "Teoudat Zehout": ["https://..."],
    "Contrat de location": ["https://..."]
  }
}
```

### `housing_inscription`

Brouillon d'inscription/désinscription logement (InscriptionLogementPage).

**`snapshot_json`** :

```json
{
  "snapshotType": "housing",
  "selectedServices": ["desinscriptionArnona", "inscriptionArnona", "inscriptionElectricite"],
  "currentStep": 1,
  "oldStreetNumber": "12",
  "oldStreetName": "Rothschild",
  "oldApartment": "3",
  "oldCity": "Tel Aviv",
  "oldKeyDate": "15/02/2026",
  "oldContractDate": null,
  "newStreetNumber": "8",
  "newStreetName": "Herzl",
  "newApartment": "5",
  "newCity": "Jerusalem",
  "newKeyDate": "01/03/2026",
  "newContractDate": null,
  "documentUrls": ["https://..."],
  "source": "voice",
  "transcribedText": "Je déménage de Tel Aviv à Jérusalem"
}
```

---

## Fréquence des appels

- **PATCH** : debounced ~2s côté frontend (autosave). En moyenne 5-15 appels
  par session de création.
- **POST** : 1 seul appel par brouillon (à la création).
- **GET** : 1 appel au chargement de la page d'accueil.
- **DELETE** : 1 appel après envoi réussi ou suppression manuelle.

---

## Sécurité

- Vérifier que l'`uid` du token correspond au propriétaire du brouillon.
- Limiter le nombre de brouillons par utilisateur (ex: max 10).
- Expirer les brouillons > 30 jours (cron ou TTL).
