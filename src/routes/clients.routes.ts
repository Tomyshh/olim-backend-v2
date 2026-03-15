import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.middleware.js';
import { requireConseiller } from '../middleware/conseiller.middleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { idempotencyMiddleware } from '../middleware/idempotency.middleware.js';
import * as clientsController from '../controllers/clients.controller.js';
import * as clientSubscriptionController from '../controllers/clientSubscription.controller.js';

const router = Router();

// POST /api/clients
router.post(
  '/',
  authenticateToken,
  requireConseiller,
  ...(process.env.IDEMPOTENCY_ENABLED === 'true'
    ? [
        idempotencyMiddleware({
          prefix: 'idem:api:clients:create',
          ttlSeconds: Number(process.env.IDEMPOTENCY_TTL_SECONDS || 24 * 3600),
          inFlightTtlSeconds: Number(process.env.IDEMPOTENCY_INFLIGHT_TTL_SECONDS || 30),
          preferUid: true
        })
      ]
    : []),
  asyncHandler(clientsController.createClient as any)
);

// POST /api/clients/:clientId/payment-credentials/credit-card
router.post(
  '/:clientId/payment-credentials/credit-card',
  authenticateToken,
  requireConseiller,
  ...(process.env.IDEMPOTENCY_ENABLED === 'true'
    ? [
        idempotencyMiddleware({
          prefix: 'idem:api:clients:addCardCredential',
          ttlSeconds: Number(process.env.IDEMPOTENCY_TTL_SECONDS || 24 * 3600),
          inFlightTtlSeconds: Number(process.env.IDEMPOTENCY_INFLIGHT_TTL_SECONDS || 30),
          preferUid: true
        })
      ]
    : []),
  asyncHandler(clientsController.addClientCreditCardPaymentCredential as any)
);

// DELETE /api/clients/:clientId/payment-credentials/credit-card/:paymentCredentialId
router.delete(
  '/:clientId/payment-credentials/credit-card/:paymentCredentialId',
  authenticateToken,
  requireConseiller,
  asyncHandler(clientsController.deleteClientCreditCardPaymentCredential as any)
);

// ---------------------------------------------------------------------------
// Gestion abonnement pour un client existant (backoffice)
// Auth Firebase obligatoire + conseiller requis
// ---------------------------------------------------------------------------

// GET /api/clients/:clientId/subscription/state
router.get(
  '/:clientId/subscription/state',
  authenticateToken,
  requireConseiller,
  asyncHandler(clientSubscriptionController.getClientSubscriptionState as any)
);

// POST /api/clients/:clientId/subscription/create-payment-session (hosted PayMe flow)
router.post(
  '/:clientId/subscription/create-payment-session',
  authenticateToken,
  requireConseiller,
  ...(process.env.IDEMPOTENCY_ENABLED === 'true'
    ? [
        idempotencyMiddleware({
          prefix: 'idem:api:clients:subscription:createPaymentSession',
          ttlSeconds: Number(process.env.IDEMPOTENCY_TTL_SECONDS || 24 * 3600),
          inFlightTtlSeconds: Number(process.env.IDEMPOTENCY_INFLIGHT_TTL_SECONDS || 30),
          preferUid: true
        })
      ]
    : []),
  asyncHandler(clientSubscriptionController.createPaymentSession as any)
);

// POST /api/clients/:clientId/subscription (create/replace)
router.post(
  '/:clientId/subscription',
  authenticateToken,
  requireConseiller,
  ...(process.env.IDEMPOTENCY_ENABLED === 'true'
    ? [
        idempotencyMiddleware({
          prefix: 'idem:api:clients:subscription:createOrReplace',
          ttlSeconds: Number(process.env.IDEMPOTENCY_TTL_SECONDS || 24 * 3600),
          inFlightTtlSeconds: Number(process.env.IDEMPOTENCY_INFLIGHT_TTL_SECONDS || 30),
          preferUid: true
        })
      ]
    : []),
  asyncHandler(clientSubscriptionController.createOrReplaceClientSubscription as any)
);

// POST /api/clients/:clientId/subscription/modify
router.post(
  '/:clientId/subscription/modify',
  authenticateToken,
  requireConseiller,
  ...(process.env.IDEMPOTENCY_ENABLED === 'true'
    ? [
        idempotencyMiddleware({
          prefix: 'idem:api:clients:subscription:modify',
          ttlSeconds: Number(process.env.IDEMPOTENCY_TTL_SECONDS || 24 * 3600),
          inFlightTtlSeconds: Number(process.env.IDEMPOTENCY_INFLIGHT_TTL_SECONDS || 30),
          preferUid: true
        })
      ]
    : []),
  asyncHandler(clientSubscriptionController.modifyClientSubscription as any)
);

// PATCH /api/clients/:clientId/subscription/admin/membership (Firestore only)
router.patch(
  '/:clientId/subscription/admin/membership',
  authenticateToken,
  requireConseiller,
  ...(process.env.IDEMPOTENCY_ENABLED === 'true'
    ? [
        idempotencyMiddleware({
          prefix: 'idem:api:clients:subscription:admin:membership',
          ttlSeconds: Number(process.env.IDEMPOTENCY_TTL_SECONDS || 24 * 3600),
          inFlightTtlSeconds: Number(process.env.IDEMPOTENCY_INFLIGHT_TTL_SECONDS || 30),
          preferUid: true
        })
      ]
    : []),
  asyncHandler(clientSubscriptionController.adminPatchSubscriptionMembershipFirestoreOnly as any)
);

// PATCH /api/clients/:clientId/subscription/admin/payme/price (PayMe set-price only)
router.patch(
  '/:clientId/subscription/admin/payme/price',
  authenticateToken,
  requireConseiller,
  ...(process.env.IDEMPOTENCY_ENABLED === 'true'
    ? [
        idempotencyMiddleware({
          prefix: 'idem:api:clients:subscription:admin:payme:price',
          ttlSeconds: Number(process.env.IDEMPOTENCY_TTL_SECONDS || 24 * 3600),
          inFlightTtlSeconds: Number(process.env.IDEMPOTENCY_INFLIGHT_TTL_SECONDS || 30),
          preferUid: true
        })
      ]
    : []),
  asyncHandler(clientSubscriptionController.adminSetPaymeSubscriptionPriceOnly as any)
);

// PATCH /api/clients/:clientId/subscription/admin/membership-and-payme-price (Firestore membership + PayMe set-price)
router.patch(
  '/:clientId/subscription/admin/membership-and-payme-price',
  authenticateToken,
  requireConseiller,
  ...(process.env.IDEMPOTENCY_ENABLED === 'true'
    ? [
        idempotencyMiddleware({
          prefix: 'idem:api:clients:subscription:admin:membership-and-payme-price',
          ttlSeconds: Number(process.env.IDEMPOTENCY_TTL_SECONDS || 24 * 3600),
          inFlightTtlSeconds: Number(process.env.IDEMPOTENCY_INFLIGHT_TTL_SECONDS || 30),
          preferUid: true
        })
      ]
    : []),
  asyncHandler(clientSubscriptionController.adminPatchMembershipAndSetPaymePrice as any)
);

// PATCH /api/clients/:clientId/subscription/admin/membership-and-payme-description (Firestore membership + PayMe description)
router.patch(
  '/:clientId/subscription/admin/membership-and-payme-description',
  authenticateToken,
  requireConseiller,
  ...(process.env.IDEMPOTENCY_ENABLED === 'true'
    ? [
        idempotencyMiddleware({
          prefix: 'idem:api:clients:subscription:admin:membership-and-payme-description',
          ttlSeconds: Number(process.env.IDEMPOTENCY_TTL_SECONDS || 24 * 3600),
          inFlightTtlSeconds: Number(process.env.IDEMPOTENCY_INFLIGHT_TTL_SECONDS || 30),
          preferUid: true
        })
      ]
    : []),
  asyncHandler(clientSubscriptionController.adminPatchMembershipAndSetPaymeDescription as any)
);

// POST /api/clients/:clientId/subscription/pause|resume|cancel
router.post(
  '/:clientId/subscription/pause',
  authenticateToken,
  requireConseiller,
  asyncHandler(clientSubscriptionController.pauseClientSubscription as any)
);
router.post(
  '/:clientId/subscription/resume',
  authenticateToken,
  requireConseiller,
  asyncHandler(clientSubscriptionController.resumeClientSubscription as any)
);
router.post(
  '/:clientId/subscription/cancel',
  authenticateToken,
  requireConseiller,
  asyncHandler(clientSubscriptionController.cancelClientSubscription as any)
);

// POST /api/clients/:clientId/payment-credentials/subscription-card
router.post(
  '/:clientId/payment-credentials/subscription-card',
  authenticateToken,
  requireConseiller,
  asyncHandler(clientSubscriptionController.setClientSubscriptionCard as any)
);

// POST /api/clients/:clientId/sales
router.post(
  '/:clientId/sales',
  authenticateToken,
  requireConseiller,
  ...(process.env.IDEMPOTENCY_ENABLED === 'true'
    ? [
        idempotencyMiddleware({
          prefix: 'idem:api:clients:sales:create',
          ttlSeconds: Number(process.env.IDEMPOTENCY_TTL_SECONDS || 24 * 3600),
          inFlightTtlSeconds: Number(process.env.IDEMPOTENCY_INFLIGHT_TTL_SECONDS || 30),
          preferUid: true
        })
      ]
    : []),
  asyncHandler(clientSubscriptionController.createClientCustomSale as any)
);

// POST /api/clients/:clientId/sales/hosted (PayMe hosted page for one-time custom sale)
router.post(
  '/:clientId/sales/hosted',
  authenticateToken,
  requireConseiller,
  ...(process.env.IDEMPOTENCY_ENABLED === 'true'
    ? [
        idempotencyMiddleware({
          prefix: 'idem:api:clients:sales:hosted',
          ttlSeconds: Number(process.env.IDEMPOTENCY_TTL_SECONDS || 24 * 3600),
          inFlightTtlSeconds: Number(process.env.IDEMPOTENCY_INFLIGHT_TTL_SECONDS || 30),
          preferUid: true
        })
      ]
    : []),
  asyncHandler(clientSubscriptionController.createCustomSaleHosted as any)
);

// PATCH /api/clients/:clientId/free-access (toggle free access)
router.patch(
  '/:clientId/free-access',
  authenticateToken,
  requireConseiller,
  asyncHandler(clientSubscriptionController.toggleClientFreeAccess as any)
);

export default router;


