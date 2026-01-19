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

export default router;


