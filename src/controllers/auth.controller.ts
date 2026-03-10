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

// ── Password Reset (Supabase OTP) ──────────────────────────────────────────

const resetTokens = new Map<string, { email: string; expiresAt: number }>();

function cleanExpiredResetTokens() {
  const now = Date.now();
  for (const [token, data] of resetTokens) {
    if (data.expiresAt < now) resetTokens.delete(token);
  }
}

export async function forgotPassword(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) {
      res.status(400).json({ message: 'Email requis.' });
      return;
    }

    const { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) {
      console.error('[forgotPassword] Supabase error:', error.message);
      res.status(400).json({ message: error.message });
      return;
    }

    res.json({ ok: true });
  } catch (error: any) {
    console.error('[forgotPassword] Error:', error.message);
    res.status(500).json({ message: error.message });
  }
}

export async function verifyResetOtp(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const otp = String(req.body?.otp || '').trim();

    if (!email || !otp) {
      res.status(400).json({ message: 'Email et code OTP requis.' });
      return;
    }

    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token: otp,
      type: 'recovery',
    });

    if (error || !data.session) {
      res.status(401).json({ message: error?.message || 'Code invalide ou expiré.' });
      return;
    }

    cleanExpiredResetTokens();
    const resetToken = crypto.randomUUID();
    resetTokens.set(resetToken, {
      email,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    res.json({ ok: true, resetToken });
  } catch (error: any) {
    console.error('[verifyResetOtp] Error:', error.message);
    res.status(500).json({ message: error.message });
  }
}

export async function resetPassword(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const resetToken = String(req.body?.resetToken || '').trim();
    const newPassword = String(req.body?.newPassword || '');

    if (!resetToken || !newPassword) {
      res.status(400).json({ message: 'resetToken et newPassword requis.' });
      return;
    }

    if (newPassword.length < 6) {
      res.status(400).json({ message: 'Le mot de passe doit contenir au moins 6 caractères.' });
      return;
    }

    cleanExpiredResetTokens();
    const tokenData = resetTokens.get(resetToken);
    if (!tokenData) {
      res.status(401).json({ message: 'Token invalide ou expiré. Veuillez recommencer.' });
      return;
    }

    const email = tokenData.email;
    resetTokens.delete(resetToken);

    // 1) Update Supabase password
    const { data: listData } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const supabaseUser = listData?.users?.find(
      (u) => u.email?.toLowerCase() === email
    );

    if (supabaseUser) {
      const { error: updateError } = await supabase.auth.admin.updateUserById(
        supabaseUser.id,
        { password: newPassword }
      );
      if (updateError) {
        console.error('[resetPassword] Supabase update error:', updateError.message);
      }
    }

    // 2) Update Firebase password
    try {
      const firebaseUser = await getAuth().getUserByEmail(email);
      await getAuth().updateUser(firebaseUser.uid, { password: newPassword });
    } catch (fbErr: any) {
      console.warn('[resetPassword] Firebase update skipped:', fbErr.message);
    }

    res.json({ ok: true });
  } catch (error: any) {
    console.error('[resetPassword] Error:', error.message);
    res.status(500).json({ message: error.message });
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

