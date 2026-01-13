import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.middleware.js';
import { requireSuperAdmin } from '../../middleware/conseiller.middleware.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { v1AdminSetConseillerPasswordByEmail } from '../../controllers/v1/admin.conseillers.controller.js';

const router = Router();

router.post(
  '/admin/conseillers/password/by-email',
  authenticateToken,
  requireSuperAdmin,
  asyncHandler(v1AdminSetConseillerPasswordByEmail as any)
);

export default router;


