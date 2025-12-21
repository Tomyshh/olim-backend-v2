import { Router } from 'express';
import * as documentsController from '../controllers/documents.controller.js';
import { authenticateToken } from '../middleware/auth.middleware.js';

const router = Router();

// Toutes les routes nécessitent une authentification
router.use(authenticateToken);

// Liste des documents (personnels + membres)
router.get('/', documentsController.getDocuments);

// Documents personnels
router.get('/personal', documentsController.getPersonalDocuments);

// Documents d'un membre
router.get('/family-member/:memberId', documentsController.getFamilyMemberDocuments);

// Upload document personnel
router.post('/personal/upload', documentsController.uploadPersonalDocument);

// Upload document membre
router.post('/family-member/:memberId/upload', documentsController.uploadFamilyMemberDocument);

// Télécharger un document
router.get('/:documentId/download', documentsController.downloadDocument);

// Supprimer un document
router.delete('/:documentId', documentsController.deleteDocument);

export default router;

