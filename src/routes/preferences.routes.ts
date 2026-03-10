import { Router } from 'express';
import * as preferencesController from '../controllers/preferences.controller.js';
import { authenticateToken } from '../middleware/auth.middleware.js';

const router = Router();

router.use(authenticateToken);

router.get('/favorites', preferencesController.getFavorites);
router.post('/favorites/:categoryId', preferencesController.addFavorite);
router.delete('/favorites/:categoryId', preferencesController.removeFavorite);
router.get('/recent', preferencesController.getRecent);
router.post('/recent/:subCategoryId', preferencesController.recordUsage);

export default router;
