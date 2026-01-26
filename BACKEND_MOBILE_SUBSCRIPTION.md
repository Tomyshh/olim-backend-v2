# Backend guide (mobile) — Subscription/Paiement/Entitlements

## Objectif
Depuis la migration “source unique”, **le backend est l’autorité** sur les droits d’accès (membership/plan/promo/isUnpaid) et le frontend ne fait que :
- appeler des endpoints backend,
- afficher l’état,
- lire `Clients/{uid}/subscription/current` (read model) en temps réel.

## Source de vérité Firestore
Chemin canonique :
- `Clients/{uid}/subscription/current`

### Schéma recommandé (types)
```json
{
  "plan": {
    "type": "monthly|annual|free",
    "membership": "PackStart|PackEssential|PackVIP|PackElite|Visitor",
    "price": 9900,
    "currency": "ILS"
  },
  "states": {
    "isActive": true,
    "isPaused": false,
    "willExpire": false,
    "isAnnual": false
  },
  "payment": {
    "method": "recurring|one-time|none",
    "nextPaymentDate": "Timestamp|null",
    "lastPaymentDate": "Timestamp|null"
  },
  "payme": {
    "subCode": 123,
    "subID": "sub_...",
    "buyerKey": "buyer_...",
    "status": "active|cancelled|cancelled_pending|unpaid|expired",
    "sub_status": 1,
    "next_payment_date": "YYYY-MM-DD|null"
  },
  "promoCode": {
    "code": "ABC123",
    "source": "app|backoffice|…",
    "appliedDate": "Timestamp",
    "expirationDate": "Timestamp|null"
  },
  "isUnpaid": false,
  "dates": {
    "startDate": "Timestamp|null",
    "endDate": "Timestamp|null",
    "cancelledDate": "Timestamp|null",
    "resumedDate": "Timestamp|null",
    "updatedAt": "Timestamp"
  },
  "history": {
    "lastModified": "Timestamp",
    "modifiedBy": "string"
  }
}
```

### Règles métier minimales attendues côté mobile
- **`plan.type`** est la référence (monthly/annual/free). Le mobile mappe en interne : monthly→3, annual→4, free→0.
- **`isUnpaid`** est **canonique dans `subscription/current`**.
- **Pas d’écriture client-side** sur les entitlements : le backend doit maintenir ce doc (webhook/cron + réponses API).

## Contrats API consommés par le mobile
Tous les endpoints sont sous `/api/subscription/*` et protégés par `authenticateToken` (Bearer Firebase ID token).

### 1) Ajouter une carte
**POST** `/api/subscription/cards`

**Auth**: `Authorization: Bearer <Firebase ID token>`

**Body (mobile)** :
```json
{
  "cardNumber": "....",
  "expirationDate": "MM/YY",
  "cvv": "...",
  "cardHolder": "optional",
  "cardName": "optional",
  "isSubscriptionCard": true,
  "isDefault": true
}
```

**Réponse (attendue par le mobile)** :
```json
{
  "paymentCredentialId": "docIdPaymentCredentials",
  "buyerKey": "buyer_...",
  "buyerCard": "****1234"
}
```

### 2) Quote de changement (prorata)
**POST** `/api/subscription/change/quote`

**Body accepté** (selon `subscription.controller.ts` mentionné) :
```json
{
  "membershipType": "PackVIP",
  "plan": "monthly|annual",
  "cardId": "optional",
  "promoCode": "optional",
  "promoCodeSource": "optional",
  "expectedPriceInCents": 9900
}
```

**Réponse 200** (structure utilisée côté mobile pour debug/validation) :
```json
{
  "success": true,
  "quoteId": "quote_...",
  "expiresAt": "ISO|Timestamp",
  "current": { "membershipType": "PackStart", "plan": "monthly" },
  "target": { "membershipTypeNormalized": "PackVIP", "planNormalized": "monthly", "cardId": "..." },
  "pricing": { "basePriceInCents": 9900, "discountInCents": 0, "chargedPriceInCents": 9900 },
  "proration": { "proratedChargeInCents": 1234, "nextPaymentDate": "YYYY-MM-DD|null" },
  "promo": { "promoCode": "ABC", "discountType": "...", "discountValue": 10 }
}
```

**Erreurs attendues** :
- `400 MEMBERSHIP_REQUIRED|MEMBERSHIP_INVALID|PLAN_INVALID|PROMO_*`
- `409 SAME_PLAN`

### 3) Subscribe / Change (exécution)
**POST** `/api/subscription/subscribe`

**Body (mobile)** :
```json
{
  "operation": "subscribe|change",
  "quoteId": "required when operation=change",
  "membershipType": "PackVIP",
  "plan": "monthly|annual",
  "cardId": "Payment credentials doc id",
  "promoCode": "optional",
  "promoCodeSource": "optional",
  "priceInCents": 9900,
  "expectedPriceInCents": 9900
}
```

**Réponse 200 (succès)** :
```json
{
  "success": true,
  "salePaymeId": "sale_...",
  "subCode": 123,
  "subID": "sub_...",
  "cardId": "docId",
  "chargedPriceInCents": 9900,
  "membershipTypeNormalized": "PackVIP",
  "planNormalized": "monthly",
  "promo": { "promoCode": "ABC", "discountType": "...", "discountValue": 10 },
  "subscription": { /* snapshot du doc logique côté backend */ }
}
```

**Erreurs notables** :
- `400 OPERATION_INVALID|MEMBERSHIP_REQUIRED|CARD_REQUIRED|PRORATION_QUOTE_REQUIRED|PRORATION_QUOTE_INVALID|PRORATION_QUOTE_EXPIRED|…`
- `409 PRICE_MISMATCH`

### 4) Status / Entitlement (anti-PayMe côté app)
**GET** `/api/subscription/status`

Le mobile utilise ce endpoint comme **source de vérité entitlement** (l’app ne doit plus appeler PayMe directement pour décider).

**Réponse recommandée** (déjà documentée dans `BACKEND_SUBSCRIPTION_ENTITLEMENTS.md`) :
```json
{
  "success": true,
  "subscription": {
    "payme": { "subCode": 123, "subId": "sub_...", "sub_status": 5, "next_payment_date": "2026-02-01" },
    "entitlement": { "isEntitled": true, "accessUntil": "2026-02-01T00:00:00.000Z", "state": "cancelled_pending" }
  }
}
```

**Mapping mobile** :
- `state == cancelled_pending` (ou `cancelled` + `accessUntil` futur) → accès OK + pop-up “accès jusqu’au …” (anti-spam).
- `state == expired` ou `isEntitled == false` → pop-up “abonnement expiré” + restriction d’accès.
- `state == active` ou `isEntitled == true` → accès OK.
- Si payload incomplet/indisponible → **fail-open** (ne pas bloquer), le backend doit se resynchroniser.

## Cancel / Resume (produit)
- **Annulation self-service mobile** : **NON** (réservé backoffice).
- “Réactiver” côté app = **Visitor → payant** via `/api/subscription/subscribe` (operation subscribe).

## isUnpaid (canonique)
- Le backend doit écrire `subscription/current.isUnpaid` (ou `states.isUnpaid`, mais le mobile lit d’abord `isUnpaid`).
- Le mobile ne doit pas écrire `isUnpaid` (ni grace period) côté Firestore.

## Webhooks / sync (fortement recommandé)
- Webhook PayMe pour: paiement réussi, paiement échoué, annulation, reprise, etc.
- Job cron de rattrapage: resync des abonnements `active/cancelled_pending` pour corriger les cas hors webhook.
- À chaque update: mettre à jour `subscription/current` + `history.lastModified`.

## Sécurité Firestore (recommandations)
- Le client mobile doit pouvoir **lire** `Clients/{uid}/subscription/current`.
- Le client mobile ne doit pas pouvoir **écrire** `Clients/{uid}/subscription/current` (entitlements), sauf éventuels champs “non sensibles” explicitement listés.

## Champs “anti-spam” (optionnels)
Pour éviter de spammer le pop-up d’annulation, l’app écrit (dans `Clients/{uid}`):
- `lastCancellationNoticeShownAt` (Timestamp)
- `lastCancellationNoticeNextPaymentDate` (String `dd/MM/yyyy`)

Ces champs ne sont pas des entitlements; ils peuvent rester côté client.

