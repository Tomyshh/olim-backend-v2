import { Router } from 'express';
import * as tipsController from '../controllers/tips.controller.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.middleware.js';

const router = Router();

// Tips (optionalAuth)
router.get('/tips', optionalAuth, tipsController.getTips);
router.get('/tips/pinned', optionalAuth, tipsController.getPinnedTips);
router.post('/tips/:tipId/view', optionalAuth, tipsController.incrementTipView);

// Tips - auth required
router.post('/tips/:tipId/like', authenticateToken, tipsController.likeTip);
router.delete('/tips/:tipId/like', authenticateToken, tipsController.unlikeTip);
router.get('/tips/saved', authenticateToken, tipsController.getSavedTips);
router.post('/tips/:tipId/save', authenticateToken, tipsController.saveTip);
router.delete('/tips/:tipId/save', authenticateToken, tipsController.unsaveTip);

// News (optionalAuth)
router.get('/news', optionalAuth, tipsController.getNews);
router.get('/news/breaking', optionalAuth, tipsController.getBreakingNews);

export default router;
