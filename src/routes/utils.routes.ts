import { Router } from 'express';
import * as utilsController from '../controllers/utils.controller.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.middleware.js';

const router = Router();

router.get('/membership-details', optionalAuth, utilsController.getMembershipDetails);
router.get('/service-availability', optionalAuth, utilsController.getServiceAvailability);
router.get('/relationship-types', optionalAuth, utilsController.getRelationshipTypes);
router.get('/ai-key', authenticateToken, utilsController.getAiKey);

export default router;
