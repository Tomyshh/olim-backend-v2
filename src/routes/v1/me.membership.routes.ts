import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { v1GetMeMembership } from '../../controllers/v1/membership.controller.js';

const router = Router();

router.get('/me/membership', authenticateToken, asyncHandler(v1GetMeMembership as any));

export default router;


