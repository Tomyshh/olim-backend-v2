## Schéma Firestore (inféré)

Ce document décrit la **structure déduite** de Firestore à partir d’un scan **en lecture seule** (aucune écriture, aucune suppression).

### Source du scan

- **Projet Firebase**: `olimservice-7dbee`
- **JSON brut généré**: `tmp/firestore-schema/firestore-schema-1769406568774.json`
- **Date**: 2026-01-26

### Paramètres (pour finir en temps raisonnable)

Attention: Firestore peut contenir des collections énormes et des sous-collections sous chaque document. Pour éviter un run “infini”, le scan a utilisé des caps **uniquement pour l’inférence du schéma**:

- **`maxDocsPerCollection`**: 2000 (par collection *scannée*)
- **`subcollectionDiscoveryDocs`**: 50 (nombre de documents, par collection, utilisés pour découvrir les sous-collections)
- **`subcollectionMaxInstancesPerPath`**: 50 (nombre max d’instances scannées par chemin normalisé de sous-collection)
- **`maxDepth`**: 25
- **`maxFieldDepth`**: 20

### Lecture du tableau “Présence”

- Pour un champ normal (ex: `email`), **Présence** = \(% documents où le champ apparaît\).
- Pour un champ d’élément de tableau (ex: `tags[]`), **Présence** peut dépasser 100%: cela correspond à \(nombre moyen d’éléments\) par document (car on compte les éléments, pas seulement l’existence du tableau).

---

## Détails du schéma (par collection)

**Source**: scan Firestore en lecture seule via firebase-admin.

### Paramètres de scan

- maxDocsPerCollection: 2000 (cap utilisé pour déduire la structure)
- subcollectionDiscoveryDocs: 50
- subcollectionMaxInstancesPerPath: 50
- maxDepth: 25
- maxFieldDepth: 20

### Totaux

```
{
  "collectionsDiscovered": 20,
  "collectionsScanned": 36,
  "documentsScanned": 8414,
  "edgesDiscovered": 16
}
```

### Collections racine

- `AdminAuditLogs`
- `Advertisement`
- `Annonces`
- `Astuces`
- `ChatCC`
- `Chats`
- `ClientCreationLocks`
- `Clients`
- `Conseillers`
- `Conseillers2`
- `Jobs`
- `Leads`
- `Partenaires`
- `PhoneOtpLogin`
- `PhoneOtpRequests`
- `Promotions`
- `Restaurants`
- `Utils`
- `delete_user_requests`
- `iCinema`

### Relations (parent → sous-collection)

- `ChatCC` → `messages` → `ChatCC/{docId}/messages`
- `Chats` → `messages` → `Chats/{docId}/messages`
- `Clients` → `Addresses` → `Clients/{docId}/Addresses`
- `Clients` → `Client Acces` → `Clients/{docId}/Client Acces`
- `Clients` → `Client Documents` → `Clients/{docId}/Client Documents`
- `Clients` → `Client Logs` → `Clients/{docId}/Client Logs`
- `Clients` → `Family Members` → `Clients/{docId}/Family Members`
- `Clients` → `favoriteRequests` → `Clients/{docId}/favoriteRequests`
- `Clients` → `Isracard Client Logs` → `Clients/{docId}/Isracard Client Logs`
- `Clients` → `Payment credentials` → `Clients/{docId}/Payment credentials`
- `Clients` → `Requests` → `Clients/{docId}/Requests`
- `Clients/{docId}/Requests` → `Pending process` → `Clients/{docId}/Requests/{docId}/Pending process`
- `Clients` → `subscription` → `Clients/{docId}/subscription`
- `Clients` → `Tips` → `Clients/{docId}/Tips`
- `Clients` → `Whatsapp Requests` → `Clients/{docId}/Whatsapp Requests`
- `iCinema` → `Seances` → `iCinema/{docId}/Seances`

### `AdminAuditLogs`

- Docs analysés: **32**
- Champs détectés: **26**

| Champ | Types observés | Présence |
|---|---:|---:|
| `action` | string(32) | 100% |
| `callerUid` | string(32) | 100% |
| `cancelAttempted` | boolean(13) | 40.6% |
| `cancelSkippedAsNonFatal` | boolean(13) | 40.6% |
| `clientId` | string(31) | 96.9% |
| `ip` | string(32) | 100% |
| `localSubStatus` | number(1) | 3.1% |
| `payload` | map(31) | 96.9% |
| `payload.installments` | null(14) | 43.8% |
| `payload.isReplacement` | boolean(14) | 43.8% |
| `payload.membership` | string(14) | 43.8% |
| `payload.newPriceInCents` | number(3) | 9.4% |
| `payload.paymentCredentialId` | string(28) | 87.5% |
| `payload.plan` | string(14) | 43.8% |
| `payload.priceInCents` | number(14) | 43.8% |
| `payload.promoCode` | null(17) | 53.1% |
| `payload.useCustomPrice` | boolean(17) | 53.1% |
| `remoteStatus` | number(1) | 3.1% |
| `salePaymeId` | string(14) | 43.8% |
| `subCode` | number(15) | 46.9% |
| `subId` | string(6) | 18.8% |
| `subID` | string(14) | 43.8% |
| `targetEmail` | string(1) | 3.1% |
| `targetUid` | string(1) | 3.1% |
| `timestamp` | timestamp(32) | 100% |
| `userAgent` | string(32) | 100% |

### `Advertisement`

- Docs analysés: **30**
- Champs détectés: **10**

| Champ | Types observés | Présence |
|---|---:|---:|
| `clicks` | number(3) | 10% |
| `created_at` | timestamp(30) | 100% |
| `description` | string(30) | 100% |
| `impressions` | number(30) | 100% |
| `isActive` | boolean(30) | 100% |
| `lastClickedAt` | timestamp(3) | 10% |
| `lastShownAt` | timestamp(30) | 100% |
| `phone` | string(1) | 3.3% |
| `url` | string(30) | 100% |
| `whatsapp` | string(29) | 96.7% |

### `Annonces`

- Docs analysés: **10**
- Champs détectés: **3**

| Champ | Types observés | Présence |
|---|---:|---:|
| `content` | string(10) | 100% |
| `created_at` | timestamp(10) | 100% |
| `title` | string(10) | 100% |

### `Astuces`

- Docs analysés: **12**
- Champs détectés: **20**

| Champ | Types observés | Présence |
|---|---:|---:|
| `content` | string(9) | 75% |
| `content_large` | map(12) | 100% |
| `content_large.am` | string(12) | 100% |
| `content_large.en` | string(12) | 100% |
| `content_large.es` | string(12) | 100% |
| `content_large.fr` | string(12) | 100% |
| `content_large.he` | string(12) | 100% |
| `content_large.ru` | string(12) | 100% |
| `content_large.uk` | string(12) | 100% |
| `created_at` | timestamp(3) | 25% |
| `title` | string(9) | 75% |
| `title_large` | map(12) | 100% |
| `title_large.am` | string(12) | 100% |
| `title_large.en` | string(12) | 100% |
| `title_large.es` | string(12) | 100% |
| `title_large.fr` | string(12) | 100% |
| `title_large.he` | string(12) | 100% |
| `title_large.ru` | string(12) | 100% |
| `title_large.uk` | string(12) | 100% |
| `updated_at` | timestamp(12) | 100% |

### `ChatCC`

- Docs analysés: **2000**
- Champs détectés: **24**

| Champ | Types observés | Présence |
|---|---:|---:|
| `chat_rating` | number(2) | 0.1% |
| `chat_rating_date` | timestamp(2) | 0.1% |
| `chat_rating_skipped` | boolean(1) | 0.1% |
| `chat_rating_tags` | array(2) | 0.1% |
| `clientId` | string(2000) | 100% |
| `closed_chat_date` | timestamp(270) | 13.5% |
| `counselorId` | string(2000) | 100% |
| `counselorName` | string(2000) | 100% |
| `evaluation_date` | timestamp(260) | 13% |
| `evaluation_feedback` | string(260) | 13% |
| `evaluation_improvements` | string(260) | 13% |
| `evaluation_note` | string(10) | 0.5% |
| `evaluation_strengths` | string(260) | 13% |
| `is_done` | boolean(2000) | 100% |
| `is_done_by` | string(270) | 13.5% |
| `isFavorite` | boolean(40) | 2% |
| `lastMessage` | string(2000) | 100% |
| `lastTimestamp` | timestamp(2000) | 100% |
| `requestId` | string(2000) | 100% |
| `satisfaction_score` | number(270) | 13.5% |
| `unreadForClient` | number(110) | 5.5% |
| `unreadForCounselor` | number(182) | 9.1% |
| `welcomeShownAt` | timestamp(1164) | 58.2% |
| `welcomeShownToClient` | boolean(1164) | 58.2% |

### `ChatCC/{docId}/messages`

- Docs analysés: **77**
- Champs détectés: **11**

| Champ | Types observés | Présence |
|---|---:|---:|
| `clientId` | string(47) | 61% |
| `content` | string(77) | 100% |
| `fileUrl` | null(76), string(1) | 100% |
| `isUploading` | boolean(77) | 100% |
| `readBy` | array(77) | 100% |
| `readBy[]` | string(141) | 183.1% |
| `requestId` | string(48) | 62.3% |
| `senderId` | string(77) | 100% |
| `senderName` | string(77) | 100% |
| `timestamp` | timestamp(77) | 100% |
| `type` | string(77) | 100% |

### `Chats`

- Docs analysés: **3**
- Champs détectés: **2**

| Champ | Types observés | Présence |
|---|---:|---:|
| `participants` | array(3) | 100% |
| `participants[]` | string(6) | 200% |

### `Chats/{docId}/messages`

- Docs analysés: **7**
- Champs détectés: **5**

| Champ | Types observés | Présence |
|---|---:|---:|
| `imageUrl` | null(7) | 100% |
| `isRead` | boolean(7) | 100% |
| `message` | string(7) | 100% |
| `sender` | string(7) | 100% |
| `timestamp` | timestamp(7) | 100% |

### `ClientCreationLocks`

- Docs analysés: **17**
- Champs détectés: **6**

| Champ | Types observés | Présence |
|---|---:|---:|
| `email` | string(17) | 100% |
| `lastError` | string(5) | 29.4% |
| `startedAt` | timestamp(17) | 100% |
| `status` | string(17) | 100% |
| `uid` | string(16) | 94.1% |
| `updatedAt` | timestamp(17) | 100% |

### `Clients`

- Docs analysés: **2000**
- Champs détectés: **150**

| Champ | Types observés | Présence |
|---|---:|---:|
| `_sync` | map(1) | 0.1% |
| `_sync.at` | timestamp(1) | 0.1% |
| `_sync.origin` | string(1) | 0.1% |
| `_sync.source` | string(1) | 0.1% |
| `activity` | map(1999) | 100% |
| `activity.computedAt` | timestamp(1999) | 100% |
| `activity.currentMonthRequests` | number(1999) | 100% |
| `activity.daysSinceLastRequest` | number(1066), null(933) | 100% |
| `activity.lastRequestAt` | timestamp(1066), null(933) | 100% |
| `activity.monthly_average` | number(1999) | 100% |
| `activity.requests30d` | number(1999) | 100% |
| `activity.requests90d` | number(1999) | 100% |
| `activity.score` | number(1999) | 100% |
| `activity.status` | string(1999) | 100% |
| `activity.version` | number(1999) | 100% |
| `annual_expiration_date` | null(35), timestamp(4) | 2% |
| `Birthday` | string(1954), null(1) | 97.8% |
| `cancellation_reason` | string(2) | 0.1% |
| `Civility` | string(1943), null(1) | 97.2% |
| `Client ID` | string(1982) | 99.1% |
| `Client UID` | string(9) | 0.5% |
| `codePromoExpirationDate` | null(1507), string(8), timestamp(5) | 76% |
| `codePromoSource` | string(1) | 0.1% |
| `Created At` | timestamp(9) | 0.5% |
| `Created From` | string(1730), null(3) | 86.7% |
| `createdAt` | timestamp(119) | 6% |
| `createdFrom` | string(13) | 0.7% |
| `createdVia` | string(78) | 3.9% |
| `currentSubscriptionPrice` | string(3) | 0.2% |
| `Devices` | array(1944) | 97.2% |
| `Devices[]` | string(1285) | 64.3% |
| `elite_onboarding_assigned_to` | string(1) | 0.1% |
| `elite_onboarding_request_created` | boolean(1) | 0.1% |
| `elite_onboarding_request_created_at` | timestamp(1) | 0.1% |
| `Email` | string(1982) | 99.1% |
| `Father Name` | string(1870), null(70) | 97% |
| `FCM_Token` | array(1931) | 96.6% |
| `FCM_Token[]` | string(3617), map(7) | 181.2% |
| `First Name` | string(1964) | 98.2% |
| `freeAccess` | map(7) | 0.4% |
| `freeAccess.expiresAt` | timestamp(7) | 0.4% |
| `freeAccess.grantedAt` | timestamp(7) | 0.4% |
| `freeAccess.grantedBy` | string(7) | 0.4% |
| `freeAccess.isEnabled` | boolean(7) | 0.4% |
| `freeAccess.membership` | string(7) | 0.4% |
| `freeAccess.notes` | string(7) | 0.4% |
| `freeAccess.reason` | string(7) | 0.4% |
| `hasGOVAccess` | boolean(674) | 33.7% |
| `informations_filled` | boolean(1238) | 61.9% |
| `is_annual_subscription` | boolean(173) | 8.7% |
| `isFirstVisit` | boolean(1279) | 64% |
| `IsraCard Sub Code` | number(1926), null(5) | 96.6% |
| `IsraCard Sub ID` | string(1199), null(146) | 67.3% |
| `israCard_subCode` | number(96) | 4.8% |
| `isUnpaid` | boolean(1822) | 91.1% |
| `Koupat Holim` | string(1954), null(1) | 97.8% |
| `language` | string(1347) | 67.4% |
| `Last Membership Update` | timestamp(199) | 10% |
| `Last Name` | string(1955) | 97.8% |
| `lastAdShownAt` | timestamp(1123) | 56.2% |
| `lastChangeMembership` | timestamp(36) | 1.8% |
| `lastLoginAt` | timestamp(72) | 3.6% |
| `lastModified` | timestamp(157) | 7.9% |
| `lastRequestDate` | timestamp(468) | 23.4% |
| `lastUnpaidCheck` | timestamp(601) | 30.1% |
| `manual_payme_sync_requested_at` | timestamp(2) | 0.1% |
| `membership` | map(1797) | 89.9% |
| `Membership` | string(1954) | 97.7% |
| `Membership Plan` | number(40) | 2% |
| `Membership Price` | string(226) | 11.3% |
| `Membership Type` | string(9) | 0.5% |
| `membership.status` | string(1797) | 89.9% |
| `membership.type` | string(1797) | 89.9% |
| `membership.validUntil` | null(1794), timestamp(2), string(1) | 89.9% |
| `mergedAt` | timestamp(13) | 0.7% |
| `mergedFromAuthUids` | array(7) | 0.4% |
| `mergedFromAuthUids[]` | string(7) | 0.4% |
| `mergedFromPhones` | array(7) | 0.4% |
| `mergedFromPhones[]` | string(7) | 0.4% |
| `mergedIntoUid` | string(6) | 0.3% |
| `mergedReason` | string(6) | 0.3% |
| `mirpaa_name` | string(6) | 0.3% |
| `originalPrice` | string(3) | 0.2% |
| `paymeSubID` | string(19) | 1% |
| `Phone Number` | array(1929), string(43), null(1) | 98.7% |
| `Phone Number[]` | string(1945), map(3) | 97.4% |
| `phoneVerified` | boolean(49) | 2.5% |
| `phoneVerifiedAt` | timestamp(49) | 2.5% |
| `previous_membership` | string(2) | 0.1% |
| `Promo Code Applied Date` | timestamp(3) | 0.2% |
| `Promo Code Reduction` | null(90), number(6) | 4.8% |
| `Promo Code Source` | string(96) | 4.8% |
| `promoCodeSource` | string(1) | 0.1% |
| `promoCodeUsed` | string(974), null(593) | 78.4% |
| `promoDuration` | number(3) | 0.2% |
| `promoEndDate` | timestamp(3) | 0.2% |
| `promoPrice` | string(3) | 0.2% |
| `registration` | map(24) | 1.2% |
| `Registration Status` | string(9) | 0.5% |
| `registration.currentStep` | number(10) | 0.5% |
| `registration.data` | map(10) | 0.5% |
| `registration.data.acceptConditions` | boolean(10) | 0.5% |
| `registration.data.acceptNewsletter` | boolean(10) | 0.5% |
| `registration.data.additionalAddress` | string(10) | 0.5% |
| `registration.data.address` | string(10) | 0.5% |
| `registration.data.apartment` | string(10) | 0.5% |
| `registration.data.birthday` | string(10) | 0.5% |
| `registration.data.civility` | string(10) | 0.5% |
| `registration.data.currentStep` | number(10) | 0.5% |
| `registration.data.email` | string(10) | 0.5% |
| `registration.data.fatherName` | string(10) | 0.5% |
| `registration.data.firstName` | string(10) | 0.5% |
| `registration.data.floor` | string(10) | 0.5% |
| `registration.data.isIsraeli` | boolean(10) | 0.5% |
| `registration.data.koupatHolim` | string(10) | 0.5% |
| `registration.data.language` | string(10) | 0.5% |
| `registration.data.lastName` | string(10) | 0.5% |
| `registration.data.membershipPlan` | null(10) | 0.5% |
| `registration.data.membershipPrice` | null(10) | 0.5% |
| `registration.data.membershipType` | null(10) | 0.5% |
| `registration.data.phoneNumbers` | array(6), null(4) | 0.5% |
| `registration.data.phoneNumbers[]` | string(6) | 0.3% |
| `registration.data.teoudatZeout` | string(10) | 0.5% |
| `registration.data.timestamp` | number(10) | 0.5% |
| `registration.data.userId` | string(10) | 0.5% |
| `registration.inProgress` | boolean(24) | 1.2% |
| `registration.updatedAt` | timestamp(24) | 1.2% |
| `registrationComplete` | boolean(2000) | 100% |
| `registrationCompletedAt` | timestamp(112) | 5.6% |
| `sale_payme_id` | string(27) | 1.4% |
| `Securden folder` | string(1880), null(51) | 96.6% |
| `securden_Folder` | string(44) | 2.2% |
| `selected_installments` | null(38), number(1) | 2% |
| `subPlan` | number(95) | 4.8% |
| `Subscription Plan` | number(1929), null(1) | 96.5% |
| `Subscription Start Date` | string(170) | 8.5% |
| `subscription_cancelled_date` | timestamp(2) | 0.1% |
| `subscription_last_sync` | timestamp(2) | 0.1% |
| `subscription_next_date` | timestamp(2) | 0.1% |
| `subscription_next_date_iso` | string(2) | 0.1% |
| `Teoudat Zeout` | string(1896), null(59) | 97.8% |
| `totalRequests` | number(468) | 23.4% |
| `uid` | string(69) | 3.5% |
| `unpaidGracePeriodExpires` | timestamp(6) | 0.3% |
| `unpaidGracePeriodStart` | timestamp(6) | 0.3% |
| `updatedAt` | timestamp(10), map(9) | 1% |
| `updatedByAdminAt` | map(10) | 0.5% |
| `updatedByAdminUid` | string(10) | 0.5% |
| `useCustomPrice` | boolean(4) | 0.2% |
| `verifiedPhoneNumber` | string(49) | 2.5% |

_Le reste des collections et champs est listé dans le JSON brut (`tmp/firestore-schema/firestore-schema-1769406568774.json`)._

