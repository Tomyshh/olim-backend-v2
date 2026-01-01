import express from 'express';
import { authenticateToken } from '../middleware/auth.middleware.js';
import { requireConseiller } from '../middleware/conseiller.middleware.js';
import { messageEnhance } from '../controllers/ai.controller.js';

const router = express.Router();

/**
 * POST /api/ai/message-enhance
 * Auth: Authorization: Bearer <firebase_id_token>
 * Optionnel (recommandé): uniquement conseillers (Conseillers2/{uid})
 */
router.post('/message-enhance', authenticateToken, requireConseiller, messageEnhance);

export default router;


