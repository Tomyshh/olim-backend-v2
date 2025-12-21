import { Router } from 'express';
import * as partnersController from '../controllers/partners.controller.js';
import { optionalAuth } from '../middleware/auth.middleware.js';

const router = Router();

// Liste des partenaires (peut être public avec auth optionnelle)
router.get('/', optionalAuth, partnersController.getPartners);

// Détails d'un partenaire
router.get('/:partnerId', optionalAuth, partnersController.getPartnerDetail);

// Partenaires VIP
router.get('/vip/list', optionalAuth, partnersController.getVIPPartners);

export default router;

