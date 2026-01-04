import { Router } from 'express';
import {
  v1SendLoginOtp,
  v1VerifyLoginOtp,
  v1VerifyVisitorOtp
} from '../../controllers/v1/phoneOtp.controller.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { rateLimitMiddleware } from '../../middleware/rateLimit.middleware.js';

const router = Router();

const endpointRlEnabled = process.env.ENDPOINT_RATE_LIMIT_ENABLED === 'true';

router.post(
  '/auth/phone/otp/send',
  ...(endpointRlEnabled
    ? [
        rateLimitMiddleware({
          prefix: 'rl:v1:otp:send:ip',
          limit: Number(process.env.OTP_SEND_IP_RATE_LIMIT_LIMIT || 60),
          windowSeconds: Number(process.env.OTP_SEND_IP_RATE_LIMIT_WINDOW_SECONDS || 60),
          preferUid: false,
          bypassOnError: true,
          message: 'Trop de demandes. Veuillez réessayer plus tard.'
        })
      ]
    : []),
  asyncHandler(v1SendLoginOtp as any)
);
router.post(
  '/auth/phone/otp/verify',
  ...(endpointRlEnabled
    ? [
        rateLimitMiddleware({
          prefix: 'rl:v1:otp:verify:ip',
          limit: Number(process.env.OTP_VERIFY_IP_RATE_LIMIT_LIMIT || 120),
          windowSeconds: Number(process.env.OTP_VERIFY_IP_RATE_LIMIT_WINDOW_SECONDS || 60),
          preferUid: false,
          bypassOnError: true,
          message: 'Trop de demandes. Veuillez réessayer plus tard.'
        })
      ]
    : []),
  asyncHandler(v1VerifyLoginOtp as any)
);
router.post(
  '/auth/visitor/phone/otp/verify',
  ...(endpointRlEnabled
    ? [
        rateLimitMiddleware({
          prefix: 'rl:v1:otp:visitor:verify:ip',
          limit: Number(process.env.OTP_VERIFY_IP_RATE_LIMIT_LIMIT || 120),
          windowSeconds: Number(process.env.OTP_VERIFY_IP_RATE_LIMIT_WINDOW_SECONDS || 60),
          preferUid: false,
          bypassOnError: true,
          message: 'Trop de demandes. Veuillez réessayer plus tard.'
        })
      ]
    : []),
  asyncHandler(v1VerifyVisitorOtp as any)
);

export default router;


