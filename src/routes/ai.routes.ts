import express from 'express';
import { authenticateToken } from '../middleware/auth.middleware.js';
import { requireConseiller } from '../middleware/conseiller.middleware.js';
import { rateLimitMiddleware } from '../middleware/rateLimit.middleware.js';
import { messageEnhance } from '../controllers/ai.controller.js';

const router = express.Router();

/**
 * POST /api/ai/message-enhance
 * Auth: Authorization: Bearer <firebase_id_token>
 * Optionnel (recommandé): uniquement conseillers (Conseillers2/{uid})
 */
router.post(
  '/message-enhance',
  authenticateToken,
  requireConseiller,
  ...(process.env.ENDPOINT_RATE_LIMIT_ENABLED === 'true'
    ? [
        rateLimitMiddleware({
          prefix: 'rl:api:ai:messageEnhance:uid',
          limit: Number(process.env.AI_MESSAGE_ENHANCE_RATE_LIMIT_LIMIT || 60),
          windowSeconds: Number(process.env.AI_MESSAGE_ENHANCE_RATE_LIMIT_WINDOW_SECONDS || 60),
          preferUid: true,
          bypassOnError: true,
          message: 'Trop de requêtes.'
        })
      ]
    : []),
  messageEnhance
);

export default router;


