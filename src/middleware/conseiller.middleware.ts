import type { NextFunction, Response } from 'express';
import { getFirestore } from '../config/firebase.js';
import type { AuthenticatedRequest } from './auth.middleware.js';

/**
 * Autorise uniquement les conseillers : doc Firestore Conseillers2/{uid} existant.
 */
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

    const db = getFirestore();
    const snap = await db.collection('Conseillers2').doc(uid).get();
    if (!snap.exists) {
      res.status(403).json({ message: "Accès refusé : vous n'êtes pas conseiller.", error: "Accès refusé : vous n'êtes pas conseiller." });
      return;
    }

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Autorise uniquement les admins : doc Firestore Conseillers2/{uid}.isAdmin === true.
 * (Contrat attendu par la page Admin "Config".)
 */
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

    const db = getFirestore();
    const snap = await db.collection('Conseillers2').doc(uid).get();
    if (!snap.exists) {
      res.status(403).json({ message: "Accès refusé : vous n'êtes pas admin.", error: "Accès refusé : vous n'êtes pas admin." });
      return;
    }

    const data = snap.data() || {};
    if (data.isAdmin !== true) {
      res.status(403).json({ message: "Accès refusé : vous n'êtes pas admin.", error: "Accès refusé : vous n'êtes pas admin." });
      return;
    }

    next();
  } catch (err) {
    next(err);
  }
}


