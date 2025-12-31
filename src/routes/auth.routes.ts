import { Router } from 'express';
import * as authController from '../controllers/auth.controller.js';
import { authenticateToken } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

// Vérifier session (token Firebase)
router.get('/session', authenticateToken, asyncHandler(authController.getSession as any));

// OTP pour liaison/remplacement téléphone (utilisateur connecté)
router.post('/send-phone-otp', authenticateToken, asyncHandler(authController.sendPhoneOtp as any));
router.post('/verify-phone-otp-and-link', authenticateToken, asyncHandler(authController.verifyPhoneOtpAndLink as any));

// OTP pour login/inscription (sans auth)
router.post('/send-login-phone-otp', asyncHandler(authController.sendLoginPhoneOtp as any));
router.post('/verify-login-phone-otp', asyncHandler(authController.verifyLoginPhoneOtp as any));

// Création compte Visitor
router.post('/create-visitor-account', asyncHandler(authController.createVisitorAccount as any));

// Déconnexion serveur (optionnel) : révoquer refresh tokens Firebase
router.post('/logout', authenticateToken, asyncHandler(authController.logout as any));

// Login email/password (si nécessaire)
router.post('/login-email', authController.loginEmail);

export default router;

