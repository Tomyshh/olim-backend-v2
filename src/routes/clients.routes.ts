import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.middleware.js';
import { requireConseiller } from '../middleware/conseiller.middleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { idempotencyMiddleware } from '../middleware/idempotency.middleware.js';
import * as clientsController from '../controllers/clients.controller.js';

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

export default router;


