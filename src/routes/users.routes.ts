import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { idempotencyMiddleware } from '../middleware/idempotency.middleware.js';
import { initUser } from '../controllers/users.controller.js';

const router = Router();

// POST /users/init
router.post(
  '/init',
  authenticateToken,
  ...(process.env.IDEMPOTENCY_ENABLED === 'true'
    ? [
        idempotencyMiddleware({
          prefix: 'idem:users:init',
          ttlSeconds: Number(process.env.IDEMPOTENCY_TTL_SECONDS || 24 * 3600),
          inFlightTtlSeconds: Number(process.env.IDEMPOTENCY_INFLIGHT_TTL_SECONDS || 30),
          preferUid: true
        })
      ]
    : []),
  asyncHandler(initUser as any)
);

export default router;


