# Olim Backend - API Express/Node.js pour Flutter App

Backend REST API pour l'application Flutter Olim, utilisant Firebase Admin SDK pour gérer Firestore, Authentication et Storage.

## 🏗️ Structure du projet

```
olim_backend/
├── src/
│   ├── config/
│   │   └── firebase.ts          # Configuration Firebase Admin
│   ├── controllers/             # Controllers par fonctionnalité
│   │   ├── auth.controller.ts
│   │   ├── profile.controller.ts
│   │   ├── requests.controller.ts
│   │   ├── appointments.controller.ts
│   │   ├── documents.controller.ts
│   │   ├── chat.controller.ts
│   │   ├── notifications.controller.ts
│   │   ├── subscription.controller.ts
│   │   ├── support.controller.ts
│   │   ├── health.controller.ts
│   │   ├── partners.controller.ts
│   │   ├── cinema.controller.ts
│   │   └── admin.controller.ts
│   ├── middleware/
│   │   ├── auth.middleware.ts   # Authentification Firebase
│   │   ├── errorHandler.ts
│   │   └── notFoundHandler.ts
│   ├── routes/                  # Routes par module
│   │   ├── auth.routes.ts
│   │   ├── profile.routes.ts
│   │   ├── requests.routes.ts
│   │   ├── appointments.routes.ts
│   │   ├── documents.routes.ts
│   │   ├── chat.routes.ts
│   │   ├── notifications.routes.ts
│   │   ├── subscription.routes.ts
│   │   ├── support.routes.ts
│   │   ├── health.routes.ts
│   │   ├── partners.routes.ts
│   │   ├── cinema.routes.ts
│   │   └── admin.routes.ts
│   ├── types/
│   │   └── firestore.types.ts   # Types TypeScript pour Firestore
│   └── server.ts                # Point d'entrée
├── package.json
├── tsconfig.json
├── .gitignore
└── env.example
```

## 🚀 Installation

1. **Installer les dépendances**
```bash
npm install
```

2. **Configurer les variables d'environnement**
```bash
cp env.example .env
# Éditer .env avec vos valeurs
```

### Variables d’environnement (essentielles)

- **Firebase Admin**:
  - **`FIREBASE_SERVICE_ACCOUNT`**: JSON string (recommandé)
  - ou **`FIREBASE_SERVICE_ACCOUNT_PATH`**: chemin vers un fichier (ex: `serviceAccountKey.json`)
- **Securden**:
  - **`SECURDEN_AUTH_TOKEN`**: obligatoire (création folder/account carte)
  - **`SECURDEN_BASE_URL`**: optionnel, défaut `https://olimservice.securden-vault.com/api/` (**HTTPS obligatoire**)
- **PayMe.io**:
  - **`PAYME_SELLER_KEY`**: obligatoire (clé marchand PayMe)
  - **`PAYME_BASE_URL`**: optionnel, défaut `https://live.payme.io/api/` (**HTTPS obligatoire**)
  - `PAYME_DEBUG=true` (optionnel) : logs de debug PayMe (sans données carte)

3. **Compiler TypeScript**
```bash
npm run build
```

4. **Lancer le serveur**
```bash
# Mode développement (avec watch)
npm run dev

# Mode production
npm start
```

## 📡 Routes API

### Authentification (`/api/auth`)
- `POST /api/auth/send-phone-otp` - Envoyer OTP téléphone (utilisateur connecté)
- `POST /api/auth/verify-phone-otp-and-link` - Vérifier OTP et lier téléphone
- `POST /api/auth/send-login-phone-otp` - Envoyer OTP login (sans auth)
- `POST /api/auth/verify-login-phone-otp` - Vérifier OTP login (retourne customToken)
- `POST /api/auth/create-visitor-account` - Créer compte Visitor
- `POST /api/auth/login-email` - Login email/password

### Profil (`/api/profile`)
- `GET /api/profile` - Récupérer profil
- `PATCH /api/profile` - Mettre à jour profil
- `GET /api/profile/complete` - Vérifier si profil complet
- `PATCH /api/profile/language` - Mettre à jour langue
- `GET /api/profile/family-members` - Liste membres famille
- `POST /api/profile/family-members` - Ajouter membre
- `PATCH /api/profile/family-members/:memberId` - Modifier membre
- `DELETE /api/profile/family-members/:memberId` - Supprimer membre
- `GET /api/profile/addresses` - Liste adresses
- `POST /api/profile/addresses` - Ajouter adresse
- `PATCH /api/profile/addresses/:addressId` - Modifier adresse
- `DELETE /api/profile/addresses/:addressId` - Supprimer adresse

### Clients (`/api/clients`)
- `POST /api/clients` - Créer un client (Firebase Auth + Firestore + Securden, réservé aux conseillers)

### Demandes (`/api/requests`)
- `GET /api/requests` - Liste des demandes
- `GET /api/requests/:requestId` - Détails d'une demande
- `POST /api/requests` - Créer une demande
- `PATCH /api/requests/:requestId` - Modifier une demande
- `DELETE /api/requests/:requestId` - Supprimer une demande
- `POST /api/requests/:requestId/files` - Upload fichiers
- `PATCH /api/requests/:requestId/assign` - Assigner conseiller
- `POST /api/requests/:requestId/rating` - Noter une demande
- `GET /api/requests/favorites/list` - Liste favoris
- `POST /api/requests/favorites/:requestId` - Ajouter favori
- `DELETE /api/requests/favorites/:requestId` - Retirer favori

### Rendez-vous (`/api/appointments`)
- `GET /api/appointments` - Liste des rendez-vous
- `GET /api/appointments/:appointmentId` - Détails d'un rendez-vous
- `POST /api/appointments` - Créer un rendez-vous
- `PATCH /api/appointments/:appointmentId` - Modifier un rendez-vous
- `DELETE /api/appointments/:appointmentId` - Annuler un rendez-vous
- `GET /api/appointments/slots/available` - Créneaux disponibles

### Documents (`/api/documents`)
- `GET /api/documents` - Liste des documents
- `GET /api/documents/personal` - Documents personnels
- `GET /api/documents/family-member/:memberId` - Documents d'un membre
- `POST /api/documents/personal/upload` - Upload document personnel
- `POST /api/documents/family-member/:memberId/upload` - Upload document membre
- `GET /api/documents/:documentId/download` - Télécharger document
- `DELETE /api/documents/:documentId` - Supprimer document

### Chat (`/api/chat`)
- `GET /api/chat/conversations` - Liste des conversations
- `GET /api/chat/conversations/:conversationId/messages` - Messages d'une conversation
- `POST /api/chat/conversations` - Créer une conversation
- `POST /api/chat/conversations/:conversationId/messages` - Envoyer un message
- `PATCH /api/chat/conversations/:conversationId/read` - Marquer comme lus
- `POST /api/chat/conversations/:conversationId/files` - Upload fichier dans chat

### Notifications (`/api/notifications`)
- `POST /api/notifications/token` - Enregistrer token FCM
- `GET /api/notifications` - Liste des notifications
- `GET /api/notifications/:notificationId` - Détails d'une notification
- `PATCH /api/notifications/:notificationId/read` - Marquer comme lue
- `PATCH /api/notifications/read-all` - Marquer toutes comme lues
- `DELETE /api/notifications/:notificationId` - Supprimer notification
- `GET /api/notifications/settings` - Paramètres notifications
- `PATCH /api/notifications/settings` - Mettre à jour paramètres

### Abonnement (`/api/subscription`)
- `GET /api/subscription/status` - État de l'abonnement
- `GET /api/subscription/cards` - Liste des cartes
- `POST /api/subscription/cards` - Ajouter une carte
- `PATCH /api/subscription/cards/:cardId` - Modifier une carte
- `DELETE /api/subscription/cards/:cardId` - Supprimer une carte
- `PATCH /api/subscription/cards/:cardId/set-default` - Définir carte par défaut
- `GET /api/subscription/invoices` - Liste des factures
- `GET /api/subscription/invoices/:invoiceId` - Détails d'une facture
- `GET /api/subscription/refunds` - Liste des remboursements
- `POST /api/subscription/refunds` - Créer demande de remboursement
- `GET /api/subscription/refunds/:refundId` - Détails d'un remboursement

### Support (`/api/support`)
- `GET /api/support/faqs` - Liste des FAQs
- `GET /api/support/contacts` - Contacts support
- `POST /api/support/contact-messages` - Envoyer message contact
- `GET /api/support/tickets` - Liste des tickets
- `POST /api/support/tickets` - Créer un ticket
- `GET /api/support/tickets/:ticketId` - Détails d'un ticket
- `PATCH /api/support/tickets/:ticketId` - Modifier un ticket

### Santé (`/api/health`)
- `GET /api/health/requests` - Liste des demandes santé
- `GET /api/health/requests/:requestId` - Détails d'une demande santé
- `POST /api/health/requests` - Créer une demande santé
- `PATCH /api/health/requests/:requestId` - Modifier une demande santé
- `GET /api/health/config` - Configuration santé
- `PATCH /api/health/config` - Mettre à jour configuration santé

### Partenaires (`/api/partners`)
- `GET /api/partners` - Liste des partenaires
- `GET /api/partners/:partnerId` - Détails d'un partenaire
- `GET /api/partners/vip/list` - Liste des partenaires VIP

### Cinéma (`/api/cinema`)
- `GET /api/cinema` - Informations cinéma
- `GET /api/cinema/movies` - Films disponibles

### Admin (`/api/admin`)
- `GET /api/admin/refund-requests` - Liste des remboursements (admin)
- `PATCH /api/admin/refund-requests/:refundId` - Modifier remboursement
- `GET /api/admin/system-alerts` - Alertes système
- `POST /api/admin/system-alerts` - Créer alerte système
- `POST /api/admin/sync-supabase` - Sync Supabase (manuel - désactivé)
- `POST /api/admin/fcm/generate-token` - Générer token FCM OAuth (désactivé)

## 🔐 Authentification

Toutes les routes (sauf celles marquées publiques) nécessitent un token Firebase ID dans le header :

```
Authorization: Bearer <firebase-id-token>
```

Le middleware `authenticateToken` vérifie le token et ajoute `req.uid` et `req.user` à la requête.

## ⚠️ Fonctionnalités désactivées/stubées

Pour des raisons de sécurité (production active), les fonctions suivantes sont désactivées ou stubées :

1. **Vonage OTP** - Routes auth retournent 501 (à implémenter)
2. **Firebase Storage upload** - Routes documents retournent 501 (à implémenter)
3. **Sync Supabase** - Route admin retourne 501 (désactivée)
4. **FCM OAuth token generation** - Route admin retourne 501 (désactivée)
5. **Triggers Firestore** - Non implémentés (à faire via Cloud Functions si nécessaire)
6. **Schedulers** - Non implémentés (à faire via Cloud Scheduler si nécessaire)

## 📝 Notes importantes

- **Structure Firestore** : Le backend respecte la structure existante (legacy + nouveau) pour compatibilité
- **Normalisation** : Certains champs existent en double (Status/status, Created At/createdAt) - le backend gère les deux
- **Abonnement** : Priorité de lecture : `freeAccess` > `membership` (nouveau) > `Membership` (legacy)
- **Documents** : Support de deux structures parallèles (nouveau/clean + legacy/streams)

## 🛠️ Développement

### Ajouter une nouvelle route

1. Créer/modifier le controller dans `src/controllers/`
2. Créer/modifier la route dans `src/routes/`
3. Importer et utiliser dans `src/server.ts`

### Types TypeScript

Les types Firestore sont définis dans `src/types/firestore.types.ts`. Ajouter de nouveaux types selon besoin.

## 📦 Dépendances principales

- `express` - Framework web
- `firebase-admin` - SDK Firebase Admin
- `cors` - Gestion CORS
- `helmet` - Sécurité HTTP
- `morgan` - Logging HTTP
- `typescript` - Compilation TypeScript

## 🔄 Prochaines étapes

1. Implémenter Vonage OTP pour l'authentification téléphone
2. Implémenter upload/download fichiers avec Firebase Storage
3. Ajouter middleware vérification rôle admin
4. Implémenter sync Supabase (si nécessaire)
5. Ajouter tests unitaires et d'intégration
6. Configurer CI/CD

