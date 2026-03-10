import { Router } from 'express';
import multer from 'multer';
import { authenticateToken } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { v1UploadRequestFiles, v1UploadDocumentFiles, v1UploadProfilePhoto } from '../../controllers/v1/uploads.controller.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024 // 25MB par fichier
  }
});

// POST /v1/uploads/requests
// multipart/form-data: files[]
router.post('/uploads/requests', authenticateToken, upload.array('files'), asyncHandler(v1UploadRequestFiles as any));

// POST /v1/uploads/documents
router.post('/uploads/documents', authenticateToken, upload.array('files'), asyncHandler(v1UploadDocumentFiles as any));

// POST /v1/uploads/profile-photo
router.post('/uploads/profile-photo', authenticateToken, upload.single('files'), asyncHandler(v1UploadProfilePhoto as any));

export default router;

