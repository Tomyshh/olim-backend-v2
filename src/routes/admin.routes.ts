import { Router } from 'express';
import * as adminController from '../controllers/admin.controller.js';
import { authenticateToken } from '../middleware/auth.middleware.js';
import { requireAdmin } from '../middleware/conseiller.middleware.js';

const router = Router();

// Toutes les routes nécessitent une authentification
router.use(authenticateToken);

// Routes admin: rôle admin requis
router.use(requireAdmin);

// Demandes de remboursement (admin)
router.get('/refund-requests', adminController.getRefundRequests);
router.patch('/refund-requests/:refundId', adminController.updateRefundRequest);

// Alertes système
router.get('/system-alerts', adminController.getSystemAlerts);
router.post('/system-alerts', adminController.createSystemAlert);

// Sync Supabase (manuel - désactivé pour l'instant)
router.post('/sync-supabase', adminController.syncFirestoreToSupabaseManual);

// Génération token FCM OAuth (désactivé pour l'instant)
router.post('/fcm/generate-token', adminController.generateFCMAccessToken);

// Remote Config (page Admin "Config")
router.get('/remote-config', adminController.getRemoteConfig);
router.put('/remote-config', adminController.publishRemoteConfig);

export default router;

