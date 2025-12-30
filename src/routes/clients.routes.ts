import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.middleware.js';
import { requireConseiller } from '../middleware/conseiller.middleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as clientsController from '../controllers/clients.controller.js';

const router = Router();

// POST /api/clients
router.post('/', authenticateToken, requireConseiller, asyncHandler(clientsController.createClient as any));

// POST /api/clients/:clientId/payment-credentials/credit-card
router.post(
  '/:clientId/payment-credentials/credit-card',
  authenticateToken,
  requireConseiller,
  asyncHandler(clientsController.addClientCreditCardPaymentCredential as any)
);

export default router;


