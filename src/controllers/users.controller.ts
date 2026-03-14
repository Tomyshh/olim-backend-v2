import type { Response } from 'express';
import { admin, getFirestore } from '../config/firebase.js';
import type { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { buildInitialSeniority } from '../services/clientSeniority.service.js';
import { dualWriteClient } from '../services/dualWrite.service.js';
import { ensureSupabaseAuthUser } from '../services/supabaseAuth.service.js';
import { readClientInfo } from '../services/supabaseFirstRead.service.js';

/**
 * POST /users/init
 *
 * Rôle backend dans le flow "Sign Up" :
 * - le frontend crée l'utilisateur dans Firebase Auth
 * - le frontend appelle /users/init avec l'ID Token (Bearer)
 * - on vérifie le token via authenticateToken (middleware)
 * - on s'assure qu'un doc Firestore Clients/{uid} existe (idempotent)
 */
export async function initUser(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = req.uid;
  if (!uid) {
    res.status(401).json({ message: 'Vous devez être connecté.', error: 'Vous devez être connecté.' });
    return;
  }

  const decoded = req.user as any;
  const email = typeof decoded?.email === 'string' ? decoded.email : undefined;
  const phoneNumber = typeof decoded?.phone_number === 'string' ? decoded.phone_number : undefined;

  const db = getFirestore();
  const clientRef = db.collection('Clients').doc(uid);

  const existing = await readClientInfo(uid, async () => {
    const doc = await clientRef.get();
    return doc.exists ? (doc.data() || {}) as Record<string, any> : null as any;
  });

  const clientExists = existing != null && typeof existing === 'object' && Object.keys(existing).length > 0;

  if (clientExists) {
    const hasCreatedAt = existing?.['Created At'] != null;
    const hasSeniority = existing?.seniority != null;
    // Non destructif : on met juste à jour des champs "safe" (merge)
    await clientRef.set(
      {
        ...(email ? { Email: email } : {}),
        ...(phoneNumber ? { 'Phone Number': phoneNumber } : {}),
        ...(!hasCreatedAt ? { 'Created At': admin.firestore.FieldValue.serverTimestamp() } : {}),
        ...(!hasSeniority ? { seniority: buildInitialSeniority() } : {}),
        lastLoginAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    const mergedData = { ...existing, ...(email ? { Email: email } : {}), ...(phoneNumber ? { 'Phone Number': phoneNumber } : {}) };
    (async () => {
      try {
        if (email) await ensureSupabaseAuthUser(email, { firebaseUid: uid });
        await dualWriteClient(uid, mergedData);
      } catch (e) { console.error('[initUser] dual-write failed:', e); }
    })();

    res.json({ ok: true, created: false, uid });
    return;
  }

  await clientRef.set(
    {
      uid,
      'Client ID': uid,
      ...(email ? { Email: email } : {}),
      ...(phoneNumber ? { 'Phone Number': phoneNumber } : {}),
      createdVia: 'firebaseAuth',
      // Champ demandé: ajouté à la création du client
      'Created At': admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      lastLoginAt: admin.firestore.FieldValue.serverTimestamp(),
      registrationComplete: false,
      seniority: buildInitialSeniority()
    },
    { merge: true }
  );

  (async () => {
    try {
      if (email) await ensureSupabaseAuthUser(email, { firebaseUid: uid });
      await dualWriteClient(uid, {
        Email: email, 'Phone Number': phoneNumber, createdVia: 'firebaseAuth',
        registrationComplete: false, seniority: buildInitialSeniority(), createdAt: new Date()
      });
    } catch (e) { console.error('[initUser] dual-write failed:', e); }
  })();

  res.status(201).json({ ok: true, created: true, uid });
}


