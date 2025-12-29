import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.middleware.js';
import { getClientIp } from '../../utils/errors.js';
import { sendLoginOtp, verifyLoginOtp, verifyVisitorOtp, sendLinkPhoneOtp, verifyLinkPhoneOtp } from '../../services/phoneOtp.service.js';

export async function v1SendLoginOtp(req: AuthenticatedRequest, res: Response): Promise<void> {
  await sendLoginOtp({
    phoneNumber: req.body?.phoneNumber,
    languageCode: req.body?.languageCode,
    channels: req.body?.channels,
    ipKey: getClientIp(req)
  });
  res.json({ ok: true });
}

export async function v1VerifyLoginOtp(req: AuthenticatedRequest, res: Response): Promise<void> {
  const result = await verifyLoginOtp({
    phoneNumber: req.body?.phoneNumber,
    code: req.body?.code,
    ipKey: getClientIp(req)
  });
  res.json({ customToken: result.customToken, isNewUser: result.isNewUser });
}

export async function v1VerifyVisitorOtp(req: AuthenticatedRequest, res: Response): Promise<void> {
  const result = await verifyVisitorOtp({
    phoneNumber: req.body?.phoneNumber,
    code: req.body?.code,
    language: req.body?.language,
    ipKey: getClientIp(req)
  });
  res.json({ customToken: result.customToken, isNewUser: result.isNewUser });
}

export async function v1SendLinkPhoneOtp(req: AuthenticatedRequest, res: Response): Promise<void> {
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

export async function v1VerifyLinkPhoneOtp(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = req.uid!;
  const result = await verifyLinkPhoneOtp({
    uid,
    phoneNumber: req.body?.phoneNumber,
    code: req.body?.code,
    ipKey: getClientIp(req)
  });
  res.json(result);
}


