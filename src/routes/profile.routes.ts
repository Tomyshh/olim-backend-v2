import { Router } from 'express';
import * as profileController from '../controllers/profile.controller.js';
import { authenticateToken } from '../middleware/auth.middleware.js';

const router = Router();

// Toutes les routes nécessitent une authentification
router.use(authenticateToken);

// Lecture profil
router.get('/', profileController.getProfile);

// Mise à jour profil
router.patch('/', profileController.updateProfile);

// Vérifier si profil complet
router.get('/complete', profileController.checkProfileComplete);

// Mise à jour langue
router.patch('/language', profileController.updateLanguage);

// Gestion membres famille
router.get('/family-members', profileController.getFamilyMembers);
router.post('/family-members', profileController.addFamilyMember);
router.patch('/family-members/:memberId', profileController.updateFamilyMember);
router.delete('/family-members/:memberId', profileController.deleteFamilyMember);

// Adresses
router.get('/addresses', profileController.getAddresses);
router.post('/addresses', profileController.addAddress);
router.patch('/addresses/:addressId', profileController.updateAddress);
router.delete('/addresses/:addressId', profileController.deleteAddress);

export default router;

