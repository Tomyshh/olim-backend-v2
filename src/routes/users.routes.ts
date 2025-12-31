import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { initUser } from '../controllers/users.controller.js';

const router = Router();

// POST /users/init
router.post('/init', authenticateToken, asyncHandler(initUser as any));

export default router;


