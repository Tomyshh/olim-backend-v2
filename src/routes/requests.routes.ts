import { Router } from 'express';
import * as requestsController from '../controllers/requests.controller.js';
import { authenticateToken } from '../middleware/auth.middleware.js';

const router = Router();

// Toutes les routes nécessitent une authentification
router.use(authenticateToken);

// Liste des demandes
router.get('/', requestsController.getRequests);

// Détails d'une demande
router.get('/:requestId', requestsController.getRequestDetail);

// Création d'une demande
router.post('/', requestsController.createRequest);

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

