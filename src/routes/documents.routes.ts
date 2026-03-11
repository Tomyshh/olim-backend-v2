import { Router } from 'express';
import multer from 'multer';
import * as documentsController from '../controllers/documents.controller.js';
import { authenticateToken } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

router.use(authenticateToken);

router.get('/types', asyncHandler(documentsController.getDocumentTypes as any));
router.get('/', asyncHandler(documentsController.getDocuments as any));
router.get('/personal', asyncHandler(documentsController.getPersonalDocuments as any));
router.get('/family-member/:memberId', asyncHandler(documentsController.getFamilyMemberDocuments as any));

router.post('/save', asyncHandler(documentsController.saveDocumentMetadata as any));
router.post('/backfill', asyncHandler(documentsController.backfillDocumentRelations as any));
router.post('/personal/upload', upload.array('files'), asyncHandler(documentsController.uploadPersonalDocument as any));
router.post('/family-member/:memberId/upload', upload.array('files'), asyncHandler(documentsController.uploadFamilyMemberDocument as any));

router.get('/:documentId/download', asyncHandler(documentsController.downloadDocument as any));
router.patch('/:documentId', asyncHandler(documentsController.updateDocument as any));
router.delete('/:documentId', asyncHandler(documentsController.deleteDocument as any));

export default router;
