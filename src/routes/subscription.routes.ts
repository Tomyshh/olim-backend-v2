import { Router } from 'express';
import * as subscriptionController from '../controllers/subscription.controller.js';
import { authenticateToken } from '../middleware/auth.middleware.js';

const router = Router();

// Toutes les routes nécessitent une authentification
router.use(authenticateToken);

// État de l'abonnement
router.get('/status', subscriptionController.getSubscriptionStatus);

// Cartes de paiement
router.get('/cards', subscriptionController.getCards);
router.post('/cards', subscriptionController.addCard);
router.patch('/cards/:cardId', subscriptionController.updateCard);
router.delete('/cards/:cardId', subscriptionController.deleteCard);
router.patch('/cards/:cardId/set-default', subscriptionController.setDefaultCard);

// Factures
router.get('/invoices', subscriptionController.getInvoices);
router.get('/invoices/:invoiceId', subscriptionController.getInvoiceDetail);

// Demandes de remboursement
router.get('/refunds', subscriptionController.getRefundRequests);
router.post('/refunds', subscriptionController.createRefundRequest);
router.get('/refunds/:refundId', subscriptionController.getRefundRequestDetail);

export default router;

