import { Router } from 'express';
import * as adminController from '../controllers/admin.controller.js';
import * as adminCrmController from '../controllers/adminCrm.controller.js';
import { authenticateToken } from '../middleware/auth.middleware.js';
import { requireAdmin } from '../middleware/conseiller.middleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

router.use(authenticateToken);
router.use(requireAdmin);

// ─── Existing admin routes ────────────────────────────────────────────

router.get('/refund-requests', adminController.getRefundRequests);
router.patch('/refund-requests/:refundId', adminController.updateRefundRequest);

router.get('/system-alerts', adminController.getSystemAlerts);
router.post('/system-alerts', adminController.createSystemAlert);

router.post('/sync-supabase', adminController.syncFirestoreToSupabaseManual);
router.post('/fcm/generate-token', adminController.generateFCMAccessToken);

router.get('/remote-config', adminController.getRemoteConfig);
router.put('/remote-config', adminController.publishRemoteConfig);

router.post('/firebase-auth/users', adminController.createFirebaseAuthUser);

// ─── CRM: Clients ────────────────────────────────────────────────────

router.get('/clients', asyncHandler(adminCrmController.listClients as any));
router.get('/clients/:clientId', asyncHandler(adminCrmController.getClient as any));
router.patch('/clients/:clientId', asyncHandler(adminCrmController.updateClient as any));
router.delete('/clients/:clientId', asyncHandler(adminCrmController.deleteClient as any));

// ─── CRM: Requests (admin all-clients view) ──────────────────────────

router.get('/requests', asyncHandler(adminCrmController.listRequests as any));

// ─── CRM: Conseillers ────────────────────────────────────────────────

router.get('/conseillers', asyncHandler(adminCrmController.listConseillers as any));
router.get('/conseillers/:conseillerId', asyncHandler(adminCrmController.getConseiller as any));
router.patch('/conseillers/:conseillerId', asyncHandler(adminCrmController.updateConseiller as any));

// ─── CRM: Dashboard Stats ───────────────────────────────────────────

router.get('/stats/overview', asyncHandler(adminCrmController.getOverviewStats as any));
router.get('/stats/subscriptions', asyncHandler(adminCrmController.getSubscriptionStats as any));

// ─── CRM: Promotions ────────────────────────────────────────────────

router.get('/promotions', asyncHandler(adminCrmController.listPromotions as any));
router.post('/promotions', asyncHandler(adminCrmController.createPromotion as any));
router.patch('/promotions/:promoId', asyncHandler(adminCrmController.updatePromotion as any));
router.delete('/promotions/:promoId', asyncHandler(adminCrmController.deletePromotion as any));

// ─── CRM: Advertisements ────────────────────────────────────────────

router.get('/advertisements', asyncHandler(adminCrmController.listAdvertisements as any));
router.post('/advertisements', asyncHandler(adminCrmController.createAdvertisement as any));
router.patch('/advertisements/:adId', asyncHandler(adminCrmController.updateAdvertisement as any));
router.delete('/advertisements/:adId', asyncHandler(adminCrmController.deleteAdvertisement as any));

// ─── CRM: Tips ───────────────────────────────────────────────────────

router.get('/tips', asyncHandler(adminCrmController.listTips as any));
router.post('/tips', asyncHandler(adminCrmController.createTip as any));
router.patch('/tips/:tipId', asyncHandler(adminCrmController.updateTip as any));
router.delete('/tips/:tipId', asyncHandler(adminCrmController.deleteTip as any));

export default router;

