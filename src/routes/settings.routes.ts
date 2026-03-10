import { Router } from 'express';
import * as settingsController from '../controllers/settings.controller.js';
import { authenticateToken } from '../middleware/auth.middleware.js';

const router = Router();

router.use(authenticateToken);

router.get('/preferences', settingsController.getPreferences);
router.patch('/preferences', settingsController.updatePreferences);
router.patch('/language', settingsController.updateLanguage);

export default router;
