import { Router } from 'express';
import * as subscriptionController from '../controllers/subscription.controller.js';
import { authenticateToken } from '../middleware/auth.middleware.js';
import { idempotencyMiddleware } from '../middleware/idempotency.middleware.js';

const router = Router();

// Toutes les routes nécessitent une authentification
router.use(authenticateToken);

// État de l'abonnement
router.get('/status', subscriptionController.getSubscriptionStatus);

// Cartes de paiement
router.get('/cards', subscriptionController.getCards);
router.post(
  '/cards',
  ...(process.env.IDEMPOTENCY_ENABLED === 'true'
    ? [
        idempotencyMiddleware({
          prefix: 'idem:api:subscription:addCard',
          ttlSeconds: Number(process.env.IDEMPOTENCY_TTL_SECONDS || 24 * 3600),
          inFlightTtlSeconds: Number(process.env.IDEMPOTENCY_INFLIGHT_TTL_SECONDS || 30),
          preferUid: true
        })
      ]
    : []),
  subscriptionController.addCard
);

// Créer / (re)abonner un client existant (app mobile)
router.post(
  '/subscribe',
  ...(process.env.IDEMPOTENCY_ENABLED === 'true'
    ? [
        idempotencyMiddleware({
          prefix: 'idem:api:subscription:subscribe',
          ttlSeconds: Number(process.env.IDEMPOTENCY_TTL_SECONDS || 24 * 3600),
          inFlightTtlSeconds: Number(process.env.IDEMPOTENCY_INFLIGHT_TTL_SECONDS || 30),
          preferUid: true
        })
      ]
    : []),
  subscriptionController.subscribe
);

// Quote de changement d'abonnement (prorata) - app mobile
router.post(
  '/change/quote',
  ...(process.env.IDEMPOTENCY_ENABLED === 'true'
    ? [
        idempotencyMiddleware({
          prefix: 'idem:api:subscription:change:quote',
          ttlSeconds: Number(process.env.IDEMPOTENCY_TTL_SECONDS || 24 * 3600),
          inFlightTtlSeconds: Number(process.env.IDEMPOTENCY_INFLIGHT_TTL_SECONDS || 30),
          preferUid: true
        })
      ]
    : []),
  subscriptionController.quoteSubscriptionChange
);
router.patch('/cards/:cardId', subscriptionController.updateCard);
router.delete('/cards/:cardId', subscriptionController.deleteCard);
router.patch('/cards/:cardId/set-default', subscriptionController.setDefaultCard);

// Factures
router.get('/invoices', subscriptionController.getInvoices);
router.get('/invoices/:invoiceId', subscriptionController.getInvoiceDetail);

// Demandes de remboursement
router.get('/refunds', subscriptionController.getRefundRequests);
router.post(
  '/refunds',
  ...(process.env.IDEMPOTENCY_ENABLED === 'true'
    ? [
        idempotencyMiddleware({
          prefix: 'idem:api:subscription:createRefund',
          ttlSeconds: Number(process.env.IDEMPOTENCY_TTL_SECONDS || 24 * 3600),
          inFlightTtlSeconds: Number(process.env.IDEMPOTENCY_INFLIGHT_TTL_SECONDS || 30),
          preferUid: true
        })
      ]
    : []),
  subscriptionController.createRefundRequest
);
router.get('/refunds/:refundId', subscriptionController.getRefundRequestDetail);

export default router;

