import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from './auth.middleware.js';
import { supabase } from '../services/supabase.service.js';

async function getConseillerByFirebaseUid(uid: string) {
  const { data } = await supabase
    .from('conseillers')
    .select('*')
    .eq('firestore_id', uid)
    .single();
  return data;
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

    const data = await getConseillerByFirebaseUid(uid);
    if (!data) {
      res.status(403).json({ message: "Accès refusé : vous n'êtes pas conseiller.", error: "Accès refusé : vous n'êtes pas conseiller." });
      return;
    }

    (req as any).isAdmin = data.is_admin === true;
    (req as any).conseillerName = data.name || '';

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

    const data = await getConseillerByFirebaseUid(uid);
    if (!data) {
      res.status(403).json({ message: "Accès refusé : vous n'êtes pas admin.", error: "Accès refusé : vous n'êtes pas admin." });
      return;
    }

    if (data.is_admin !== true) {
      res.status(403).json({ message: "Accès refusé : vous n'êtes pas admin.", error: "Accès refusé : vous n'êtes pas admin." });
      return;
    }

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

    const data = await getConseillerByFirebaseUid(uid);
    if (!data) {
      res.status(403).json({ message: "Accès refusé : vous n'êtes pas superAdmin.", error: "Accès refusé : vous n'êtes pas superAdmin." });
      return;
    }

    const isSuperAdmin = data.is_super_admin === true || (data.metadata as any)?.superAdmin === true;
    if (!isSuperAdmin) {
      res.status(403).json({ message: "Accès refusé : vous n'êtes pas superAdmin.", error: "Accès refusé : vous n'êtes pas superAdmin." });
      return;
    }

    next();
  } catch (err) {
    next(err);
  }
}


