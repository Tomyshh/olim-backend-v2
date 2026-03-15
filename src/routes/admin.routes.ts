import { Router } from 'express';
import * as adminController from '../controllers/admin.controller.js';
import * as adminCrmController from '../controllers/adminCrm.controller.js';
import { authenticateToken } from '../middleware/auth.middleware.js';
import { requireAdmin, requireConseiller } from '../middleware/conseiller.middleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

router.use(authenticateToken);

// ══════════════════════════════════════════════════════════════════════
// Admin-only routes (require is_admin = true)
// ══════════════════════════════════════════════════════════════════════

router.get('/refund-requests', requireAdmin, adminController.getRefundRequests);
router.patch('/refund-requests/:refundId', requireAdmin, adminController.updateRefundRequest);

router.get('/system-alerts', requireAdmin, adminController.getSystemAlerts);
router.post('/system-alerts', requireAdmin, adminController.createSystemAlert);

router.post('/sync-supabase', requireAdmin, adminController.syncFirestoreToSupabaseManual);
router.post('/fcm/generate-token', requireAdmin, adminController.generateFCMAccessToken);

router.get('/remote-config', requireAdmin, adminController.getRemoteConfig);
router.put('/remote-config', requireAdmin, adminController.publishRemoteConfig);

router.post('/firebase-auth/users', requireAdmin, adminController.createFirebaseAuthUser);

// ══════════════════════════════════════════════════════════════════════
// CRM routes (require any conseiller — role-based access handled by frontend)
// ══════════════════════════════════════════════════════════════════════

// ─── CRM: Clients ────────────────────────────────────────────────────

router.get('/clients', requireConseiller, asyncHandler(adminCrmController.listClients as any));
router.get('/clients/:clientId', requireConseiller, asyncHandler(adminCrmController.getClient as any));
router.patch('/clients/:clientId', requireConseiller, asyncHandler(adminCrmController.updateClient as any));
router.delete('/clients/:clientId', requireAdmin, asyncHandler(adminCrmController.deleteClient as any));

// ─── CRM: Requests (admin all-clients view) ──────────────────────────

router.get('/requests', requireConseiller, asyncHandler(adminCrmController.listRequests as any));
router.post('/requests', requireConseiller, asyncHandler(adminCrmController.createRequest as any));
router.get('/requests/:requestId', requireConseiller, asyncHandler(adminCrmController.getRequest as any));
router.patch('/requests/:requestId', requireConseiller, asyncHandler(adminCrmController.updateRequest as any));

// ─── CRM: Conseillers ────────────────────────────────────────────────

router.get('/conseillers', requireConseiller, asyncHandler(adminCrmController.listConseillers as any));
router.get('/conseillers/:conseillerId', requireConseiller, asyncHandler(adminCrmController.getConseiller as any));
router.patch('/conseillers/:conseillerId', requireAdmin, asyncHandler(adminCrmController.updateConseiller as any));

// ─── CRM: Client sub-resources ──────────────────────────────────────

router.get('/clients/:clientId/requests', requireConseiller, asyncHandler(adminCrmController.getClientRequests as any));
router.get('/clients/:clientId/subscription-events', requireConseiller, asyncHandler(adminCrmController.getClientSubscriptionEvents as any));

// ─── CRM: Dashboard Stats ───────────────────────────────────────────

router.get('/stats/overview', requireConseiller, asyncHandler(adminCrmController.getOverviewStats as any));
router.get('/stats/subscriptions', requireConseiller, asyncHandler(adminCrmController.getSubscriptionStats as any));
router.get('/stats/requests', requireConseiller, asyncHandler(adminCrmController.getRequestStats as any));
router.get('/stats/source-analysis', requireConseiller, asyncHandler(adminCrmController.getSourceAnalysis as any));
router.get('/stats/adviser-analysis', requireConseiller, asyncHandler(adminCrmController.getAdviserAnalysis as any));
router.get('/stats/membership-analysis', requireConseiller, asyncHandler(adminCrmController.getMembershipAnalysis as any));

// ─── CRM: Promotions ────────────────────────────────────────────────

router.get('/promotions', requireConseiller, asyncHandler(adminCrmController.listPromotions as any));
router.post('/promotions', requireAdmin, asyncHandler(adminCrmController.createPromotion as any));
router.patch('/promotions/:promoId', requireAdmin, asyncHandler(adminCrmController.updatePromotion as any));
router.delete('/promotions/:promoId', requireAdmin, asyncHandler(adminCrmController.deletePromotion as any));

// ─── CRM: Advertisements ────────────────────────────────────────────

router.get('/advertisements', requireConseiller, asyncHandler(adminCrmController.listAdvertisements as any));
router.post('/advertisements', requireAdmin, asyncHandler(adminCrmController.createAdvertisement as any));
router.patch('/advertisements/:adId', requireAdmin, asyncHandler(adminCrmController.updateAdvertisement as any));
router.delete('/advertisements/:adId', requireAdmin, asyncHandler(adminCrmController.deleteAdvertisement as any));

// ─── CRM: Tips ───────────────────────────────────────────────────────

router.get('/tips', requireConseiller, asyncHandler(adminCrmController.listTips as any));
router.post('/tips', requireAdmin, asyncHandler(adminCrmController.createTip as any));
router.patch('/tips/:tipId', requireAdmin, asyncHandler(adminCrmController.updateTip as any));
router.delete('/tips/:tipId', requireAdmin, asyncHandler(adminCrmController.deleteTip as any));

export default router;
