import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.middleware.js';
import { v1SendLinkPhoneOtp, v1VerifyLinkPhoneOtp } from '../../controllers/v1/phoneOtp.controller.js';

const router = Router();

router.post('/me/phone/otp/send', authenticateToken, v1SendLinkPhoneOtp);
router.post('/me/phone/otp/verify', authenticateToken, v1VerifyLinkPhoneOtp);

export default router;


