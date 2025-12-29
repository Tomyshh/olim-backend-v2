import { Router } from 'express';
import {
  v1SendLoginOtp,
  v1VerifyLoginOtp,
  v1VerifyVisitorOtp
} from '../../controllers/v1/phoneOtp.controller.js';

const router = Router();

router.post('/auth/phone/otp/send', v1SendLoginOtp);
router.post('/auth/phone/otp/verify', v1VerifyLoginOtp);
router.post('/auth/visitor/phone/otp/verify', v1VerifyVisitorOtp);

export default router;


