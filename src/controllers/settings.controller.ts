import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';
import { supabase } from '../services/supabase.service.js';
import {
  dualWriteToSupabase,
  resolveSupabaseClientId,
  dualWriteClient,
} from '../services/dualWrite.service.js';
import { supabaseFirstRead } from '../services/supabaseFirstRead.service.js';

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
    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) {
      res.json({ preferences: {} });
      return;
    }

    const { data, error } = await supabase
      .from('client_settings')
      .select('*')
      .eq('client_id', clientId)
      .maybeSingle();

    if (error) throw error;

    res.json({ preferences: data?.preferences ?? data ?? {} });
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

    const current = await supabaseFirstRead<Record<string, any>>(
      async () => {
        const clientId = await resolveSupabaseClientId(uid);
        if (!clientId) return null as any;
        const { data, error } = await supabase
          .from('client_settings')
          .select('*')
          .eq('client_id', clientId)
          .maybeSingle();
        if (error) throw error;
        return data?.preferences ?? data ?? {};
      },
      async () => {
        const doc = await prefsRef.get();
        return doc.exists ? (doc.data() ?? {}) : {};
      },
      `readPreferences(${uid})`
    );
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
