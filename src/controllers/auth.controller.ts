import { Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { sendLoginOtp, verifyLoginOtp, sendLinkPhoneOtp, verifyLinkPhoneOtp, verifyVisitorOtp } from '../services/phoneOtp.service.js';
import { getClientIp } from '../utils/errors.js';
import { getAuth, getFirestore } from '../config/firebase.js';
import { supabase } from '../services/supabase.service.js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const supabaseAuthClient =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;

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
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) {
      res.status(400).json({ message: 'email et password sont requis.' });
      return;
    }

    if (!supabaseAuthClient) {
      res.status(503).json({
        message: 'Supabase auth non configuré côté serveur.',
        code: 'supabase_auth_not_configured',
      });
      return;
    }

    // Stratégie demandée: Supabase d'abord.
    const { data: authData, error: authError } = await supabaseAuthClient.auth.signInWithPassword({
      email,
      password,
    });
    if (authError || !authData.user) {
      res.status(401).json({
        message: 'Identifiants invalides côté Supabase.',
        code: 'supabase_login_failed',
      });
      return;
    }

    // Mapping Supabase auth user -> firebase_uid pour rester compatible
    // avec le reste de l'app (token Firebase côté mobile + middleware backend).
    let firebaseUid: string | null = null;

    const byAuthUserId = await supabase
      .from('clients')
      .select('firebase_uid')
      .eq('auth_user_id', authData.user.id)
      .maybeSingle();
    if (!byAuthUserId.error) {
      firebaseUid = (byAuthUserId.data as any)?.firebase_uid ?? null;
    }

    if (!firebaseUid) {
      const byEmail = await supabase
        .from('clients')
        .select('firebase_uid')
        .eq('email', email)
        .maybeSingle();
      if (!byEmail.error) {
        firebaseUid = (byEmail.data as any)?.firebase_uid ?? null;
      }
    }

    if (!firebaseUid) {
      // Dernier fallback de mapping: Firebase Auth par email.
      try {
        const user = await getAuth().getUserByEmail(email);
        firebaseUid = user.uid;
      } catch (_) {
        firebaseUid = null;
      }
    }

    if (!firebaseUid) {
      res.status(404).json({
        message: 'Compte Supabase trouvé mais mapping Firebase introuvable.',
        code: 'firebase_mapping_not_found',
      });
      return;
    }

    const customToken = await getAuth().createCustomToken(firebaseUid, {
      authProvider: 'supabase',
    });

    res.json({
      ok: true,
      provider: 'supabase',
      customToken,
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

