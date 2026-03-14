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

// Login email/password (Supabase-first, customToken Firebase)
router.post('/login-email', asyncHandler(authController.loginEmail as any));
// Login Google/Apple via Supabase (idToken → Supabase session + customToken Firebase)
router.post('/login-google', asyncHandler(authController.loginGoogle as any));
router.post('/login-apple', asyncHandler(authController.loginApple as any));

// Supabase token refresh
router.post('/refresh', asyncHandler(authController.refreshToken as any));

// Password reset flow (Supabase OTP)
router.post('/forgot-password', asyncHandler(authController.forgotPassword as any));
router.post('/verify-reset-otp', asyncHandler(authController.verifyResetOtp as any));
router.post('/reset-password', asyncHandler(authController.resetPassword as any));

export default router;

