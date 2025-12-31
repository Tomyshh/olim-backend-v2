import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { sendLoginOtp, verifyLoginOtp, sendLinkPhoneOtp, verifyLinkPhoneOtp, verifyVisitorOtp } from '../services/phoneOtp.service.js';
import { getClientIp } from '../utils/errors.js';
import { getAuth, getFirestore } from '../config/firebase.js';

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

/**
 * GET /api/auth/session
 * Simple "login check" côté backend : le token est validé par authenticateToken,
 * on renvoie un état minimal de session.
 */
export async function getSession(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = req.uid;
  if (!uid) {
    res.status(401).json({ message: 'Vous devez être connecté.', error: 'Vous devez être connecté.' });
    return;
  }

  const decoded = req.user as any;
  const db = getFirestore();
  const clientSnap = await db.collection('Clients').doc(uid).get();
  const data = clientSnap.exists ? (clientSnap.data() as any) : null;

  res.json({
    ok: true,
    uid,
    email: typeof decoded?.email === 'string' ? decoded.email : null,
    phoneNumber: typeof decoded?.phone_number === 'string' ? decoded.phone_number : null,
    authTime: typeof decoded?.auth_time === 'number' ? decoded.auth_time : null,
    issuedAt: typeof decoded?.iat === 'number' ? decoded.iat : null,
    expiresAt: typeof decoded?.exp === 'number' ? decoded.exp : null,
    clientExists: clientSnap.exists,
    registrationComplete: data?.registrationComplete === true
  });
}

/**
 * POST /api/auth/logout
 *
 * Optionnel côté backend (le frontend fait déjà Firebase signOut).
 * Ici, on révoque les refresh tokens Firebase, ce qui invalide les futurs ID tokens
 * après rafraîchissement. L'ID token courant peut rester valide jusqu'à expiration.
 */
export async function logout(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = req.uid;
  if (!uid) {
    res.status(401).json({ message: 'Vous devez être connecté.', error: 'Vous devez être connecté.' });
    return;
  }

  const auth = getAuth();
  await auth.revokeRefreshTokens(uid);

  res.json({ ok: true });
}

