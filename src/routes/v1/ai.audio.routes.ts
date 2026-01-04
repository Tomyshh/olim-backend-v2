import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { v1AudioTranscription } from '../../controllers/v1/ai.audio.controller.js';

const router = Router();

// POST /v1/ai/audio/transcriptions
// Auth: obligatoire (Bearer firebase_id_token)
router.post('/ai/audio/transcriptions', authenticateToken, asyncHandler(v1AudioTranscription as any));

export default router;


