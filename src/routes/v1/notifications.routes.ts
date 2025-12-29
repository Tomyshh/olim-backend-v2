import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.middleware.js';
import { v1SendGenericSms } from '../../controllers/v1/notificationsSms.controller.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';

const router = Router();

router.post('/notifications/sms', authenticateToken, asyncHandler(v1SendGenericSms as any));

export default router;


