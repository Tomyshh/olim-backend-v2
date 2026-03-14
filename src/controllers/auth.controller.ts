import { Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { sendLoginOtp, verifyLoginOtp, sendLinkPhoneOtp, verifyLinkPhoneOtp, verifyVisitorOtp } from '../services/phoneOtp.service.js';
import { getClientIp } from '../utils/errors.js';
import { getAuth, getFirestore } from '../config/firebase.js';
import { supabase } from '../services/supabase.service.js';
import { readClientInfo } from '../services/supabaseFirstRead.service.js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey =
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ||
  '';
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
      // Dernier fallback: Firebase Auth par email.
      try {
        const user = await getAuth().getUserByEmail(email);
        firebaseUid = user.uid;
      } catch (_) {
        firebaseUid = null;
      }
    }

    // Vérifier si c'est un conseiller (CRM) → retourner les tokens Supabase directement
    // Les conseillers n'ont pas besoin de Firebase pour le CRM
    {
      let conseiller: any = null;
      const byId = await supabase.from('conseillers').select('id, name').eq('id', authData.user.id).maybeSingle();
      conseiller = byId.data;
      if (!conseiller) {
        const byEmail = await supabase.from('conseillers').select('id, name').eq('email', email).maybeSingle();
        conseiller = byEmail.data;
      }
      if (conseiller) {
        res.json({
          ok: true,
          provider: 'supabase',
          customToken: null,
          supabase: {
            access_token: authData.session?.access_token ?? null,
            refresh_token: authData.session?.refresh_token ?? null,
            expires_in: authData.session?.expires_in ?? null,
            token_type: 'bearer',
          },
        });
        return;
      }
    }

    if (!firebaseUid) {
      res.status(404).json({
        message: 'Compte Supabase trouvé mais mapping Firebase introuvable.',
        code: 'firebase_mapping_not_found',
      });
      return;
    }

    // Ensure clients row has firebase_uid and auth_user_id populated.
    // Handles cases where migration left these columns null.
    try {
      await supabase
        .from('clients')
        .update({
          firebase_uid: firebaseUid,
          auth_user_id: authData.user.id,
          updated_at: new Date().toISOString(),
        })
        .eq('email', email)
        .is('firebase_uid', null);
    } catch (_) { /* best-effort, don't block login */ }

    // Firebase custom token for backward compatibility
    const customToken = await getAuth().createCustomToken(firebaseUid, {
      authProvider: 'supabase',
    });

    res.json({
      ok: true,
      provider: 'supabase',
      customToken,
      // Supabase tokens for new Flutter clients
      supabase: {
        access_token: authData.session?.access_token ?? null,
        refresh_token: authData.session?.refresh_token ?? null,
        expires_in: authData.session?.expires_in ?? null,
        token_type: 'bearer',
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

/** Connexion via Google : idToken Google → Supabase signInWithIdToken → customToken Firebase + tokens Supabase */
export async function loginGoogle(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const idToken = String(req.body?.idToken ?? req.body?.id_token ?? '').trim();
    if (!idToken) {
      res.status(400).json({ message: 'idToken (Google) requis.' });
      return;
    }
    if (!supabaseAuthClient) {
      res.status(503).json({ message: 'Supabase auth non configuré.', code: 'supabase_auth_not_configured' });
      return;
    }

    const { data: authData, error: authError } = await supabaseAuthClient.auth.signInWithIdToken({
      provider: 'google',
      token: idToken,
    });
    if (authError || !authData.user) {
      res.status(401).json({ message: authError?.message ?? 'Connexion Google invalide.', code: 'supabase_id_token_failed' });
      return;
    }

    let firebaseUid: string | null = null;
    const authUserId = authData.user.id;
    const email = (authData.user.email ?? '').trim().toLowerCase();

    const byAuthUserId = await supabase.from('clients').select('firebase_uid').eq('auth_user_id', authUserId).maybeSingle();
    if (!byAuthUserId.error && (byAuthUserId.data as any)?.firebase_uid) {
      firebaseUid = (byAuthUserId.data as any).firebase_uid;
    }
    if (!firebaseUid && email) {
      const byEmail = await supabase.from('clients').select('firebase_uid').eq('email', email).maybeSingle();
      if (!byEmail.error && (byEmail.data as any)?.firebase_uid) {
        firebaseUid = (byEmail.data as any).firebase_uid;
      }
    }
    if (!firebaseUid) {
      try {
        const user = await getAuth().getUserByEmail(email || authData.user.email!);
        firebaseUid = user.uid;
      } catch (_) {
        firebaseUid = null;
      }
    }

    if (!firebaseUid) {
      res.status(404).json({
        message: 'Compte non trouvé. Inscrivez-vous d\'abord avec votre numéro ou email.',
        code: 'firebase_mapping_not_found',
      });
      return;
    }

    try {
      await supabase
        .from('clients')
        .update({ auth_user_id: authUserId, updated_at: new Date().toISOString() })
        .eq('firebase_uid', firebaseUid);
    } catch (_) { /* best-effort */ }

    const customToken = await getAuth().createCustomToken(firebaseUid, { authProvider: 'supabase_google' });
    res.json({
      ok: true,
      provider: 'supabase',
      customToken,
      supabase: {
        access_token: authData.session?.access_token ?? null,
        refresh_token: authData.session?.refresh_token ?? null,
        expires_in: authData.session?.expires_in ?? null,
        token_type: 'bearer',
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

/** Connexion via Apple : identityToken Apple → Supabase signInWithIdToken → customToken Firebase + tokens Supabase */
export async function loginApple(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const idToken = String(req.body?.idToken ?? req.body?.identity_token ?? '').trim();
    if (!idToken) {
      res.status(400).json({ message: 'idToken (Apple) requis.' });
      return;
    }
    if (!supabaseAuthClient) {
      res.status(503).json({ message: 'Supabase auth non configuré.', code: 'supabase_auth_not_configured' });
      return;
    }

    const options: { provider: 'apple'; token: string; nonce?: string } = { provider: 'apple', token: idToken };
    const rawNonce = req.body?.rawNonce ?? req.body?.raw_nonce;
    if (rawNonce && typeof rawNonce === 'string') options.nonce = rawNonce;

    const { data: authData, error: authError } = await supabaseAuthClient.auth.signInWithIdToken(options);
    if (authError || !authData.user) {
      res.status(401).json({ message: authError?.message ?? 'Connexion Apple invalide.', code: 'supabase_id_token_failed' });
      return;
    }

    let firebaseUid: string | null = null;
    const authUserId = authData.user.id;
    const email = (authData.user.email ?? '').trim().toLowerCase();

    const byAuthUserId = await supabase.from('clients').select('firebase_uid').eq('auth_user_id', authUserId).maybeSingle();
    if (!byAuthUserId.error && (byAuthUserId.data as any)?.firebase_uid) {
      firebaseUid = (byAuthUserId.data as any).firebase_uid;
    }
    if (!firebaseUid && email) {
      const byEmail = await supabase.from('clients').select('firebase_uid').eq('email', email).maybeSingle();
      if (!byEmail.error && (byEmail.data as any)?.firebase_uid) {
        firebaseUid = (byEmail.data as any).firebase_uid;
      }
    }
    if (!firebaseUid && email) {
      try {
        const user = await getAuth().getUserByEmail(email);
        firebaseUid = user.uid;
      } catch (_) {
        firebaseUid = null;
      }
    }

    if (!firebaseUid) {
      res.status(404).json({
        message: 'Compte non trouvé. Inscrivez-vous d\'abord avec votre numéro ou email.',
        code: 'firebase_mapping_not_found',
      });
      return;
    }

    try {
      await supabase
        .from('clients')
        .update({ auth_user_id: authUserId, updated_at: new Date().toISOString() })
        .eq('firebase_uid', firebaseUid);
    } catch (_) { /* best-effort */ }

    const customToken = await getAuth().createCustomToken(firebaseUid, { authProvider: 'supabase_apple' });
    res.json({
      ok: true,
      provider: 'supabase',
      customToken,
      supabase: {
        access_token: authData.session?.access_token ?? null,
        refresh_token: authData.session?.refresh_token ?? null,
        expires_in: authData.session?.expires_in ?? null,
        token_type: 'bearer',
      },
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

  const clientData = await readClientInfo(uid, async () => {
    const snap = await db.collection('Clients').doc(uid).get();
    return snap.exists ? (snap.data() as any) : null;
  });

  res.json({
    ok: true,
    uid,
    authProvider: req.authProvider ?? 'firebase',
    email: typeof decoded?.email === 'string' ? decoded.email : null,
    phoneNumber: typeof decoded?.phone_number === 'string' ? decoded.phone_number : null,
    authTime: typeof decoded?.auth_time === 'number' ? decoded.auth_time : null,
    issuedAt: typeof decoded?.iat === 'number' ? decoded.iat : null,
    expiresAt: typeof decoded?.exp === 'number' ? decoded.exp : null,
    clientExists: !!clientData,
    registrationComplete: clientData?.registrationComplete === true || clientData?.registration_complete === true,
  });
}

/**
 * POST /api/auth/refresh
 * Refresh a Supabase session using a refresh_token.
 */
export async function refreshToken(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const refreshTokenValue = String(req.body?.refresh_token || '').trim();
    if (!refreshTokenValue) {
      res.status(400).json({ message: 'refresh_token requis.' });
      return;
    }

    if (!supabaseAuthClient) {
      res.status(503).json({ message: 'Supabase auth non configuré.', code: 'supabase_auth_not_configured' });
      return;
    }

    const { data, error } = await supabaseAuthClient.auth.refreshSession({ refresh_token: refreshTokenValue });
    if (error || !data.session) {
      res.status(401).json({ message: error?.message || 'Refresh token invalide ou expiré.' });
      return;
    }

    res.json({
      ok: true,
      supabase: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in: data.session.expires_in,
        token_type: 'bearer',
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function logout(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = req.uid;
  if (!uid) {
    res.status(401).json({ message: 'Vous devez être connecté.', error: 'Vous devez être connecté.' });
    return;
  }

  try {
    const auth = getAuth();
    await auth.revokeRefreshTokens(uid);
  } catch {
    // Firebase revocation may fail if user is Supabase-only
  }

  res.json({ ok: true });
}

