import { Router } from 'express';
import {
  v1SendLoginOtp,
  v1VerifyLoginOtp,
  v1VerifyVisitorOtp
} from '../../controllers/v1/phoneOtp.controller.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';

const router = Router();

router.post('/auth/phone/otp/send', asyncHandler(v1SendLoginOtp as any));
router.post('/auth/phone/otp/verify', asyncHandler(v1VerifyLoginOtp as any));
router.post('/auth/visitor/phone/otp/verify', asyncHandler(v1VerifyVisitorOtp as any));

export default router;


