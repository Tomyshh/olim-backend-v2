import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.middleware.js';
import * as conseillerController from '../controllers/conseiller.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

router.use(authenticateToken);

router.get('/me', asyncHandler(conseillerController.getMe as any));

export default router;
