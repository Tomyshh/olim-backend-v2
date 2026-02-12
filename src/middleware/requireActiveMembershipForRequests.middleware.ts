import type { NextFunction, Response } from 'express';
import { getFirestore } from '../config/firebase.js';
import type { AuthenticatedRequest } from './auth.middleware.js';

function normalizeMembership(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function isVisitorMembership(membership: string): boolean {
  const m = membership.trim().toLowerCase();
  return m === 'visitor' || m === 'visiteur';
}

/**
 * Bloque la création de demande si l'utilisateur n'est pas abonné (Visitor),
 * sauf si `Clients/{uid}.freeAccess.isEnabled === true` (exception admin/dev).
 *
 * Source-of-truth:
 * - abonnement: Clients/{uid}/subscription/current
 * - exception: Clients/{uid}.freeAccess
 *
 * Side-effect: stocke le membership retenu sur `req.requestMembership` (string)
 * pour éviter de faire confiance au payload.
 */
export async function requireActiveMembershipForRequests(
  req: AuthenticatedRequest & { requestMembership?: string },
  res: Response,
  next: NextFunction
): Promise<void> {
  const uid = String(req.uid || '').trim();
  if (!uid) {
    res.status(401).json({ message: 'Vous devez être connecté.' });
    return;
  }

  const db = getFirestore();
  const clientRef = db.collection('Clients').doc(uid);

  const [clientSnap, subSnap] = await Promise.all([
    clientRef.get(),
    clientRef.collection('subscription').doc('current').get()
  ]);

  const client = (clientSnap.data() || {}) as Record<string, any>;

  // Exception unique: freeAccess (prioritaire)
  const freeAccess = (client as any).freeAccess;
  const freeEnabled = freeAccess?.isEnabled === true;
  const freeMembership = normalizeMembership(freeAccess?.membership);
  if (freeEnabled && freeMembership) {
    req.requestMembership = freeMembership;
    next();
    return;
  }

  // Abonnement courant: subscription/current (source de vérité)
  const sub = (subSnap.data() || {}) as Record<string, any>;
  const membership = normalizeMembership(sub?.plan?.membership ?? sub?.membership);
  const isActive = sub?.states?.isActive === true;

  if (!membership || isVisitorMembership(membership) || !isActive) {
    res.status(403).json({
      message: "Vous ne pouvez pas envoyer de demande sans abonnement actif.",
      code: 'SUBSCRIPTION_REQUIRED'
    });
    return;
  }

  req.requestMembership = membership;
  next();
}

