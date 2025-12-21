import { Router } from 'express';
import * as authController from '../controllers/auth.controller.js';
import { authenticateToken } from '../middleware/auth.middleware.js';

const router = Router();

// OTP pour liaison/remplacement téléphone (utilisateur connecté)
router.post('/send-phone-otp', authenticateToken, authController.sendPhoneOtp);
router.post('/verify-phone-otp-and-link', authenticateToken, authController.verifyPhoneOtpAndLink);

// OTP pour login/inscription (sans auth)
router.post('/send-login-phone-otp', authController.sendLoginPhoneOtp);
router.post('/verify-login-phone-otp', authController.verifyLoginPhoneOtp);

// Création compte Visitor
router.post('/create-visitor-account', authController.createVisitorAccount);

// Login email/password (si nécessaire)
router.post('/login-email', authController.loginEmail);

export default router;

