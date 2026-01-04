import { Router } from 'express';
import multer from 'multer';
import { authenticateToken } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { v1AudioTranscription } from '../../controllers/v1/ai.audio.controller.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB
});

// POST /v1/ai/audio/transcriptions
// Auth: obligatoire (Bearer firebase_id_token)
router.post(
  '/ai/audio/transcriptions',
  authenticateToken,
  upload.single('file'),
  asyncHandler(v1AudioTranscription as any)
);

// Mapper les erreurs multer au contrat (notamment 413)
router.use((err: any, req: any, res: any, next: any) => {
  const code = err?.code;
  const name = err?.name;

  if (code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ message: 'Fichier trop volumineux (max 25MB).' });
    return;
  }

  if (name === 'MulterError') {
    // Ex: "LIMIT_UNEXPECTED_FILE", etc.
    res.status(400).json({ message: 'Fichier audio invalide.' });
    return;
  }

  next(err);
});

export default router;


