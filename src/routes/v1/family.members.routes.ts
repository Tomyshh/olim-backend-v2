import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import {
  v1CreateFamilyMember,
  v1UpdateFamilyMember,
  v1DeactivateFamilyMember,
  v1ActivateFamilyMember,
  v1ActivateFamilyMemberService,
  v1DeleteFamilyMember
} from '../../controllers/v1/familyMembers.controller.js';

const router = Router();

router.post('/family/members', authenticateToken, asyncHandler(v1CreateFamilyMember as any));
router.patch('/family/members/:id', authenticateToken, asyncHandler(v1UpdateFamilyMember as any));
router.post('/family/members/:id/deactivate', authenticateToken, asyncHandler(v1DeactivateFamilyMember as any));
router.post('/family/members/:id/activate', authenticateToken, asyncHandler(v1ActivateFamilyMember as any));
router.post('/family/members/:id/service/activate', authenticateToken, asyncHandler(v1ActivateFamilyMemberService as any));
router.delete('/family/members/:id', authenticateToken, asyncHandler(v1DeleteFamilyMember as any));
// Tolérance (certains frontends peuvent ne pas pouvoir faire DELETE facilement)
router.post('/family/members/:id/delete', authenticateToken, asyncHandler(v1DeleteFamilyMember as any));

export default router;


