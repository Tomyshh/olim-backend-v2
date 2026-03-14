import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from './auth.middleware.js';
import { supabase } from '../services/supabase.service.js';

/** Trouve le conseiller par uid : id (Supabase Auth), firestore_id (legacy), ou firebase_uid. */
async function getConseillerByUid(uid: string) {
  const byId = await supabase.from('conseillers').select('*').eq('id', uid).maybeSingle();
  if (byId.data) return byId.data;
  const byFirestoreId = await supabase.from('conseillers').select('*').eq('firestore_id', uid).maybeSingle();
  if (byFirestoreId.data) return byFirestoreId.data;
  const byFirebaseUid = await supabase.from('conseillers').select('*').eq('firebase_uid', uid).maybeSingle();
  return byFirebaseUid.data ?? null;
}

export async function requireConseiller(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const uid = req.uid;
    if (!uid) {
      res.status(401).json({ message: 'Vous devez être connecté.', error: 'Vous devez être connecté.' });
      return;
    }

    const data = await getConseillerByUid(uid);
    if (!data) {
      res.status(403).json({ message: "Accès refusé : vous n'êtes pas conseiller.", error: "Accès refusé : vous n'êtes pas conseiller." });
      return;
    }

    (req as any).isAdmin = data.is_admin === true;
    (req as any).conseillerName = data.name || '';
    (req as any).conseillerId = data.id;

    next();
  } catch (err) {
    next(err);
  }
}

export async function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const uid = req.uid;
    if (!uid) {
      res.status(401).json({ message: 'Vous devez être connecté.', error: 'Vous devez être connecté.' });
      return;
    }

    const data = await getConseillerByUid(uid);
    if (!data) {
      res.status(403).json({ message: "Accès refusé : vous n'êtes pas admin.", error: "Accès refusé : vous n'êtes pas admin." });
      return;
    }

    if (data.is_admin !== true) {
      res.status(403).json({ message: "Accès refusé : vous n'êtes pas admin.", error: "Accès refusé : vous n'êtes pas admin." });
      return;
    }

    (req as any).conseillerId = data.id;

    next();
  } catch (err) {
    next(err);
  }
}

export async function requireSuperAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const uid = req.uid;
    if (!uid) {
      res.status(401).json({ message: 'Vous devez être connecté.', error: 'Vous devez être connecté.' });
      return;
    }

    const data = await getConseillerByUid(uid);
    if (!data) {
      res.status(403).json({ message: "Accès refusé : vous n'êtes pas superAdmin.", error: "Accès refusé : vous n'êtes pas superAdmin." });
      return;
    }

    const isSuperAdmin = data.is_super_admin === true || (data.metadata as any)?.superAdmin === true;
    if (!isSuperAdmin) {
      res.status(403).json({ message: "Accès refusé : vous n'êtes pas superAdmin.", error: "Accès refusé : vous n'êtes pas superAdmin." });
      return;
    }

    (req as any).conseillerId = data.id;

    next();
  } catch (err) {
    next(err);
  }
}


