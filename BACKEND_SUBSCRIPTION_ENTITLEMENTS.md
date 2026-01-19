# Spécification backend — Abonnements PayMe: accès jusqu’à la fin de période (status 5)

## Contexte
Dans l’app, PayMe peut renvoyer `sub_status = 5` pour un abonnement **annulé**.  
Problème historique: l’app rétrogradait en **Visiteur immédiatement**, alors que l’utilisateur a déjà payé une période et doit conserver l’accès jusqu’à la **fin de période**.

**Règle cible**: si `sub_status == 5`, l’accès reste **actif jusqu’à `next_payment_date`** (PayMe `sub_next_date`).  
À l’expiration réelle (now >= `next_payment_date`), l’accès payant s’arrête (Visiteur).

---

## Source de vérité recommandée
Le backend calcule et maintient un “entitlement” (droit d’accès) et met à jour Firestore.

### Valeurs clés
- **accessUntil**: date/heure de fin d’accès payant.
  - dérivée de PayMe `sub_next_date` (equiv. app: `next_payment_date`).
- **state**:
  - `active`: prélèvements OK, accès actif.
  - `cancelled_pending`: abonnement annulé, mais accès encore actif jusqu’à `accessUntil`.
  - `expired`: accès terminé (now >= accessUntil).
  - `unpaid_grace`: paiement en échec mais période de retry en cours (si vous gardez cette logique).
  - `unpaid`: impayé confirmé (si applicable).

---

## Écritures Firestore (à effectuer côté backend)
Chemin: `Clients/{uid}/subscription/current` (déjà utilisé par l’app).

### Champs à maintenir
```json
{
  "payme": {
    "subCode": 123,
    "subID": "sub_...",
    "status": "active|cancelled|unpaid|expired",
    "sub_status": 5,
    "nextPaymentDate": "Timestamp" 
  },
  "dates": {
    "startDate": "Timestamp|null",
    "endDate": "Timestamp|null",
    "cancelledDate": "Timestamp|null",
    "updatedAt": "Timestamp"
  },
  "states": {
    "isActive": true,
    "willExpire": true,
    "isPaused": false,
    "isAnnual": false
  },
  "plan": {
    "type": "paid|free",
    "membership": "PackStart|PackEssential|PackVIP|PackElite|Visitor",
    "price": 9900,
    "currency": "ILS"
  }
}
```

### Mapping de règle (important)
- Si `sub_status == 5` et `now < nextPaymentDate`:
  - `states.isActive = true`
  - `states.willExpire = true`
  - `dates.endDate = nextPaymentDate`
  - `payme.status = "cancelled"`
  - **NE PAS** basculer le client en Visitor.
- Si `sub_status == 5` et `now >= nextPaymentDate`:
  - `states.isActive = false`
  - `states.willExpire = false`
  - `payme.status = "expired"`
  - Optionnel (mais recommandé): déclencher la conversion Visitor (voir section suivante).

---

## Conversion Visitor à l’expiration
Quand l’accès payant se termine (`state = expired`), vous pouvez:

### Option A (recommandée): backend convertit en Visitor
Mettre à jour **les deux architectures** (le code app fait déjà ça dans `DatabaseService.setMembershipToVisitor()`):  
- Doc principal: `Clients/{uid}`
  - `Membership Type = "Visitor"` (+ reset `subPlan`, `israCard_subCode`, etc.)
- Sous-doc: `Clients/{uid}/subscription/current`
  - `plan.membership = "Visitor"`, `states.isActive=false`, etc.

### Option B: backend ne convertit pas, il ne fait que l’entitlement
L’app lit `states.isActive=false` et décide d’afficher le mode Visitor.  
Moins fiable (risque de divergence si d’autres écrans lisent encore `Clients/{uid}`).

---

## Contrat API — `GET /api/subscription/status`
L’app dispose déjà d’un client (`SubscriptionBackendService.getStatus()`).

### Request
- **Auth**: Bearer Firebase ID token
- **Path**: `/api/subscription/status`

### Response (proposée) — format recommandé (utilisé par le frontend)
```json
{
  "success": true,
  "subscription": {
    "uid": "uid",
    "payme": {
      "subCode": 123,
      "subId": "sub_...",
      "sub_status": 5,
      "next_payment_date": "2026-02-01"
    },
    "entitlement": {
      "isEntitled": true,
      "accessUntil": "2026-02-01T00:00:00.000Z",
      "state": "cancelled_pending"
    },
    "updatedAt": "2026-01-19T12:34:56.000Z"
  }
}
```

### Compat (pour faciliter le rollout)
Le frontend tolère aussi (en fallback) :
- `subscription.payme.next_payment_date` (string `YYYY-MM-DD`) si `entitlement.accessUntil` n’est pas fourni.
- `entitlement.state` peut être `cancelled` (au lieu de `cancelled_pending`) si `accessUntil` est fourni et futur.

### Règles backend (résumé)
- `sub_status==5` + `now < accessUntil` → `isEntitled=true`, `state=cancelled_pending`
- `sub_status==5` + `now >= accessUntil` → `isEntitled=false`, `state=expired` (+ conversion Visitor recommandée)

---

## Webhook / sync recommandé
Pour être fiable sur les annulations manuelles PayMe:
- **Webhook PayMe** (idéal) pour événements: annulation, paiement échoué, paiement réussi, etc.
- + **cron** (fallback): resynchroniser toutes les X heures les abonnements `active/cancelled_pending` (récupérer `sub_status` et `sub_next_date`).

---

## Notes frontend (déjà implémenté)
- L’app ne rétrograde plus en Visitor au `sub_status==5` si `next_payment_date` est future.
- Un pop-up informatif est affiché (anti-spam) “accès actif jusqu’au …”.
- Champs Firestore utilisés par l’app pour l’anti-spam (optionnel côté backend):\n
  - `Clients/{uid}.lastCancellationNoticeShownAt`\n
  - `Clients/{uid}.lastCancellationNoticeNextPaymentDate` (format `dd/MM/yyyy`)\n

