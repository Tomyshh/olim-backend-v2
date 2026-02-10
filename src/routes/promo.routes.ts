import { Router } from 'express';
import * as promoController from '../controllers/promo.controller.js';
import { authenticateToken } from '../middleware/auth.middleware.js';

const router = Router();

// Toutes les routes nécessitent une authentification
router.use(authenticateToken);

// Validation d'un code promo
router.post('/validate', promoController.validatePromoCode);

export default router;
