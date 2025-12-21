import { Router } from 'express';
import * as healthController from '../controllers/health.controller.js';
import { authenticateToken } from '../middleware/auth.middleware.js';

const router = Router();

// Toutes les routes nécessitent une authentification
router.use(authenticateToken);

// Liste des demandes santé
router.get('/requests', healthController.getHealthRequests);

// Détails d'une demande santé
router.get('/requests/:requestId', healthController.getHealthRequestDetail);

// Création d'une demande santé
router.post('/requests', healthController.createHealthRequest);

// Mise à jour d'une demande santé
router.patch('/requests/:requestId', healthController.updateHealthRequest);

// Configuration santé
router.get('/config', healthController.getHealthConfig);
router.patch('/config', healthController.updateHealthConfig);

export default router;

