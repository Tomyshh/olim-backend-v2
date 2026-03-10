import { Router } from 'express';
import * as requestsController from '../controllers/requests.controller.js';
import { authenticateToken } from '../middleware/auth.middleware.js';
import { idempotencyMiddleware } from '../middleware/idempotency.middleware.js';
import { requireActiveMembershipForRequests } from '../middleware/requireActiveMembershipForRequests.middleware.js';

const router = Router();

// Toutes les routes nécessitent une authentification
router.use(authenticateToken);

// Liste des demandes
router.get('/', requestsController.getRequests);

// Règle d'assignation conseiller (sans créer de demande)
router.get('/conseiller', requestsController.getConseiller);

// Détails d'une demande
router.get('/:requestId', requestsController.getRequestDetail);

// Création d'une demande
router.post(
  '/',
  requireActiveMembershipForRequests,
  ...(process.env.IDEMPOTENCY_ENABLED === 'true'
    ? [
        idempotencyMiddleware({
          prefix: 'idem:api:requests:create',
          ttlSeconds: Number(process.env.IDEMPOTENCY_TTL_SECONDS || 24 * 3600),
          inFlightTtlSeconds: Number(process.env.IDEMPOTENCY_INFLIGHT_TTL_SECONDS || 30),
          preferUid: true
        })
      ]
    : []),
  requestsController.createRequest
);

// Mise à jour d'une demande
router.patch('/:requestId', requestsController.updateRequest);

// Suppression d'une demande
router.delete('/:requestId', requestsController.deleteRequest);

// Upload fichiers pour une demande
router.post('/:requestId/files', requestsController.uploadRequestFiles);

// Assignation conseiller
router.patch('/:requestId/assign', requestsController.assignAdvisor);

// Rating d'une demande
router.post('/:requestId/rating', requestsController.rateRequest);

// Favoris
router.get('/favorites/list', requestsController.getFavoriteRequests);
router.post('/favorites/:requestId', requestsController.addFavoriteRequest);
router.delete('/favorites/:requestId', requestsController.removeFavoriteRequest);

export default router;

