import { Router } from 'express';
import * as accountController from '../controllers/account.controller.js';
import { authenticateToken } from '../middleware/auth.middleware.js';

const router = Router();

router.use(authenticateToken);

router.get('/export', accountController.exportUserData);
router.delete('/', accountController.deleteAccount);
router.post('/device', accountController.registerDevice);
router.delete('/device', accountController.removeDevice);
router.delete('/notification-token', accountController.removeNotificationToken);

export default router;
