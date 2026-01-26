import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import {
  v1RegistrationSessionStart,
  v1RegistrationStep,
  v1RegistrationError,
  v1RegistrationSessionComplete,
  v1VoiceRequests
} from '../../controllers/v1/analytics.controller.js';

const router = Router();

// Registration tracking
router.post('/analytics/registration/session/start', authenticateToken, asyncHandler(v1RegistrationSessionStart as any));
router.post('/analytics/registration/step', authenticateToken, asyncHandler(v1RegistrationStep as any));
router.post('/analytics/registration/error', authenticateToken, asyncHandler(v1RegistrationError as any));
router.post('/analytics/registration/session/complete', authenticateToken, asyncHandler(v1RegistrationSessionComplete as any));

// Voice requests analytics
router.post('/analytics/voice-requests', authenticateToken, asyncHandler(v1VoiceRequests as any));

export default router;

