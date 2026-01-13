import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth.middleware.js';
import { admin, getAuth, getFirestore } from '../../config/firebase.js';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidEmail(value: string): boolean {
  // Validation simple (suffisante pour rejet rapide avant Firebase)
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * POST /v1/admin/conseillers/password/by-email
 * Body: { email, newPassword }
 * Sécurité: authenticateToken + requireSuperAdmin (middleware)
 */
export async function v1AdminSetConseillerPasswordByEmail(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { email, newPassword } = (req.body || {}) as { email?: unknown; newPassword?: unknown };

  if (!isNonEmptyString(email) || !isValidEmail(email.trim())) {
    res.status(400).json({ message: 'email invalide' });
    return;
  }
  if (!isNonEmptyString(newPassword)) {
    res.status(400).json({ message: 'newPassword invalide' });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedPassword = newPassword.trim();
  if (normalizedPassword.length < 6) {
    res.status(400).json({ message: 'newPassword invalide (min 6 caractères)' });
    return;
  }

  const callerUid = req.uid;
  if (!callerUid) {
    // Normalement intercepté par authenticateToken
    res.status(401).json({ message: 'Vous devez être connecté.' });
    return;
  }

  const auth = getAuth();

  let targetUid: string;
  try {
    const user = await auth.getUserByEmail(normalizedEmail);
    targetUid = user.uid;
  } catch (error: any) {
    const code = String(error?.code || '');
    if (code === 'auth/user-not-found') {
      res.status(404).json({ message: 'Utilisateur Firebase introuvable' });
      return;
    }
    if (code === 'auth/invalid-email') {
      res.status(400).json({ message: 'email invalide' });
      return;
    }
    console.error('Admin reset password: getUserByEmail failed', { code, message: error?.message || String(error) });
    res.status(500).json({ message: 'internal' });
    return;
  }

  try {
    await auth.updateUser(targetUid, { password: normalizedPassword });
  } catch (error: any) {
    const code = String(error?.code || '');
    if (code === 'auth/invalid-password' || code === 'auth/argument-error') {
      res.status(400).json({ message: 'newPassword invalide (min 6 caractères)' });
      return;
    }
    console.error('Admin reset password: updateUser failed', { code, message: error?.message || String(error) });
    res.status(500).json({ message: 'internal' });
    return;
  }

  // Audit log recommandé
  try {
    const db = getFirestore();
    await db.collection('AdminAuditLogs').add({
      action: 'SET_CONSEILLER_PASSWORD',
      callerUid,
      targetUid,
      targetEmail: normalizedEmail,
      ip: req.ip || null,
      userAgent: req.get('user-agent') || null,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (error: any) {
    // Ne pas bloquer la réponse si l'audit log échoue
    console.error('Admin reset password: audit log failed', { message: error?.message || String(error) });
  }

  res.status(200).json({ success: true, uid: targetUid });
}


