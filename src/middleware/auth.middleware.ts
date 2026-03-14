import { Request, Response, NextFunction } from 'express';
import { getAuth } from '../config/firebase.js';
import { supabase } from '../services/supabase.service.js';

export interface AuthenticatedRequest extends Request {
  uid?: string;
  user?: any;
  authProvider?: 'firebase' | 'supabase';
}

/**
 * Resolve a Supabase auth user ID to the Firebase UID used internally.
 * Falls back to the Supabase user ID if no mapping exists.
 */
async function resolveFirebaseUidFromSupabaseUser(supabaseUserId: string, email?: string): Promise<string | null> {
  const { data } = await supabase
    .from('clients')
    .select('firebase_uid')
    .eq('auth_user_id', supabaseUserId)
    .maybeSingle();

  if (data?.firebase_uid) return data.firebase_uid;

  if (email) {
    const { data: byEmail } = await supabase
      .from('clients')
      .select('firebase_uid')
      .eq('email', email.toLowerCase())
      .maybeSingle();
    if (byEmail?.firebase_uid) return byEmail.firebase_uid;
  }

  return null;
}

/**
 * Try verifying as Supabase JWT. Returns the Firebase UID if successful.
 */
async function trySupabaseAuth(token: string): Promise<{ uid: string; user: any } | null> {
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;

    const firebaseUid = await resolveFirebaseUidFromSupabaseUser(
      data.user.id,
      data.user.email ?? undefined
    );

    if (!firebaseUid) return null;

    return {
      uid: firebaseUid,
      user: {
        ...data.user,
        uid: firebaseUid,
        supabaseUserId: data.user.id,
        email: data.user.email,
        phone_number: data.user.phone,
        authProvider: 'supabase',
      },
    };
  } catch {
    return null;
  }
}

/**
 * Try verifying as Firebase ID token.
 */
async function tryFirebaseAuth(token: string): Promise<{ uid: string; user: any } | null> {
  try {
    const auth = getAuth();
    const decodedToken = await auth.verifyIdToken(token);
    return { uid: decodedToken.uid, user: { ...decodedToken, authProvider: 'firebase' } };
  } catch {
    return null;
  }
}

/**
 * Authenticate with Supabase JWT first, fallback to Firebase token.
 * Both token types are supported during the migration period.
 */
export async function authenticateToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ message: 'Vous devez être connecté.' });
      return;
    }

    const token = authHeader.split('Bearer ')[1];

    // Try Supabase first, then Firebase
    const supabaseResult = await trySupabaseAuth(token);
    if (supabaseResult) {
      req.uid = supabaseResult.uid;
      req.user = supabaseResult.user;
      req.authProvider = 'supabase';
      next();
      return;
    }

    const firebaseResult = await tryFirebaseAuth(token);
    if (firebaseResult) {
      req.uid = firebaseResult.uid;
      req.user = firebaseResult.user;
      req.authProvider = 'firebase';
      next();
      return;
    }

    res.status(401).json({ message: 'Vous devez être connecté.' });
  } catch (error: any) {
    console.error('Auth error:', error);
    res.status(401).json({ message: 'Vous devez être connecté.' });
  }
}

export async function optionalAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split('Bearer ')[1];

      const supabaseResult = await trySupabaseAuth(token);
      if (supabaseResult) {
        req.uid = supabaseResult.uid;
        req.user = supabaseResult.user;
        req.authProvider = 'supabase';
      } else {
        const firebaseResult = await tryFirebaseAuth(token);
        if (firebaseResult) {
          req.uid = firebaseResult.uid;
          req.user = firebaseResult.user;
          req.authProvider = 'firebase';
        }
      }
    }

    next();
  } catch (error) {
    next();
  }
}
