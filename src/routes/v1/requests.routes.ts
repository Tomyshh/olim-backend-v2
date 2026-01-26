import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { idempotencyMiddleware } from '../../middleware/idempotency.middleware.js';
import { v1CreateRequest } from '../../controllers/v1/requests.controller.js';

const router = Router();

function copyIdempotencyKeyFromBody(req: any, _res: any, next: any) {
  const hasHeader = typeof req.headers?.['idempotency-key'] === 'string' || typeof req.headers?.['Idempotency-Key'] === 'string';
  const fromBody = String(req.body?.idempotencyKey || '').trim();
  if (!hasHeader && fromBody) {
    req.headers['idempotency-key'] = fromBody;
  }
  next();
}

// POST /v1/requests
// Auth: Bearer Firebase token
// Idempotency: header Idempotency-Key (ou body.idempotencyKey)
router.post(
  '/requests',
  authenticateToken,
  copyIdempotencyKeyFromBody,
  idempotencyMiddleware({ prefix: 'idem:v1:requests:create', ttlSeconds: 60 * 60 * 24 * 7, inFlightTtlSeconds: 30, preferUid: true }),
  asyncHandler(v1CreateRequest as any)
);

export default router;

