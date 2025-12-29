import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { sendLoginOtp, verifyLoginOtp, sendLinkPhoneOtp, verifyLinkPhoneOtp, verifyVisitorOtp } from '../services/phoneOtp.service.js';
import { getClientIp } from '../utils/errors.js';

export async function sendPhoneOtp(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = req.uid!;
  await sendLinkPhoneOtp({
    uid,
    phoneNumber: req.body?.phoneNumber,
    languageCode: req.body?.languageCode,
    channels: req.body?.channels,
    ipKey: getClientIp(req)
  });
  res.json({ ok: true });
}

export async function verifyPhoneOtpAndLink(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = req.uid!;
  const result = await verifyLinkPhoneOtp({
    uid,
    phoneNumber: req.body?.phoneNumber,
    code: req.body?.code ?? req.body?.otpCode, // compat legacy
    ipKey: getClientIp(req)
  });
  res.json(result);
}

export async function sendLoginPhoneOtp(req: AuthenticatedRequest, res: Response): Promise<void> {
  await sendLoginOtp({
    phoneNumber: req.body?.phoneNumber,
    languageCode: req.body?.languageCode,
    channels: req.body?.channels,
    ipKey: getClientIp(req)
  });
  res.json({ ok: true });
}

export async function verifyLoginPhoneOtp(req: AuthenticatedRequest, res: Response): Promise<void> {
  const result = await verifyLoginOtp({
    phoneNumber: req.body?.phoneNumber,
    code: req.body?.code ?? req.body?.otpCode, // compat legacy
    ipKey: getClientIp(req)
  });
  res.json({ customToken: result.customToken, isNewUser: result.isNewUser });
}

export async function createVisitorAccount(req: AuthenticatedRequest, res: Response): Promise<void> {
  // Endpoint legacy conservé: on mappe vers /v1/auth/visitor/phone/otp/verify
  const result = await verifyVisitorOtp({
    phoneNumber: req.body?.phoneNumber,
    code: req.body?.code ?? req.body?.otpCode,
    language: req.body?.language ?? req.body?.languageCode,
    ipKey: getClientIp(req)
  });
  res.json({ customToken: result.customToken, isNewUser: result.isNewUser });
}

export async function loginEmail(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { email, password } = req.body;

    // TODO: Vérifier credentials (si stockés dans Firestore ou Firebase Auth)
    // TODO: Générer customToken ou retourner token Firebase
    
    res.status(501).json({
      message: 'Not implemented - loginEmail',
      note: 'À implémenter selon stratégie auth email/password'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

