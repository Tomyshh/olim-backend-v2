import { Router } from 'express';
import * as profileController from '../controllers/profile.controller.js';
import * as accesController from '../controllers/acces.controller.js';
import { authenticateToken } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

router.use(authenticateToken);

router.get('/', profileController.getProfile);
router.patch('/', profileController.updateProfile);
router.get('/complete', profileController.checkProfileComplete);
router.patch('/language', profileController.updateLanguage);

router.get('/family-members', profileController.getFamilyMembers);
router.post('/family-members', profileController.addFamilyMember);
router.patch('/family-members/:memberId', profileController.updateFamilyMember);
router.delete('/family-members/:memberId', profileController.deleteFamilyMember);

router.get('/addresses', profileController.getAddresses);
router.post('/addresses', profileController.addAddress);
router.patch('/addresses/:addressId', profileController.updateAddress);
router.delete('/addresses/:addressId', profileController.deleteAddress);

router.get('/acces', asyncHandler(accesController.getAcces as any));
router.post('/acces', asyncHandler(accesController.addAcces as any));
router.delete('/acces/:accesId', asyncHandler(accesController.deleteAcces as any));

router.get('/logs', asyncHandler(accesController.getLogs as any));
router.post('/logs', asyncHandler(accesController.createLog as any));

export default router;

