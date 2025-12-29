import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.middleware.js';
import { v1SendGenericSms } from '../../controllers/v1/notificationsSms.controller.js';

const router = Router();

router.post('/notifications/sms', authenticateToken, v1SendGenericSms);

export default router;


