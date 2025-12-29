import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.middleware.js';
import { v1SendLinkPhoneOtp, v1VerifyLinkPhoneOtp } from '../../controllers/v1/phoneOtp.controller.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';

const router = Router();

router.post('/me/phone/otp/send', authenticateToken, asyncHandler(v1SendLinkPhoneOtp as any));
router.post('/me/phone/otp/verify', authenticateToken, asyncHandler(v1VerifyLinkPhoneOtp as any));

export default router;


