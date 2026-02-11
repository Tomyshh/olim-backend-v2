import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.middleware.js';
import { requireAdmin } from '../../middleware/conseiller.middleware.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import {
  v1AdminCreateFamilyMemberAdultFree,
  v1AdminCreateFamilyMemberAdultPaid,
  v1AdminCreateFamilyMemberChild,
  v1AdminCreateFamilyMemberConjointFree,
  v1AdminDeactivateFamilyMember,
  v1AdminActivateFamilyMemberFree,
  v1AdminActivateFamilyMemberPaid,
  v1AdminEditFamilyMember,
  v1AdminDeleteFamilyMember
} from '../../controllers/v1/familyMembers.controller.js';

const router = Router();

// Admin/Conseiller (isAdmin) : gestion famille pour un client cible
router.post(
  '/admin/clients/:uid/family/members/adult/free',
  authenticateToken,
  requireAdmin,
  asyncHandler(v1AdminCreateFamilyMemberAdultFree as any)
);
router.post(
  '/admin/clients/:uid/family/members/adult/paid',
  authenticateToken,
  requireAdmin,
  asyncHandler(v1AdminCreateFamilyMemberAdultPaid as any)
);
router.post(
  '/admin/clients/:uid/family/members/child',
  authenticateToken,
  requireAdmin,
  asyncHandler(v1AdminCreateFamilyMemberChild as any)
);
router.post(
  '/admin/clients/:uid/family/members/conjoint',
  authenticateToken,
  requireAdmin,
  asyncHandler(v1AdminCreateFamilyMemberConjointFree as any)
);

router.post(
  '/admin/clients/:uid/family/members/:id/deactivate',
  authenticateToken,
  requireAdmin,
  asyncHandler(v1AdminDeactivateFamilyMember as any)
);
router.post(
  '/admin/clients/:uid/family/members/:id/activate/free',
  authenticateToken,
  requireAdmin,
  asyncHandler(v1AdminActivateFamilyMemberFree as any)
);
router.post(
  '/admin/clients/:uid/family/members/:id/activate/paid',
  authenticateToken,
  requireAdmin,
  asyncHandler(v1AdminActivateFamilyMemberPaid as any)
);

// Édition métier complète d'un membre
router.patch(
  '/admin/clients/:uid/family/members/:id',
  authenticateToken,
  requireAdmin,
  asyncHandler(v1AdminEditFamilyMember as any)
);

// Suppression d'un membre (avec protection membre actif)
router.delete(
  '/admin/clients/:uid/family/members/:id',
  authenticateToken,
  requireAdmin,
  asyncHandler(v1AdminDeleteFamilyMember as any)
);

export default router;


