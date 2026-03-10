import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';
import {
  dualWriteToSupabase,
  resolveSupabaseClientId,
  dualWriteClient,
} from '../services/dualWrite.service.js';

function mapSettingsToSupabase(
  clientSupabaseId: string,
  preferences: Record<string, any>
): Record<string, any> {
  return {
    client_id: clientSupabaseId,
    preferences: preferences ?? {},
    updated_at: new Date().toISOString(),
  };
}

export async function getPreferences(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();

    const prefsDoc = await db
      .collection('Clients')
      .doc(uid)
      .collection('settings')
      .doc('preferences')
      .get();

    const data = prefsDoc.exists ? prefsDoc.data() ?? {} : {};
    res.json({ preferences: data });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function updatePreferences(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const updates = req.body;
    const db = getFirestore();

    const prefsRef = db
      .collection('Clients')
      .doc(uid)
      .collection('settings')
      .doc('preferences');

    const existing = await prefsRef.get();
    const current = existing.exists ? (existing.data() ?? {}) : {};
    const merged = { ...current, ...updates };

    await prefsRef.set(merged, { merge: true });

    resolveSupabaseClientId(uid).then((clientId) => {
      if (clientId) {
        dualWriteToSupabase(
          'client_settings',
          mapSettingsToSupabase(clientId, merged),
          { onConflict: 'client_id' }
        );
      }
    }).catch(() => {});

    res.json({ message: 'Preferences updated', preferences: merged });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function updateLanguage(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { language } = req.body;
    const db = getFirestore();

    await db.collection('Clients').doc(uid).update({ language });

    await db
      .collection('Clients')
      .doc(uid)
      .collection('settings')
      .doc('preferences')
      .set({ language }, { merge: true });

    dualWriteClient(uid, { language }).catch(() => {});

    res.json({ message: 'Language updated', language });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}
